import { describe, expect, it } from 'vitest';
import {
  applicationButtonsSchema,
  buttonColors,
  buttonSlotNames,
  buttonsForSlot,
  defaultButtons,
  effectiveButtons,
  projectButtonsSchema,
  pushButtonIcon,
  type ConfiguredButton
} from '../src/config/buttons.js';
import { sourceSchema, validateConfig } from '../src/config/schema.js';

const promptButton = (text: string, prompt = `prompt:${text}`): ConfiguredButton => ({ text, color: 'mauve', style: 'solid', action: { agentPrompt: prompt } });
const shellButton = (text: string, command = `printf '%s' ${text}`): ConfiguredButton => ({ text, color: 'blue', style: 'outline', action: { shellCommand: command } });

describe('configured button schema', () => {
  it('accepts both disjoint variants, all colors, both styles, and exact action bytes', () => {
    const command = '  printf "one"\nprintf "two"\n';
    const prompt = '  review this\n  exactly\n';
    const parsed = applicationButtonsSchema.parse({
      tabLead: buttonColors.map((color, index) => ({ text: `Button ${index}`, color, style: index % 2 === 0 ? 'outline' : 'solid', action: index === 0 ? { shellCommand: command } : { agentPrompt: prompt } })),
      pullRequest: [{ text: 'Push', icon: pushButtonIcon, color: 'mauve', style: 'solid', action: { agentPrompt: prompt } }]
    });
    expect(parsed.tabLead[0]!.action).toEqual({ shellCommand: command });
    expect(parsed.tabLead[1]!.action).toEqual({ agentPrompt: prompt });
    expect(parsed.pullRequest[0]!.icon).toBe(pushButtonIcon);
  });

  it.each([
    { shellCommand: 'echo x', agentPrompt: 'do x' },
    {},
    { shellCommand: 'echo x', extra: true },
    { agentPrompt: 'do x', extra: true }
  ])('rejects an ambiguous or invalid action %j', action => {
    expect(() => applicationButtonsSchema.parse({ tabLead: [{ ...shellButton('Run'), action }] })).toThrow();
  });

  it.each(['', '   ', `x\0y`, 'x'.repeat(32_001), '😀'.repeat(8_001)])('rejects invalid command or prompt bytes', value => {
    expect(() => applicationButtonsSchema.parse({ tabLead: [{ ...shellButton('Run'), action: { shellCommand: value } }] })).toThrow();
    expect(() => applicationButtonsSchema.parse({ tabLead: [{ ...promptButton('Ask'), action: { agentPrompt: value } }] })).toThrow();
  });

  it.each(['<path d="M0 0"/>', 'https://example.com/icon.svg', 'file:///tmp/icon.svg', 'M0 0\nL1 1', `M${'1'.repeat(4_096)}`])('rejects unsafe icon data', icon => {
    expect(() => applicationButtonsSchema.parse({ tabLead: [{ ...shellButton('Run'), icon }] })).toThrow();
  });

  it('rejects blank and duplicate normalized text while keeping case-sensitive identities', () => {
    expect(() => applicationButtonsSchema.parse({ tabLead: [shellButton(' ')] })).toThrow();
    expect(() => applicationButtonsSchema.parse({ tabLead: [shellButton('Ship'), promptButton(' Ship ')] })).toThrow(/duplicate button text/);
    expect(applicationButtonsSchema.parse({ tabLead: [shellButton('Ship'), promptButton('ship')] }).tabLead.map(button => button.text)).toEqual(['Ship', 'ship']);
  });

  it('enforces per-slot and strict shape bounds', () => {
    expect(applicationButtonsSchema.parse({ tabLead: Array.from({ length: 64 }, (_, index) => shellButton(`B${index}`)) }).tabLead).toHaveLength(64);
    expect(applicationButtonsSchema.parse({ tabLead: [{ ...shellButton('B'), text: 'x'.repeat(128), icon: `M${'1'.repeat(4_095)}`, action: { shellCommand: 'x'.repeat(32_000) } }] }).tabLead[0]!.text).toHaveLength(128);
    expect(() => applicationButtonsSchema.parse({ tabLead: Array.from({ length: 65 }, (_, index) => shellButton(`B${index}`)) })).toThrow();
    expect(() => applicationButtonsSchema.parse({ tabLead: [], unknown: [] })).toThrow();
    expect(() => applicationButtonsSchema.parse({ splits: { agent: [], unknown: [] } })).toThrow();
    expect(() => applicationButtonsSchema.parse({ tabLead: [{ ...shellButton('B'), text: 'x'.repeat(129) }] })).toThrow();
  });

  // include inherited copies while matching overrides keep one presentation
  it('enforces the global expanded-catalog bound', () => {
    const buttons = { tabLead: Array.from({ length: 64 }, (_, index) => shellButton(`B${index}`)), pullRequest: [] };
    const projects = Array.from({ length: 63 }, (_, index) => ({ id: `p${index}`, path: `/missing/${index}`, buttons: { tabLead: [promptButton('B0')] } }));
    expect(sourceSchema.safeParse({ publicOrigin: 'https://agents.example.com', buttons, projects }).success).toBe(true);
    projects.push({ id: 'overflow', path: '/missing/overflow', buttons: { tabLead: [] } });
    expect(sourceSchema.safeParse({ publicOrigin: 'https://agents.example.com', buttons, projects }).success).toBe(false);
  });

  // reject authored layouts that become oversized only after project inheritance
  it('rejects a maximum application layout inherited by many projects', () => {
    const list = (prefix: string) => Array.from({ length: 64 }, (_, index) => shellButton(`${prefix}-${index}`));
    const buttons = {
      tabLead: list('at'), leftNav: list('al'), rightNav: list('ar'), navMenu: list('an'), pullRequest: list('ap'),
      splits: { agent: list('sa'), terminal: list('st'), note: list('sn'), browser: list('sb'), files: list('sf'), code: list('sc'), review: list('sr'), stack: list('ss'), settings: list('sx') }
    };
    const projects = Array.from({ length: 100 }, (_, index) => ({ id: `p${index}`, path: `/missing/${index}` }));
    expect(sourceSchema.safeParse({ publicOrigin: 'https://agents.example.com', buttons, projects }).success).toBe(false);
  });

  it('materializes only application PR defaults', async () => {
    const parsed = applicationButtonsSchema.parse(undefined);
    expect(parsed).toEqual(defaultButtons);
    expect(parsed.pullRequest.map(button => button.text)).toEqual(['Commit/Push', '$fixup']);
    expect(buttonSlotNames.filter(slot => slot !== 'pullRequest').every(slot => buttonsForSlot(parsed, slot).length === 0)).toBe(true);
    const config = await validateConfig({ publicOrigin: 'https://agents.example.com' }, { checkExecutables: false });
    expect(config.buttons).toEqual(defaultButtons);
  });

  it('has empty GitHub panel slots beside the Pull request slot', () => {
    const parsed = applicationButtonsSchema.parse(undefined);
    expect(buttonSlotNames).toEqual(expect.arrayContaining(['pullRequest', 'reviewRequest', 'issue', 'split:github']));
    expect(parsed.reviewRequest).toEqual([]);
    expect(parsed.issue).toEqual([]);
    expect(parsed.splits.github).toEqual([]);
    const authored = applicationButtonsSchema.parse({ reviewRequest: [promptButton('$review')], issue: [promptButton('$plan')], splits: { github: [shellButton('gh')] } });
    expect(buttonsForSlot(authored, 'reviewRequest').map(button => button.text)).toEqual(['$review']);
    expect(buttonsForSlot(authored, 'issue').map(button => button.text)).toEqual(['$plan']);
    expect(buttonsForSlot(authored, 'split:github').map(button => button.text)).toEqual(['gh']);
  });
});

