import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProcInspector } from '../src/discovery/processes.js';
import { isCodexCommand } from '../src/adapters/codex-processes.js';
import { openPaneThreads } from '../src/adapters/codex-conversations.js';

describe('isCodexCommand', () => {
  it('recognizes the Node launcher used by current Codex installations', () => {
    expect(isCodexCommand('MainThread', ['node', '/home/ubuntu/n/bin/codex'])).toBe(true);
  });

  it('does not treat unrelated Node processes as agents', () => {
    expect(isCodexCommand('node', ['node', '/app/server.js'])).toBe(false);
  });

  it('does not treat an OMX HUD process as an agent', () => {
    expect(isCodexCommand('MainThread', ['node', '/home/ubuntu/n/bin/omx', 'hud', '--watch'])).toBe(false);
  });

  it('no longer treats the OMX wrapper as Codex: OMX is its own kind', () => {
    expect(isCodexCommand('omx', ['/home/ubuntu/bin/omx'])).toBe(false);
    expect(isCodexCommand('MainThread', ['node', '/home/ubuntu/n/bin/omx', '--direct'])).toBe(false);
    expect(isCodexCommand('MainThread', ['/usr/bin/node', '/opt/oh-my-codex/dist/cli/omx.js', '--direct', 'resume', '--last'])).toBe(false);
  });
});

describe('ProcInspector recognizeAgent', () => {
  // build a fake /proc tree: comm, cmdline and children per pid
  const buildTree = async (root: string, tree: Record<number, { comm: string; argv: string[]; children: number[] }>) => {
    await Promise.all(Object.entries(tree).map(async ([pid, node]) => {
      await mkdir(join(root, pid, 'task', pid), { recursive: true });
      await Promise.all([
        writeFile(join(root, pid, 'comm'), `${node.comm}\n`),
        writeFile(join(root, pid, 'cmdline'), `${node.argv.join('\0')}\0`),
        writeFile(join(root, pid, 'task', pid, 'children'), `${node.children.join(' ')}\n`)
      ]);
    }));
  };
  const withProcTree = async (tree: Record<number, { comm: string; argv: string[]; children: number[] }>, run: () => Promise<void>) => {
    const root = await mkdtemp(join(tmpdir(), 'rac-recognize-'));
    const previous = process.env.RAC_HOST_PROC;
    process.env.RAC_HOST_PROC = root;
    try {
      await buildTree(root, tree);
      await run();
    } finally {
      if (previous === undefined) delete process.env.RAC_HOST_PROC; else process.env.RAC_HOST_PROC = previous;
      await rm(root, { recursive: true, force: true });
    }
  };

  it('finds a codex descendant beneath a bwrap wrapper and flags it wrapped', async () => {
    await withProcTree({
      200: { comm: 'bash', argv: ['bash'], children: [201] },
      201: { comm: 'bwrap', argv: ['bwrap', '--', 'codex'], children: [202] },
      202: { comm: 'codex', argv: ['codex'], children: [] }
    }, async () => {
      await expect(new ProcInspector().recognizeAgent(200)).resolves.toEqual({ kind: 'codex', pid: 202, wrapped: true });
    });
  });

  it('recognizes an unwrapped codex descendant without the wrapped flag', async () => {
    await withProcTree({
      300: { comm: 'bash', argv: ['bash'], children: [301] },
      301: { comm: 'codex', argv: ['codex'], children: [] }
    }, async () => {
      await expect(new ProcInspector().recognizeAgent(300)).resolves.toEqual({ kind: 'codex', pid: 301, wrapped: false });
    });
  });

  it('does not flag an agent wrapped when a bwrap sits only in a sibling branch', async () => {
    await withProcTree({
      500: { comm: 'bash', argv: ['bash'], children: [501, 503] },
      501: { comm: 'bwrap', argv: ['bwrap', '--', 'vim'], children: [502] },
      502: { comm: 'vim', argv: ['vim'], children: [] },
      503: { comm: 'codex', argv: ['codex'], children: [] }
    }, async () => {
      await expect(new ProcInspector().recognizeAgent(500)).resolves.toEqual({ kind: 'codex', pid: 503, wrapped: false });
    });
  });

  it('claims an OMX pane as omx at the wrapper, before reaching the Codex child it launched', async () => {
    // the OMX 0.21.0 tree: shell → node omx.js --direct → { notify watcher, codex }. The probe
    // saw Codex as a direct child; an `sh -c` hop between them (as older OMX spawned it) is
    // kept here to show the walker claims the wrapper regardless of what sits beneath it.
    await withProcTree({
      600: { comm: 'zsh', argv: ['-zsh'], children: [601] },
      601: { comm: 'MainThread', argv: ['/usr/bin/node', '/opt/oh-my-codex/dist/cli/omx.js', '--direct'], children: [602, 603] },
      602: { comm: 'MainThread', argv: ['/usr/bin/node', '/opt/oh-my-codex/dist/scripts/notify-fallback-watcher.js', '--cwd', '/repo', '--parent-pid', '601'], children: [] },
      603: { comm: 'sh', argv: ['sh', '-c', 'codex -c model_instructions_file=x'], children: [604] },
      604: { comm: 'codex', argv: ['codex', '-c', 'model_instructions_file=x'], children: [] }
    }, async () => {
      await expect(new ProcInspector().recognizeAgent(600)).resolves.toEqual({ kind: 'omx', pid: 601, wrapped: false });
    });
  });

  it('does not claim an OMX HUD pane, which runs no Codex', async () => {
    await withProcTree({
      700: { comm: 'zsh', argv: ['-zsh'], children: [701] },
      701: { comm: 'MainThread', argv: ['/usr/bin/node', '/opt/oh-my-codex/dist/cli/omx.js', 'hud', '--watch'], children: [] }
    }, async () => {
      await expect(new ProcInspector().recognizeAgent(700)).resolves.toBeUndefined();
    });
  });

  it('returns undefined when no registered agent runs in the tree', async () => {
    await withProcTree({
      400: { comm: 'bash', argv: ['bash'], children: [401] },
      401: { comm: 'vim', argv: ['vim'], children: [] }
    }, async () => {
      await expect(new ProcInspector().recognizeAgent(400)).resolves.toBeUndefined();
    });
  });
});

