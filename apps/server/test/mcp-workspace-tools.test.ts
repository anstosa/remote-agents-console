import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConsoleEvents } from '../src/events.js';
import type { HostFileIdentity, HostFilesBackend } from '../src/host-files/contracts.js';
import { createHostFilesEngine } from '../src/host-files/engine.js';
import { HostFilesService } from '../src/host-files/service.js';
import { HostFilesTokenService } from '../src/host-files/tokens.js';
import { createWorkspaceTools, type WorkspaceToolsDependencies } from '../src/integrations/mcp/workspace-tools.js';
import { Watches } from '../src/watches/service.js';

const directories: string[] = [];

// clean every isolated Watch store
afterEach(async () => {
  await Promise.all(directories.splice(0).map(async directory => await rm(directory, { recursive: true, force: true })));
});

describe('workspace MCP contracts', () => {
  // freeze the audience-specific inventory and high-risk annotations
  it('publishes exact workspace projections without permissive output objects', () => {
    const tools = createWorkspaceTools({ now: () => 1_000 } as unknown as WorkspaceToolsDependencies);
    const names = new Set(tools.map(tool => tool.name));
    expect(names).toEqual(expect.objectContaining(new Set([
      'list_agent_destinations', 'assess_branch_removal', 'prepare_branch_removal', 'execute_branch_removal',
      'reply_github_thread', 'resolve_github_thread', 'create_pull_request', 'get_files_capabilities',
      'prepare_file_operation', 'prepare_confirmed_file_operation', 'execute_file_operation', 'upload_file_chunk',
      'get_note', 'list_notes', 'create_note', 'set_note_schedule', 'list_configured_actions',
      'resolve_configured_action', 'invoke_configured_action', 'watch_pull_request', 'get_watch_events', 'ack_watch_events'
    ])));
    expect(names.has('watch_command')).toBe(false);
    const invoke = tools.filter(tool => tool.name === 'invoke_configured_action');
    expect(invoke).toHaveLength(2);
    expect(invoke.find(tool => tool.audiences.includes('conductor'))?.requiredScopes).toEqual(['prompts:write']);
    expect(invoke.find(tool => tool.audiences.includes('realtime'))?.requiredScopes).toEqual(['actions:invoke']);
    expect(tools.find(tool => tool.name === 'prepare_confirmed_file_operation')?.annotations.destructiveHint).toBe(false);
    expect(tools.find(tool => tool.name === 'upload_file_chunk')?.annotations).toMatchObject({ destructiveHint: false, idempotentHint: true });
    expect(tools.find(tool => tool.name === 'ack_watch_events')?.annotations).toMatchObject({ destructiveHint: true, idempotentHint: true });
    expect(tools.find(tool => tool.name === 'reply_github_thread')?.annotations).toMatchObject({ destructiveHint: false, openWorldHint: true });
    // every result arm remains a closed object
    for (const tool of tools) {
      const schema = tool.outputSchema as { oneOf?: Array<{ additionalProperties?: boolean; properties?: { data?: { additionalProperties?: boolean } } }> };
      expect(schema.oneOf?.every(arm => arm.additionalProperties === false)).toBe(true);
      expect(schema.oneOf?.[0]?.properties?.data?.additionalProperties).not.toBe(true);
    }
  });

  // preserve stable-owner recovery while exact leases protect active streams
  it('binds Host Files capabilities to first-class namespaces and optional leases', () => {
    const identity: HostFileIdentity = { dev: '1', ino: '2', ctimeNs: '3', mtimeNs: '4', size: '5', nlink: '1', kind: 'file' };
    const tokens = new HostFilesTokenService('workspace-owner-test-secret', () => 'generation', () => 1_000);
    const owner = { namespace: 'davo' as const, principalOwnerKey: 'owner-a', leaseKey: 'lease-a' };
    const token = tokens.issue({ purpose: 'object', owner, placeId: 'place-a', path: '/file', identity });
    expect(tokens.verify(token, { purpose: 'object', owner: { ...owner, leaseKey: 'lease-b' } })).toBeDefined();
    expect(tokens.verify(token, { purpose: 'object', owner: { ...owner, leaseKey: 'lease-b' }, leaseBound: true })).toBeUndefined();
    expect(tokens.verify(token, { purpose: 'object', owner: { namespace: 'conductor', principalOwnerKey: 'owner-a' } })).toBeUndefined();
    const conductor = { namespace: 'conductor' as const, principalOwnerKey: 'agent-a' };
    const conductorToken = tokens.issue({ purpose: 'object', owner: conductor, placeId: 'place-a', path: '/file', identity });
    expect(tokens.verify(conductorToken, { purpose: 'object', owner: conductor, leaseBound: true })).toBeDefined();
  });

  // rethrow unknown domain failures so the gateway can sanitize side-effect uncertainty
  it('does not serialize unknown post-effect failures into tool output', async () => {
    let changed = false;
    const tools = createWorkspaceTools({
      now: () => 1_000,
      github: {
        // simulate a provider failure after an external write
        replyToThread: async () => { changed = true; throw new Error('private provider detail'); }
      }
    } as unknown as WorkspaceToolsDependencies);
    const tool = tools.find(candidate => candidate.name === 'reply_github_thread')!;
    const principal = { authentication: 'realtime' as const, subjectId: 'davo', audience: 'realtime', scopes: ['github:write' as const], stableOwnerKey: 'owner', leaseKey: 'lease' };
    await expect(tool.execute({ request_id: 'request-123', repository: 'octo/repo', number: 7, thread_id: 'thread-1', body: 'reply' }, principal)).rejects.toThrow('private provider detail');
    expect(changed).toBe(true);
  });

  // claim a public preparation before awaiting its domain execution
  it('rejects a second request while the first File execution is held', async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const reached = new Promise<void>(resolve => { entered = resolve; });
    let executions = 0;
    const tools = createWorkspaceTools({
      now: () => 1_000,
      resolvePlace: async () => ({ id: 'place-a', projectId: 'project-a', label: 'Place', home: '/place' }),
      owner: () => ({ namespace: 'conductor', principalOwnerKey: 'agent-a' }),
      hostFiles: {
        // prepare one safe additive operation
        prepareOperation: async () => ({ operationId: 'operation-1', kind: 'create-file', totalItems: 1, conflicts: [] }),
        // hold the first claimed execution
        executeOperation: async () => { executions += 1; entered(); await gate; return { operationId: 'operation-1', kind: 'create-file', state: 'running', phase: 'executing', completedItems: 0, totalItems: 1, bytesCompleted: 0, bytesTotal: 0, results: [] }; }
      }
    } as unknown as WorkspaceToolsDependencies);
    const principal = { authentication: 'conductor' as const, subjectId: 'agent-a', audience: 'conductor', scopes: ['files:write' as const] };
    const prepare = tools.find(tool => tool.name === 'prepare_file_operation')!;
    const prepared = await prepare.execute({ request_id: 'request-prepare', place_id: 'place-a', kind: 'create_file', sources: [], destination_token: 'destination-token-12345', name: 'new.txt', collision: 'fail' }, principal);
    expect(prepared.ok).toBe(true);
    const preparationId = (prepared as { ok: true; value: { preparation_id: string } }).value.preparation_id;
    const execute = tools.find(tool => tool.name === 'execute_file_operation')!;
    const first = execute.execute({ request_id: 'request-execute-1', preparation_id: preparationId }, principal);
    await reached;
    await expect(execute.execute({ request_id: 'request-execute-2', preparation_id: preparationId }, principal)).resolves.toMatchObject({ ok: false, error: { code: 'not_found' } });
    release();
    await expect(first).resolves.toMatchObject({ ok: true });
    expect(executions).toBe(1);
  });
});

