import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { claudeAdapter } from '../../src/adapters/claude.js';
import { inlineQuestionId } from '../../src/adapters/inline-questions.js';
import type { Adapter } from '../../src/adapters/types.js';

const { lines } = JSON.parse(readFileSync(new URL('../fixtures/claude/folder-trust.json', import.meta.url), 'utf8')) as { lines: string[] };
const capture = lines.join('\n');
const questions: NonNullable<Adapter['questions']> = claudeAdapter.questions;
const text = 'Do you trust /workspaces/example?';
const choices = ['No, exit', 'Yes, I trust this folder'];
const detail = "Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what's in this folder first. Claude Code'll be able to read, edit, and execute files here.";

// expose only a complete live trust dialog with its exact folder and native choice order
describe('Claude folder trust', () => {
  // startup trust has no ask-user hook payload or numbered choices
  it('parses the unnumbered folder permission dialog', () => {
    expect(questions.parse?.(capture)).toEqual({ id: inlineQuestionId(text, choices), text, detail, choices, permission: true, source: 'parsed', pane: { selectedIndex: 0 } });
  });

  // earlier native versions omit the informational link without changing the consent scope
  it('supports the same warning without the security-guide link', () => {
    expect(questions.parse?.(capture.replace('Security guide\n', ''))).toMatchObject({ text, detail, choices, permission: true });
  });

  // terminal wrapping and ansi styling must not truncate the safety warning
  it('preserves wrapped warnings and the live affirmative highlight', () => {
    const narrow = capture.replace('Is this a project you created or one you trust?', 'Is this a project you\ncreated or one you trust?')
      .replace('read, edit, and execute', 'read, edit,\nand execute').replace('❯ No, exit', '  No, exit').replace('  Yes, I trust', '❯ Yes, I trust')
      .replace('Security guide', '\x1b]8;;https://example.invalid/security\x07Security guide\x1b]8;;\x07')
      .replace('/workspaces/example', '\x1b[1m/workspaces/example\x1b[0m');
    expect(questions.parse?.(narrow)).toEqual({ id: inlineQuestionId(text, choices), text, detail, choices, permission: true, source: 'parsed', pane: { selectedIndex: 1 } });
  });

  // restricted mode keeps the native refusal semantics instead of inventing an exit
  it('supports a wrapped continue-without-permissions refusal', () => {
    const restricted = capture.replace('No, exit', 'No, continue without these\n    permissions');
    expect(questions.parse?.(restricted)).toMatchObject({ choices: ['No, continue without these permissions', choices[1]], permission: true, pane: { selectedIndex: 0 } });
  });

  // consent to one folder must not authorize another folder with the same buttons
  it('binds question identity to the displayed folder', () => {
    const changedText = 'Do you trust /workspaces/other?';
    expect(questions.parse?.(capture.replace('/workspaces/example', '/workspaces/other'))).toMatchObject({ text: changedText, id: inlineQuestionId(changedText, choices) });
  });

  // literal path punctuation must not collapse into another folder's identity
  it('retains punctuation in the displayed folder and question id', () => {
    const changedText = 'Do you trust /workspaces/pipe|folder?';
    expect(questions.parse?.(capture.replace('/workspaces/example', '/workspaces/pipe|folder'))).toMatchObject({ text: changedText, id: inlineQuestionId(changedText, choices) });
  });

  // shortened native displays cannot identify the folder being authorized
  it.each(['/workspaces/ex…mple', '/workspaces/.../example'])('keeps shortened folder %s terminal-only and startup-blocked', folder => {
    const shortened = capture.replace('/workspaces/example', folder);
    expect(questions.parse?.(shortened)).toBeUndefined();
    expect(claudeAdapter.newConversation.ready({ title: 'Claude Code', attention: 'finished' }, shortened)).toEqual({ state: 'blocked', reason: 'untrusted directory: safety check' });
  });

  // missing native boundaries or ambiguous cursors cannot become actionable permissions
  it.each([
    capture.replace('Accessing workspace:', 'Earlier workspace:'),
    capture.replace('Security guide', 'Security guide and grant all access'),
    capture.replace('Security guide', 'Security guide\nSecurity guide'),
    capture.replace('/workspaces/example', ''),
    capture.replace('/workspaces/example', 'relative/folder'),
    capture.replace('Quick safety check:', 'Earlier safety check:'),
    capture.replace("Claude Code'll be able to read, edit, and execute files here.", ''),
    capture.replace('read, edit, and execute files here', 'read, edit, and execute files anywhere'),
    capture.replace('If not, take a moment to review what\'s in this folder first.', ''),
    capture.replace('Yes, I trust this folder', 'Yes, do something else'),
    capture.replace('No, exit', 'No, something else'),
    capture.replace('❯ No, exit', '  No, exit'),
    capture.replace('  Yes, I trust', '❯ Yes, I trust'),
    capture.replace('Enter to confirm · Esc to cancel', 'Enter to do something else'),
    `${capture}\nClaude is ready\n❯ `
  ])('rejects an incomplete or stale trust dialog %#', value => {
    expect(questions.parse?.(value)).toBeUndefined();
  });
});