describe('project button merging', () => {
  it('replaces matching text in place and appends unmatched entries', () => {
    const application = applicationButtonsSchema.parse({ tabLead: [shellButton('A'), shellButton('B')] });
    const project = projectButtonsSchema.parse({ tabLead: [promptButton('B', 'replacement'), promptButton('C')] });
    const effective = effectiveButtons(application, project);
    expect(effective.tabLead.map(button => button.text)).toEqual(['A', 'B', 'C']);
    expect(effective.tabLead[1]!.action).toEqual({ agentPrompt: 'replacement' });
  });

  it('treats empty project lists as inheritance and keeps slots independent', () => {
    const application = applicationButtonsSchema.parse({ tabLead: [shellButton('A')], splits: { files: [shellButton('Files')] } });
    const effective = effectiveButtons(application, { tabLead: [], splits: { files: [promptButton('Files', 'replace')] } });
    expect(effective.tabLead).toEqual(application.tabLead);
    expect(effective.splits.files[0]!.action).toEqual({ agentPrompt: 'replace' });
    expect(application.splits.files[0]!.action).toEqual({ shellCommand: "printf '%s' Files" });
  });

  it('merges a Project\'s GitHub panel buttons over the application\'s', () => {
    const application = applicationButtonsSchema.parse({ reviewRequest: [promptButton('$review')] });
    const project = projectButtonsSchema.parse({ reviewRequest: [promptButton('$review', 'project review')], issue: [promptButton('$plan')], splits: { github: [shellButton('gh')] } });
    const effective = effectiveButtons(application, project);
    expect(effective.reviewRequest.map(button => button.action)).toEqual([{ agentPrompt: 'project review' }]);
    expect(effective.issue.map(button => button.text)).toEqual(['$plan']);
    expect(effective.splits.github.map(button => button.text)).toEqual(['gh']);
  });
});