describe('workspace MCP bounded reads', () => {
  // page Note attachments before issuing short-lived capabilities
  it('binds attachment cursors and mints capabilities only for returned rows', async () => {
    let now = 1_000;
    const capabilities = vi.fn((name: string) => ({ object_token: 'x'.repeat(16_384), name, size: 1, expires_at: new Date(now + 300_000).toISOString() }));
    const attachments = Array.from({ length: 4 }, (_value, index) => ({ name: `attachment-${index}.txt`, data: 'YQ==' }));
    const tools = createWorkspaceTools({
      now: () => now,
      resolveWorktree: async worktreeId => ({ id: worktreeId, projectId: 'project-a', label: 'Worktree' }),
      noteKey: async () => 'note-key',
      notes: {
        // resolve every bounded fixture Note
        resolve: async (_key: string, noteId: string) => ({ key: 'note-key', note: { id: noteId, text: '' } }),
        // return one stable attachment snapshot
        attachments: async () => attachments
      },
      owner: principal => ({ namespace: principal.authentication === 'conductor' ? 'conductor' : 'davo', principalOwnerKey: principal.stableOwnerKey ?? principal.subjectId, ...(principal.leaseKey === undefined ? {} : { leaseKey: principal.leaseKey }) }),
      transfers: { noteAttachment: (_owner: unknown, name: string) => capabilities(name) }
    } as unknown as WorkspaceToolsDependencies);
    const tool = tools.find(candidate => candidate.name === 'list_note_attachments')!;
    const conductor = { authentication: 'conductor' as const, subjectId: 'agent-a', audience: 'conductor', scopes: ['logs:read' as const] };
    const first = await tool.execute({ worktree_id: 'worktree-a', note_id: 'note-a', limit: 100 }, conductor);
    expect(first).toMatchObject({ ok: true, value: { items: [{ name: 'attachment-0.txt' }, { name: 'attachment-1.txt' }], truncated: true, next_cursor: expect.any(String) } });
    const page = (first as { ok: true; value: { items: unknown[]; next_cursor: string } }).value;
    expect(Buffer.byteLength(JSON.stringify(page.items))).toBeLessThanOrEqual(48_000);
    expect(capabilities).toHaveBeenCalledTimes(2);
    const cursor = page.next_cursor;
    const second = await tool.execute({ worktree_id: 'worktree-a', note_id: 'note-a', limit: 100, cursor }, conductor);
    expect(second).toMatchObject({ ok: true, value: { items: [{ name: 'attachment-2.txt' }, { name: 'attachment-3.txt' }], truncated: false } });
    expect(capabilities).toHaveBeenCalledTimes(4);
    const other = { ...conductor, subjectId: 'agent-b' };
    await expect(tool.execute({ worktree_id: 'worktree-a', note_id: 'note-a', limit: 100, cursor }, other)).resolves.toMatchObject({ ok: false, error: { code: 'not_found' } });
    await expect(tool.execute({ worktree_id: 'worktree-a', note_id: 'note-b', limit: 100, cursor }, conductor)).resolves.toMatchObject({ ok: false, error: { code: 'not_found' } });
    await expect(tool.execute({ worktree_id: 'worktree-a', note_id: 'note-a', limit: 100, cursor: 'malformed-cursor-value' }, conductor)).resolves.toMatchObject({ ok: false, error: { code: 'not_found' } });
    now += 300_001;
    await expect(tool.execute({ worktree_id: 'worktree-a', note_id: 'note-a', limit: 100, cursor }, conductor)).resolves.toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(capabilities).toHaveBeenCalledTimes(4);
  });

  // page role-filtered schedule targets by count and serialized bytes
  it('continues schedule targets with owner and input-bound cursors', async () => {
    const options = Array.from({ length: 100 }, (_value, index) => ({ target: { worktreeId: `${String(index).padStart(3, '0')}-${'w'.repeat(236)}` }, label: 'l'.repeat(240), available: false, reason: 'r'.repeat(240) }));
    const tools = createWorkspaceTools({
      now: () => 1_000,
      resolveWorktree: async worktreeId => ({ id: worktreeId, projectId: 'project-a', label: 'Worktree' }),
      noteKey: async () => 'note-key',
      notes: { resolve: async (_key: string, noteId: string) => ({ key: 'note-key', note: { id: noteId, text: '' } }) },
      scheduleTargets: async () => options
    } as unknown as WorkspaceToolsDependencies);
    const tool = tools.find(candidate => candidate.name === 'list_schedule_targets')!;
    const principal = { authentication: 'conductor' as const, subjectId: 'agent-a', audience: 'conductor', scopes: ['status:read' as const] };
    const first = await tool.execute({ worktree_id: 'worktree-a', note_id: 'note-a', limit: 100 }, principal);
    expect(first.ok).toBe(true);
    const page = (first as { ok: true; value: { items: unknown[]; next_cursor: string; truncated: boolean } }).value;
    expect(page.items.length).toBeLessThan(100);
    expect(Buffer.byteLength(JSON.stringify(page.items))).toBeLessThanOrEqual(48_000);
    expect(page).toMatchObject({ truncated: true, next_cursor: expect.any(String) });
    const second = await tool.execute({ worktree_id: 'worktree-a', note_id: 'note-a', limit: 100, cursor: page.next_cursor }, principal);
    expect(second).toMatchObject({ ok: true, value: { items: expect.any(Array) } });
    await expect(tool.execute({ worktree_id: 'worktree-a', note_id: 'note-b', limit: 100, cursor: page.next_cursor }, principal)).resolves.toMatchObject({ ok: false, error: { code: 'not_found' } });
  });

  // page configured action projections without exposing definitions
  it('continues configured actions with target-bound cursors', async () => {
    const emptySlots = Object.fromEntries(['tabLead', 'leftNav', 'rightNav', 'navMenu', 'pullRequest', 'reviewRequest', 'issue', 'split:agent', 'split:terminal', 'split:note', 'split:browser', 'split:files', 'split:code', 'split:review', 'split:stack', 'split:github', 'split:settings'].map(slot => [slot, []]));
    const actions = Array.from({ length: 100 }, (_value, index) => ({ action_id: `${String(index).padStart(3, '0')}-${'a'.repeat(236)}`, id: `${String(index).padStart(3, '0')}-${'a'.repeat(236)}`, text: 'l'.repeat(240), actionKind: 'prompt' as const }));
    const tools = createWorkspaceTools({
      now: () => 1_000,
      resolvePlace: async () => ({ id: 'place-a', projectId: 'project-a', label: 'Place', home: '/place' }),
      buttonCatalog: { value: { revision: 'v'.repeat(240), application: { ...emptySlots, tabLead: actions }, projects: {} } },
      canInvokeActionTarget: async () => true
    } as unknown as WorkspaceToolsDependencies);
    const tool = tools.find(candidate => candidate.name === 'list_configured_actions')!;
    const principal = { authentication: 'conductor' as const, subjectId: 'agent-a', audience: 'conductor', scopes: ['status:read' as const] };
    const first = await tool.execute({ place_id: 'place-a', limit: 100 }, principal);
    expect(first.ok).toBe(true);
    const page = (first as { ok: true; value: { items: unknown[]; next_cursor: string; truncated: boolean } }).value;
    expect(page.items.length).toBeLessThan(100);
    expect(Buffer.byteLength(JSON.stringify(page.items))).toBeLessThanOrEqual(48_000);
    expect(page).toMatchObject({ truncated: true, next_cursor: expect.any(String) });
    await expect(tool.execute({ place_id: 'place-b', limit: 100, cursor: page.next_cursor }, principal)).resolves.toMatchObject({ ok: false, error: { code: 'not_found' } });
  });

  // enforce preview caps as UTF-8 bytes without splitting code points
  it('truncates File previews at exact UTF-8 boundaries', async () => {
    let content = '';
    let backendTruncated = false;
    const tools = createWorkspaceTools({
      resolvePlace: async () => ({ id: 'place-a', projectId: 'project-a', label: 'Place', home: '/place' }),
      owner: () => ({ namespace: 'conductor', principalOwnerKey: 'agent-a' }),
      hostFiles: {
        objectPlaceId: () => 'place-a',
        // return the current multibyte fixture
        preview: async () => ({ path: '/place/file.txt', size: Buffer.byteLength(content), binary: false, content, truncated: backendTruncated })
      }
    } as unknown as WorkspaceToolsDependencies);
    const tool = tools.find(candidate => candidate.name === 'preview_file_object')!;
    const principal = { authentication: 'conductor' as const, subjectId: 'agent-a', audience: 'conductor', scopes: ['files:read' as const] };
    const preview = async (text: string, maxBytes: number): Promise<{ text?: string; truncated: boolean }> => {
      content = text;
      const result = await tool.execute({ object_token: 'object-capability-12345', max_bytes: maxBytes }, principal);
      expect(result.ok).toBe(true);
      return (result as { ok: true; value: { text?: string; truncated: boolean } }).value;
    };
    await expect(preview('abc', 2)).resolves.toEqual(expect.objectContaining({ text: 'ab', truncated: true }));
    await expect(preview('éé', 1)).resolves.toEqual(expect.objectContaining({ text: '', truncated: true }));
    await expect(preview('éé', 2)).resolves.toEqual(expect.objectContaining({ text: 'é', truncated: true }));
    await expect(preview('€x', 2)).resolves.toEqual(expect.objectContaining({ text: '', truncated: true }));
    await expect(preview('😀x', 4)).resolves.toEqual(expect.objectContaining({ text: '😀', truncated: true }));
    const maximum = 'é'.repeat(32_768);
    await expect(preview(maximum, 65_536)).resolves.toEqual(expect.objectContaining({ text: maximum, truncated: false }));
    backendTruncated = true;
    await expect(preview('a', 1)).resolves.toEqual(expect.objectContaining({ text: 'a', truncated: true }));
  });

  // authorize prune facts through the principal-aware Project boundary
  it('denies unknown and out-of-scope prune assessments without reading facts', async () => {
    const pruneFacts = vi.fn(async (projectId: string) => ({ ids: [`${projectId}-stale`], blockers: [] }));
    const resolveProject = vi.fn(async (projectId: string, principal: { authentication: string }) => principal.authentication === 'realtime' || projectId === 'project-a' ? { id: projectId } : undefined);
    const tools = createWorkspaceTools({ pruneFacts, resolveProject } as unknown as WorkspaceToolsDependencies);
    const tool = tools.find(candidate => candidate.name === 'assess_worktree_prune')!;
    const conductor = { authentication: 'conductor' as const, subjectId: 'agent-a', audience: 'conductor', scopes: ['status:read' as const] };
    const denied = await tool.execute({ project_id: 'project-b' }, conductor);
    const missing = await tool.execute({ project_id: 'project-missing' }, conductor);
    expect(denied).toEqual(missing);
    expect(denied).toMatchObject({ ok: false, error: { code: 'not_found', message: 'Project unavailable' } });
    expect(pruneFacts).not.toHaveBeenCalled();
    await expect(tool.execute({ project_id: 'project-a' }, conductor)).resolves.toMatchObject({ ok: true });
    const davo = { authentication: 'realtime' as const, subjectId: 'davo', audience: 'realtime', scopes: ['status:read' as const], stableOwnerKey: 'owner-a', leaseKey: 'lease-a' };
    await expect(tool.execute({ project_id: 'project-b' }, davo)).resolves.toMatchObject({ ok: true });
    expect(pruneFacts).toHaveBeenNthCalledWith(1, 'project-a');
    expect(pruneFacts).toHaveBeenNthCalledWith(2, 'project-b');
  });
});

