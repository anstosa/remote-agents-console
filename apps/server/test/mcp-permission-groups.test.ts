import { describe, expect, it } from 'vitest';
import { mcpPermissionGroups } from '../src/integrations/mcp/permission-groups.js';
import { mcpPermissionCapabilities, mcpToolPermitted } from '../src/integrations/mcp/permissions.js';

describe('MCP permission groups', () => {
  // require every canonical tool to be assigned once in its supported lane
  it('covers the canonical surface exactly once with matching lanes', () => {
    const canonical = new Map(mcpPermissionCapabilities.map(capability => [capability.name, capability]));
    const groupNames = mcpPermissionGroups.map(group => group.name);
    const memberships = mcpPermissionGroups.flatMap(group => [
      ...group.read.map(name => ({ name, mode: 'read' as const })),
      ...group.write.map(name => ({ name, mode: 'write' as const }))
    ]);
    const memberNames = memberships.map(membership => membership.name);

    expect(mcpPermissionGroups).toHaveLength(12);
    expect(groupNames).toEqual(['notes', 'files', 'agents', 'conversations', 'worktrees', 'stack', 'reviews', 'github', 'actions', 'watches', 'workspace', 'davo']);
    expect(new Set(groupNames).size).toBe(groupNames.length);
    expect(memberships.filter(membership => membership.mode === 'read')).toHaveLength(56);
    expect(memberships.filter(membership => membership.mode === 'write')).toHaveLength(79);
    expect(memberships).toHaveLength(135);
    expect(new Set(memberNames).size).toBe(memberNames.length);
    expect(new Set(memberNames)).toEqual(new Set(canonical.keys()));
    // reject misplaced tools as well as missing future tools
    for (const membership of memberships) expect(canonical.get(membership.name)?.mode).toBe(membership.mode);
  });

  // keep the user-facing Notes controls aligned with note operations
  it('groups note listing and contents under Read and note changes under Write', () => {
    const notes = mcpPermissionGroups.find(group => group.name === 'notes');

    expect(notes?.read).toEqual(['get_note', 'list_note_attachments', 'list_notes', 'list_schedule_targets', 'preview_note_schedule']);
    expect(notes?.write).toEqual([
      'add_note_attachment',
      'create_note',
      'delete_note',
      'delete_note_with_undo',
      'remove_note_attachment',
      'remove_note_schedule',
      'run_note_now',
      'schedule_note',
      'set_note_lock',
      'set_note_schedule',
      'set_note_visibility',
      'undo_note_delete',
      'update_note'
    ]);
  });

  // prevent a group checkbox from mixing enabled and disabled baseline tools
  it('keeps every supported lane on one baseline default', () => {
    const canonical = new Map(mcpPermissionCapabilities.map(capability => [capability.name, capability]));

    expect(mcpPermissionGroups.find(group => group.name === 'workspace')?.write).toEqual([]);
    expect(mcpPermissionGroups.find(group => group.name === 'davo')?.read).toEqual([]);

    // inspect each displayed group lane independently
    for (const group of mcpPermissionGroups) {
      // empty lanes remain unsupported rather than gaining placeholder members
      for (const [mode, names] of [['read', group.read], ['write', group.write]] as const) {
        // skip unsupported empty lanes
        if (names.length === 0) continue;
        const defaults = names.map(name => canonical.get(name)?.defaultEnabled);
        const expected = group.name === 'davo' && mode === 'write' ? false : true;
        expect(new Set(defaults)).toEqual(new Set([expected]));
      }
    }
  });

  // grouping must not change the underlying per-tool authorization contract
  it('leaves sparse per-tool flags and fail-closed lanes unchanged', () => {
    expect(mcpToolPermitted(undefined, 'list_notes', 'read')).toBe(true);
    expect(mcpToolPermitted({ list_notes: { read: false } }, 'list_notes', 'read')).toBe(false);
    expect(mcpToolPermitted(undefined, 'delegate_request', 'write')).toBe(false);
    expect(mcpToolPermitted({ delegate_request: { write: true } }, 'delegate_request', 'write')).toBe(true);
    expect(mcpToolPermitted({ get_note: { write: true } }, 'get_note', 'write')).toBe(false);
    expect(mcpToolPermitted(undefined, 'future_tool', 'read')).toBe(false);
  });
});

// retain explicit line boundaries for the two operation descriptions
it('separates supported read and write descriptions onto distinct lines', () => {
  // single-operation capabilities have no second description
  for (const group of mcpPermissionGroups) {
    // require a line boundary only when both operations exist
    if (group.read.length === 0 || group.write.length === 0) continue;
    expect(group.description).toMatch(/^Read [^\n]+\nWrite /u);
  }
});
