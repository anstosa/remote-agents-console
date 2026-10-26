import { describe, expect, it } from 'vitest';
import { renderCalendarTitle, validateTitleTemplate } from '../src/google-calendar/title.js';

// exercise the same safe grammar used by preview and event creation
describe('Google Calendar titles', () => {
  // keep escapes and metadata literal rather than executable
  it('renders documented fields and literal braces', () => {
    expect(renderCalendarTitle('{{RAC}} {project}: {worktree} ({agent})', { project: 'Console', worktree: 'Feature', agent: 'Codex' })).toBe('{RAC} Console: Feature (Codex)');
  });
  // reject unknown content-bearing or malformed placeholders
  it.each(['', ' ', '{prompt}', '{response}', '{path}', '{worktree', 'worktree}', '{WORKTREE}', '{agent.name}', '\0', 'line\nbreak', 'x'.repeat(161)])('rejects invalid authored titles %j', template => {
    expect(validateTitleTemplate(template)).toBeTypeOf('string');
  });
  // never use arbitrary pane or conversation titles for the agent field
  it('keeps the agent field on the closed product vocabulary', () => {
    expect(renderCalendarTitle('{agent} {worktree}', { worktree: 'Safe\nName', agent: 'secret prompt body' })).toBe('Agent Safe Name');
  });
  // bound rendered values independently of authored length
  it('caps expanded output by Unicode scalars', () => {
    const title = renderCalendarTitle('{worktree}{worktree}{worktree}{worktree}', { worktree: '😀'.repeat(100), agent: 'Claude' });
    expect(Array.from(title)).toHaveLength(240);
    expect(title.endsWith('…')).toBe(true);
    expect(validateTitleTemplate('😀'.repeat(160))).toBeUndefined();
    expect(validateTitleTemplate('\ud800')).toBeTypeOf('string');
  });
});