// keep rollout discovery rooted at the selected pane
describe('openPaneThreads', () => {
  // descendant descriptors count and unrelated descriptors do not
  it('reads exact rollout identities from one pane process tree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rac-proc-'));
    const previous = process.env.RAC_HOST_PROC;
    process.env.RAC_HOST_PROC = root;
    try {
      await Promise.all([
        mkdir(join(root, '100', 'task', '100'), { recursive: true }),
        mkdir(join(root, '100', 'fd'), { recursive: true }),
        mkdir(join(root, '101', 'task', '101'), { recursive: true }),
        mkdir(join(root, '101', 'fd'), { recursive: true })
      ]);
      await Promise.all([
        writeFile(join(root, '100', 'task', '100', 'children'), '101\n'),
        writeFile(join(root, '101', 'task', '101', 'children'), ''),
        symlink('/home/ubuntu/.codex/sessions/2026/08/21/rollout-2026-08-21T06-00-00-0198c333-3333-7333-8333-333333333333.jsonl', join(root, '101', 'fd', '42')),
        symlink('/tmp/unrelated.txt', join(root, '101', 'fd', '43'))
      ]);

      await expect(openPaneThreads(100)).resolves.toEqual({ rollouts: [{ id: '0198c333-3333-7333-8333-333333333333', relativePath: 'sessions/2026/08/21/rollout-2026-08-21T06-00-00-0198c333-3333-7333-8333-333333333333.jsonl' }], writers: new Set() });
    } finally {
      // restore process inspection state
      if (previous === undefined) delete process.env.RAC_HOST_PROC;
      else process.env.RAC_HOST_PROC = previous;
      await rm(root, { recursive: true, force: true });
    }
  });
});
