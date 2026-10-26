import { describe, expect, it } from 'vitest';
import { calendarLabelsForAgent } from '../src/google-calendar/labels.js';
import { testProject, testWorktree } from './helpers/config.js';
import { agentKinds, type AgentKind } from '../src/adapters/types.js';
import { calendarAgentLabel } from '../src/google-calendar/agent-labels.js';
import { renderCalendarTitle } from '../src/google-calendar/title.js';

// map raw pane snapshots rather than relying on dashboard-only enrichment
describe('Google Calendar labels', () => {
  const expected: Record<AgentKind, string> = { codex: 'Codex', omx: 'OMX', claude: 'Claude', pi: 'Pi', opencode: 'OpenCode' };
  // preserve every adapter's public identity through discovery and title rendering
  it.each(agentKinds)('uses the same safe %s label throughout the calendar domain', kind => {
    const labels = calendarLabelsForAgent({ kind, home: '/private/path' }, [], []);
    expect(labels.agent).toBe(expected[kind]);
    expect(calendarAgentLabel(kind)).toBe(expected[kind]);
    expect(renderCalendarTitle('{agent}', labels)).toBe(expected[kind]);
  });
  // never turn an unknown kind or object-prototype name into outbound content
  it.each(['unknown', 'constructor', '__proto__'])('uses the generic fallback for %s', kind => {
    expect(calendarAgentLabel(kind)).toBe('Agent');
    expect(renderCalendarTitle('{agent}', { worktree: 'Cora', agent: kind })).toBe('Agent');
  });
  // recover configured labels even when target snapshots have no worktree id
  it('resolves raw and bridged worktree agents and honors fresh labels', () => {
    const project = testProject({ id: 'console', label: 'Console' });
    const worktree = testWorktree({ id: 'console:feature', projectId: 'console', label: 'Feature', identity: '/worktrees/feature', hostPath: '/host/feature' });
    expect(calendarLabelsForAgent({ kind: 'codex', home: '/worktrees/feature' }, [worktree], [project])).toEqual({ worktree: 'Feature', project: 'Console', agent: 'Codex' });
    expect(calendarLabelsForAgent({ kind: 'claude', home: '/host/feature' }, [{ ...worktree, label: 'Renamed' }], [project]).worktree).toBe('Renamed');
    expect(calendarLabelsForAgent({ kind: 'omx', home: '/private/elsewhere', placeId: worktree.id }, [worktree], [project]).worktree).toBe('Feature');
  });
  // accept discovery's readonly project view including implicitly discovered repositories
  it('uses safe display metadata from a readonly implicit project list', () => {
    const projects = Object.freeze([testProject({ id: 'implicit', label: 'Discovered project', implicit: true })]);
    const worktree = testWorktree({ id: 'implicit:main', projectId: 'implicit', label: 'Main workspace' });
    expect(calendarLabelsForAgent({ kind: 'omx', home: '/private/root', placeId: worktree.id }, [worktree], projects)).toEqual({ worktree: 'Main workspace', project: 'Discovered project', agent: 'OMX' });
  });
  // do not convert an unknown path or generated title into outbound data
  it('uses safe Scratch and directory-project fallbacks', () => {
    expect(calendarLabelsForAgent({ kind: 'codex', home: '/private/sensitive-folder' }, [], [])).toEqual({ worktree: 'Scratch', project: 'Scratch', agent: 'Codex' });
    const project = testProject({ id: 'notes', label: 'Notes', mode: 'directory', identity: '/notes' });
    expect(calendarLabelsForAgent({ kind: 'claude', home: '/notes' }, [], [project])).toEqual({ worktree: 'Notes', project: 'Notes', agent: 'Claude' });
  });
});