describe('developer Host Files boundary', () => {
  // filter sensitive rows and escaping symlinks while retaining browser behavior
  it('resolves safe relative paths and issues no developer capability outside the Place', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rac-mcp-files-'));
    const outside = await mkdtemp(join(tmpdir(), 'rac-mcp-files-outside-'));
    directories.push(root, outside);
    await writeFile(join(root, 'safe.txt'), 'safe');
    await writeFile(join(root, '.env'), 'secret');
    await mkdir(join(root, '.data'));
    await writeFile(join(root, '.data', 'state.json'), 'secret');
    await mkdir(join(root, 'nested'));
    await writeFile(join(root, 'nested', 'inside.txt'), 'inside');
    await writeFile(join(outside, 'outside.txt'), 'outside');
    await symlink(join(outside, 'outside.txt'), join(root, 'escape'));
    const engine = createHostFilesEngine('mcp-boundary-generation', { journalFile: join(root, 'journal.json'), favoritesFile: join(root, 'favorites.json') });
    const service = new HostFilesService({ backend: engine, tokenSecret: 'mcp-boundary-token-secret' });
    const place = { id: 'place-a', home: root };
    const owner = { namespace: 'davo' as const, principalOwnerKey: 'owner-a', leaseKey: 'lease-a' };
    try {
      const developer = await service.list(place, owner);
      expect(developer.entries.map(entry => entry.name)).toContain('safe.txt');
      expect(developer.entries.map(entry => entry.name)).not.toEqual(expect.arrayContaining(['.env', '.data', 'escape']));
      expect((await service.list(place, owner, 'nested')).entries.map(entry => entry.name)).toContain('inside.txt');
      await expect(service.list(place, owner, '../')).rejects.toMatchObject({ code: 'invalid_path' });
      await expect(service.list(place, owner, '.env')).rejects.toMatchObject({ code: 'invalid_path' });
      const browser = await service.list(place, { id: 'browser-session' }, root);
      expect(browser.entries.map(entry => entry.name)).toEqual(expect.arrayContaining(['.env', '.data', 'escape']));
    } finally {
      await service.close();
    }
  });

  // claim a prepared operation before held asynchronous prevalidation
  it('allows only one concurrent executor for a prepared operation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rac-mcp-operation-'));
    directories.push(root);
    const engine = createHostFilesEngine('mcp-operation-generation', { journalFile: join(root, 'journal.json'), favoritesFile: join(root, 'favorites.json') });
    let blocked = false;
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const backend: HostFilesBackend = {
      // retain the underlying engine generation
      generation: () => engine.generation(),
      // hold the first execute-time inspect
      request: async (command, signal) => {
        if (blocked && command.kind === 'inspect') { blocked = false; entered(); await gate; }
        return await engine.request(command, signal) as never;
      },
      // preserve exact reads
      read: async (command, signal) => await engine.read(command, signal),
      // preserve atomic writes
      write: async (command, source, signal) => await engine.write(command, source, signal),
      // close the real engine
      close: async () => await engine.close()
    };
    const service = new HostFilesService({ backend, tokenSecret: 'mcp-operation-token-secret' });
    const place = { id: 'place-a', home: root };
    const session = { id: 'browser-session' };
    try {
      const listed = await service.list(place, session, root);
      const prepared = await service.prepareOperation(place, session, { kind: 'create-file', name: 'created.txt', destinationDirectoryToken: listed.destinationDirectoryToken });
      blocked = true;
      const first = service.executeOperation(place, session, prepared.operationId, {});
      await reached;
      await expect(service.executeOperation(place, session, prepared.operationId, {})).rejects.toMatchObject({ code: 'stale_object' });
      release();
      await first;
      // wait for the background execution to publish once
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((await readdir(root)).includes('created.txt')) break;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      expect((await readdir(root)).filter(name => name === 'created.txt')).toHaveLength(1);
    } finally {
      release();
      await service.close();
    }
  });
});

