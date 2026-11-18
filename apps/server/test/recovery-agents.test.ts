import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecoveryAgentService } from '../src/server-admin/recovery-agents.js';
import type { HostReply, HostRequest, Installation } from '../src/settings/contracts.js';

const { beforeProcRead } = vi.hoisted(() => ({ beforeProcRead: vi.fn<() => Promise<void>>() }));
// delay the directory read while retaining the real bounded proc parser
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, readdir: async (...args: Parameters<typeof fs.readdir>) => {
    await beforeProcRead();
    return fs.readdir(...args);
  } };
});

const roots: string[] = [];

// remove only fake proc trees created by this suite
afterEach(async () => {
  beforeProcRead.mockReset();
  // clean every isolated fixture
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

// provide one minimal installed host-control identity
const installation = (uid: number): Installation => ({
  version: 1,
  installationId: 'installation-test',
  generation: 3,
  uid,
  gid: uid,
  kind: 'compose',
  hostControlRoot: '/run/rac-settings-control',
  hostCheckout: '/repo',
  serverCheckout: '/repo',
  allowedRoots: ['/repo'],
  sources: {},
  compose: { projectDirectory: '/repo', projectName: 'rac', files: ['/repo/compose.yaml'], envFiles: [], profiles: [] }
});

// render the proc stat fields through start time
const stat = (pid: number, comm: string, parentPid: number, startTime: string, state = 'S'): string => `${pid} (${comm}) ${[state, String(parentPid), ...Array.from({ length: 17 }, () => '0'), startTime].join(' ')}\n`;

// add one complete fake proc identity
async function addProcess(root: string, process: { pid: number; parentPid?: number; uid?: number; startTime?: string; comm: string; argv: string[]; cwd?: string; state?: string }): Promise<void> {
  const directory = join(root, String(process.pid));
  await mkdir(directory, { recursive: true });
  const uid = process.uid ?? 1200;
  await Promise.all([
    writeFile(join(directory, 'comm'), `${process.comm}\n`),
    writeFile(join(directory, 'cmdline'), `${process.argv.join('\0')}\0`),
    writeFile(join(directory, 'stat'), stat(process.pid, process.comm, process.parentPid ?? 1, process.startTime ?? String(process.pid * 10), process.state)),
    writeFile(join(directory, 'status'), `Name:\t${process.comm}\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`),
    symlink(process.cwd ?? '/workspace/project', join(directory, 'cwd'))
  ]);
}

// build one isolated fake proc root
async function fakeProc(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'rac-recovery-agents-'));
  roots.push(root);
  return root;
}

