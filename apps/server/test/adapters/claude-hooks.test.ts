import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { claudeFiles, claudeHooksJson, claudeHooksSettings, claudeStructuredSettings } from '../../src/adapters/claude-hooks.js';
import { claudeHookNonce } from '../../src/adapters/claude-conversations.js';

const golden = readFileSync(fileURLToPath(new URL('../fixtures/claude/hooks.json', import.meta.url)), 'utf8');

describe('claude hooks settings', () => {
  it('renders the pinned golden hooks.json for a known context', () => {
    expect(claudeHooksJson({ repoRoot: '/srv/remoteagents', tmuxBin: '/usr/bin/tmux' })).toBe(golden);
  });

  it('exposes the settings file through the files map', () => {
    expect(claudeFiles({ repoRoot: '/srv/remoteagents', tmuxBin: '/usr/bin/tmux' })).toEqual({ 'hooks.json': golden });
  });

  it('bakes RAC_TMUX_BIN only when a tmux binary is configured (never under the bridge)', () => {
    const baked = claudeHooksSettings({ repoRoot: '/repo', tmuxBin: '/opt/tmux' });
    expect(baked.hooks.UserPromptSubmit[0]!.hooks[0]!.command).toBe('RAC_TMUX_BIN=/opt/tmux RAC_CALENDAR_LIFECYCLE_SPOOL=/repo/.data/google-calendar-claude-lifecycle.jsonl /repo/scripts/hooks/rac-attention working --lifecycle start');
    const bridged = claudeHooksSettings({ repoRoot: '/host/repo' });
    expect(bridged.hooks.UserPromptSubmit[0]!.hooks[0]!.command).toBe('RAC_CALENDAR_LIFECYCLE_SPOOL=/host/repo/.data/google-calendar-claude-lifecycle.jsonl /host/repo/scripts/hooks/rac-attention working --lifecycle start');
  });

  it('maps every ADR 0001 event to its Attention state and reports nothing on SessionEnd', () => {
    const { hooks } = claudeHooksSettings({ repoRoot: '/repo', tmuxBin: '/usr/bin/tmux' });
    const state = (entry: { hooks: { command: string }[] }) => entry.hooks[0]!.command.split(' ').pop();
    expect(state(hooks.SessionStart[0]!)).toBe('finished');
    expect(hooks.UserPromptSubmit[0]!.hooks[0]!.command).toContain('working --lifecycle start');
    // AskUserQuestion carries its payload; ExitPlanMode only reports the state (ADR 0006)
    expect(hooks.PreToolUse.map(entry => [entry.matcher, entry.hooks[0]!.command.includes('question --payload'), entry.hooks[0]!.command.includes('--lifecycle question')])).toEqual([
      ['AskUserQuestion', true, true],
      ['ExitPlanMode', false, false],
    ]);
    expect(state(hooks.Elicitation[0]!)).toBe('question');
    expect(state(hooks.PermissionRequest[0]!)).toBe('question');
    // tool-driven working reports also fire inside a background subagent, so they are main-only
    expect(hooks.PostToolUse[0]!.hooks[0]!.command).toMatch(/ working --main-only$/u);
    expect(hooks.PermissionDenied[0]!.hooks[0]!.command).toMatch(/ working --main-only$/u);
    expect(hooks.ElicitationResult[0]!.hooks[0]!.command).toMatch(/ working --main-only$/u);
    expect(hooks.Stop[0]!.hooks[0]!.command).toContain('finished --lifecycle terminal');
    expect(hooks.StopFailure[0]!.hooks[0]!.command).toContain('finished --lifecycle terminal');
    // Notification splits on notification_type: the prompt is a question, going idle is finished
    expect(hooks.Notification.map(entry => [entry.matcher, state(entry)])).toEqual([
      ['permission_prompt', 'question'],
      ['idle_prompt', 'finished'],
    ]);
    expect(hooks.SessionEnd).toBeUndefined();
    // every handler is a synchronous command with a 5s budget
    for (const entries of Object.values(hooks)) for (const entry of entries) for (const handler of entry.hooks) {
      expect(handler.type).toBe('command');
      expect(handler.timeout).toBe(5);
    }
  });
});

describe('structured Claude settings', () => {
  it('only echoes the launch nonce at SessionStart, as JSON the Claude client reads, reporting nothing into tmux', () => {
    const settings = JSON.parse(claudeStructuredSettings) as { hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; timeout: number; command: string }> }>> };
    expect(Object.keys(settings.hooks)).toEqual(['SessionStart']);
    const [handler] = settings.hooks.SessionStart![0]!.hooks;
    expect(handler).toMatchObject({ type: 'command', timeout: 5 });
    expect(claudeStructuredSettings).not.toContain('rac-attention');
    // run as Claude runs a hook: by the shell, with the launch's environment
    const stdout = execFileSync('/bin/sh', ['-c', handler!.command], { env: { ...process.env, RAC_LAUNCH_NONCE: 'n0nce_-AZ' }, encoding: 'utf8' });
    expect(JSON.parse(stdout)).toEqual({ suppressOutput: true, rac: 'n0nce_-AZ' });
    expect(claudeHookNonce(stdout)).toBe('n0nce_-AZ');
  });

  it('lets the structured Claude ask through ask_user without a permission prompt, and never through AskUserQuestion', () => {
    expect(JSON.parse(claudeStructuredSettings).permissions).toEqual({ allow: ['mcp__rac__ask_user'], deny: ['AskUserQuestion'] });
  });
});