describe('Davo Watch pull feed', () => {
  // retain events for signed pull acknowledgement without spoofing an Agent prompt
  it('delivers a same-owner prefix and rejects cross-owner access', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-mcp-watch-'));
    directories.push(directory);
    let now = 1_000;
    let checks: 'pending' | 'failed' = 'pending';
    let state: 'OPEN' | 'MERGED' = 'OPEN';
    const submit = vi.fn(async () => 'unexpected');
    const watches = new Watches({
      file: join(directory, 'watches.json'),
      events: new ConsoleEvents(),
      github: {
        // return one mutable pull snapshot
        pullRequest: async () => ({ state, url: 'https://github.com/octo/repo/pull/7', head: 'a'.repeat(40), checks, conflict: false, threads: [] }),
        // return no review requests
        reviewRequests: async () => []
      },
      commands: { open: async () => undefined, connect: async () => undefined, status: async () => undefined, close: async () => {} },
      submit,
      sent: async () => [],
      sandboxOf: async () => undefined,
      logPath: async () => undefined,
      now: () => now,
      tokenSecret: 'workspace-watch-token-secret',
      davoOwnerAdmit: async () => ({ ok: true }),
      davoOwnerPresent: async () => true
    });
    const owner = { kind: 'davo-local' as const, principalOwnerKey: 'owner-a' };
    const created = await watches.watchPullRequestDavo(owner, { owner: 'octo', name: 'repo' }, 7);
    expect('refused' in created).toBe(false);
    const id = (created as { watch_id: string }).watch_id;
    checks = 'failed';
    now += 60_000;
    await watches.check();
    const page = await watches.davoEvents('owner-a', id);
    expect(page.events).toHaveLength(1);
    expect(page.page_token).toBeTypeOf('string');
    await expect(watches.davoEvents('owner-b', id)).rejects.toThrow('watch_unavailable');
    const acknowledged = await watches.acknowledgeDavo('owner-a', id, page.page_token!);
    expect(acknowledged).toMatchObject({ watch_id: id, acknowledged_through: 1, removed: false });
    expect(await watches.davoEvents('owner-a', id)).toMatchObject({ events: [] });
    state = 'MERGED';
    now += 60_000;
    await watches.check();
    const ended = await watches.davoEvents('owner-a', id);
    expect(ended).toMatchObject({ ended: true });
    const removed = await watches.acknowledgeDavo('owner-a', id, ended.page_token!);
    expect(removed.removed).toBe(true);
    expect(await watches.acknowledgeDavo('owner-a', id, ended.page_token!)).toEqual(removed);
    expect(submit).not.toHaveBeenCalled();
    await watches.close();
  });
});