describe('RecoveryAgentService', () => {
  it('lists top-level interactive Agents without tmux and keeps ids stable across repolls', async () => {
    const root = await fakeProc();
    await Promise.all([
      addProcess(root, { pid: 100, comm: 'codex', argv: ['codex', 'resume', '--last'] }),
      addProcess(root, { pid: 101, comm: 'codex', argv: ['codex', 'app-server', '--listen', 'stdio://'] }),
      addProcess(root, { pid: 200, comm: 'MainThread', argv: ['node', '/opt/oh-my-codex/dist/cli/omx.js', '--direct'] }),
      addProcess(root, { pid: 201, parentPid: 200, comm: 'sh', argv: ['sh', '-c', 'codex'] }),
      addProcess(root, { pid: 202, parentPid: 201, comm: 'codex', argv: ['codex'] }),
      addProcess(root, { pid: 300, comm: 'codex', argv: ['codex'], cwd: '/repo/.omx/team/demo/worktrees/worker-1' }),
      addProcess(root, { pid: 400, comm: 'claude', argv: ['claude', '--print', 'answer'] }),
      addProcess(root, { pid: 500, uid: 1300, comm: 'claude', argv: ['claude'] }),
      addProcess(root, { pid: 600, comm: 'MainThread', argv: ['node', '/repo/apps/server/src/transports/holder.ts', '/tmp/private/holder.sock', '--', 'node', '/repo/apps/server/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js', '--mode', 'rpc', '-ne', '-e', '/repo/apps/server/src/adapters/pi-extension.ts', '--offline', '--no-approve', '--tools', 'read,bash'] }),
      addProcess(root, { pid: 601, parentPid: 600, comm: 'pi', argv: ['pi'], cwd: '/worktrees/skills' })
    ]);
    const transport = { installation: vi.fn(async () => installation(1200)), request: vi.fn(async () => { throw new Error('unused'); }) };
    const tokens = ['A'.repeat(32), 'B'.repeat(32), 'C'.repeat(32)];
    const service = new RecoveryAgentService({ procRoot: root, hostUid: 1200, transport, token: () => tokens.shift()! });

    const first = await service.list();
    const second = await service.list();

    expect(first).toEqual({ available: true, canStop: true, agents: [
      { id: 'A'.repeat(32), kind: 'codex', label: 'Codex · project', pid: 100 },
      { id: 'B'.repeat(32), kind: 'omx', label: 'OMX · project', pid: 200 },
      { id: 'C'.repeat(32), kind: 'pi', label: 'Pi · skills', pid: 601 }
    ] });
    expect(second.agents).toEqual(first.agents);
    expect(transport.request).not.toHaveBeenCalled();
  });

  // authorize only the actual program and never Node input or a later app argument
  it('requires a verified launcher entry before exposing a selectable process', async () => {
    const root = await fakeProc();
    const claude = '/opt/@anthropic-ai/claude-code/cli.js';
    const cases = [
      ['node', '/opt/worker.js', 'codex'], ['node', '/opt/worker.js', claude],
      ['node', '-r', 'omx', '/opt/worker.js'], ['node', '-e', 'worker()', 'codex'],
      ['node', '--run', 'codex'], ['node', '--unknown-option', 'codex'],
      ['node', '--require', '/opt/preload.js', '/opt/codex.js'],
      ['node', '--no-warnings', '--', claude, 'codex'],
      ['node', '--require=/opt/preload.js', '/opt/omx.js', 'resume'],
      ['sh', '/opt/worker.js', claude]
    ];
    await Promise.all(cases.map((argv, index) => addProcess(root, { pid: 101 + index, comm: argv[0]!, argv })));
    const service = new RecoveryAgentService({ procRoot: root, hostUid: 1200, transport: { installation: async () => installation(1200), request: vi.fn() } });
    expect((await service.list()).agents.map(({ pid, kind }) => [pid, kind])).toEqual([[107, 'codex'], [108, 'claude'], [109, 'omx']]);
  });

  // simulate pressure without touching the host proc tree
  it('shares overdue scans, caches after settlement and immediately retries a failed scan', async () => {
    const root = await fakeProc();
    let now = 10_000;
    let resume!: () => void;
    beforeProcRead.mockReturnValueOnce(new Promise<void>(resolve => { resume = resolve; }));
    const service = new RecoveryAgentService({ procRoot: root, hostUid: 1200, now: () => now, transport: { installation: async () => installation(1200), request: vi.fn() } });
    const first = service.list();
    now += 2_000;
    const second = service.list();
    const scansWhilePending = beforeProcRead.mock.calls.length;
    resume();
    await Promise.all([first, second]);
    expect(scansWhilePending).toBe(1);
    now += 999;
    await service.list();
    expect(beforeProcRead).toHaveBeenCalledTimes(1);
    now += 1;
    beforeProcRead.mockRejectedValueOnce(new Error('synthetic scan failure'));
    await expect(service.list()).resolves.toMatchObject({ available: false });
    await expect(service.list()).resolves.toMatchObject({ available: true });
    expect(beforeProcRead).toHaveBeenCalledTimes(3);
  });

  it('translates selected opaque ids into exact short-lived host targets', async () => {
    const root = await fakeProc();
    await addProcess(root, { pid: 100, comm: 'codex', argv: ['codex'], startTime: '777' });
    let captured: HostRequest | undefined;
    const transport = {
      installation: vi.fn(async () => installation(1200)),
      request: vi.fn(async (request: HostRequest): Promise<HostReply> => {
        captured = request;
        return { version: 1, id: request.id, kind: request.kind, state: 'complete', agentStops: [{ pid: 100, startTime: '777', status: 'signal_sent' }] };
      })
    };
    let now = 10_000;
    const service = new RecoveryAgentService({ procRoot: root, hostUid: 1200, transport, now: () => now, token: () => 'A'.repeat(32) });
    const [agent] = (await service.list()).agents;

    const result = await service.stop([agent!.id]);

    expect(result).toEqual({ available: true, canStop: true, results: [{ id: agent!.id, status: 'signal_sent' }] });
    expect(captured).toMatchObject({ kind: 'agents-stop', generation: 3, agentStop: { targets: [{ pid: 100, startTime: '777', uid: 1200, kind: 'codex' }] } });
    expect(captured!.agentStop!.deadline).toBe(18_000);

    // expire the opaque selection without issuing another host request
    now += 31_000;
    await expect(service.stop([agent!.id])).resolves.toEqual({ available: true, canStop: false, results: [{ id: agent!.id, status: 'not_found', message: 'The Agent identity is no longer available.' }] });
    expect(transport.request).toHaveBeenCalledTimes(1);
  });

  it('remains read-only when host control is absent', async () => {
    const root = await fakeProc();
    await addProcess(root, { pid: 100, comm: 'claude', argv: ['claude'] });
    const transport = { installation: vi.fn(async () => undefined), request: vi.fn(async () => { throw new Error('unused'); }) };
    const service = new RecoveryAgentService({ procRoot: root, hostUid: 1200, transport, token: () => 'A'.repeat(32) });

    const listed = await service.list();
    const stopped = await service.stop([listed.agents[0]!.id]);

    expect(listed).toMatchObject({ available: true, canStop: false, agents: [{ kind: 'claude', pid: 100 }] });
    expect(stopped).toEqual({ available: true, canStop: false, results: [{ id: listed.agents[0]!.id, status: 'rejected', message: 'Safe host process control is unavailable.' }] });
    expect(transport.request).not.toHaveBeenCalled();
  });
});
