import { createServer } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { TicketStore } from '../src/auth/tickets.js';
import { codexAdapter } from '../src/adapters/codex.js';
import type { PaneActivitySubscriber, PaneClient, PaneStreamProvider } from '../src/tmux/control.js';
import { testConfig, testProject } from './helpers/config.js';

// Drive the real /ws/pane handler over a real WebSocket, with a fake pane stream (so no
// tmux control client is spawned) and a fake tmux adapter (so no process is spawned). This
// is the sandbox-runnable seam: the socket wiring — seed after the first size, byte input,
// the smaller-client size, drop-and-reseed flow control, the derive, Ctrl+C routing, exit
// and membership — none of which the framer units or the host-only real-tmux test can see.
// The full end-to-end proof against a real tmux server lives in the host-gated harness.
// Node's global WebSocket has no header control, so the app's public origin is pointed at
// the loopback address it listens on to satisfy the same-host check.

const auth = { unsign: () => 'session', get: () => ({ id: 'session', csrf: 'csrf' }), csrf: () => true } as never;
const dashboardUpdates = { setLoader: () => {}, refresh: async () => {}, close: () => {} } as never;

const socket = { fingerprint: 'sockfp', path: '/tmp/rac-pane-test.sock', device: 0, inode: 0 };
// the composite agent id embeds the raw tmux session ($1) behind the socket fingerprint
const agentOf = (kind: string) => ({ id: 'agent-1', paneId: '%1', sessionId: 'sockfp:$1', socketFingerprint: 'sockfp', home: '/repo', title: 'Ready', kind, attention: 'finished' });
const discoveryOf = (kind: string) => {
  const target = async (id: string) => (id === 'agent-1' ? { agent: agentOf(kind), socket } : undefined);
  // the project proxy inspects every WS upgrade; no worktrees means it passes ours to Fastify
  return { target, snapshotTarget: target, worktreesNow: () => [] } as never;
};

// a control client whose activity and bytes the test drives, recording what it was asked to
// type and how deep it seeded
function fakePaneStream() {
  let subscriber: PaneActivitySubscriber | undefined;
  const inputs: Buffer[] = [];
  const seedDepths: number[] = [];
  let seedBytes: Buffer = Buffer.from('SEED');
  let captureText = 'idle';
  let assistantMessage: string | undefined;
  // windowId is the pane socket's liveness signal (a gone pane has none), so a closed pane is
  // simulated by clearing it, not by failing size()
  let windowId: string | undefined = '@7';
  let inputAccepted = true;
  const client: PaneClient = {
    subscribe(_pane, sub) { subscriber = sub; return () => {}; },
    capture: async () => captureText,
    windowId: async () => windowId,
    sendInput: async (_pane, bytes) => { inputs.push(Buffer.from(bytes)); return inputAccepted; },
    seed: async (_pane, depth) => { seedDepths.push(depth); return seedBytes; }
  };
  const provider: PaneStreamProvider = { get: () => client, openPaneKeys: () => new Set(), closeAll: () => {} };
  return {
    provider,
    inputs,
    seedDepths,
    setSeed: (value: Buffer) => { seedBytes = value; },
    setWindowId: (value: string | undefined) => { windowId = value; },
    refuseInput: () => { inputAccepted = false; },
    setCapture: (value: string) => { captureText = value; },
    setAssistantMessage: (value: string | undefined) => { assistantMessage = value; },
    assistantMessage: () => assistantMessage,
    output: (bytes: Buffer) => subscriber?.onOutput?.(bytes),
    fire: (event: 'onReseed' | 'onResize') => subscriber?.[event]?.(),
    exit: (reason: string) => subscriber?.onExit?.(reason),
    activity: () => subscriber?.onActivity?.(),
    clipboard: (text: string) => subscriber?.onClipboard?.(text)
  };
}

// a fake tmux adapter: enough of the surface /ws/pane touches, with settable size and a
// captureWindow that runs the derive over the fake connection
function fakeTmux(stream: ReturnType<typeof fakePaneStream>, overrides: Record<string, unknown> = {}) {
  const resizes: Array<{ cols: number; rows: number }> = [];
  return {
    resizes,
    tmux: {
      size: async () => ({ cols: 80, rows: 24, clientLimit: { cols: 80, rows: 24 } }),
      resize: async (_s: unknown, _p: string, cols: number, rows: number) => { resizes.push({ cols, rows }); return true; },
      unpinWindowSize: async () => true,
      sessionPaneIds: async () => ['%1', '%2'],
      captureWindow: async (_s: unknown, _p: string, _r: number, via: (depth: number) => Promise<string | undefined>) => {
        const text = await via(5_000);
        return text === undefined ? undefined : { text, older: false, latestAgentMessage: text, ...(stream.assistantMessage() === undefined ? {} : { latestAssistantMessage: stream.assistantMessage(), latestAssistantMessageOverflows: false }) };
      },
      ...overrides
    } as never
  };
}

// a prompts double so Ctrl+C routing and the mutation lock are observable without the real
// PromptService's tmux/discovery machinery
function fakePrompts() {
  let mutations = 0;
  let releases = 0;
  let cancels = 0;
  let cancelOutcome: 'ok' | 'not-working' | 'unavailable' = 'ok';
  return {
    setCancelOutcome: (value: 'ok' | 'not-working' | 'unavailable') => { cancelOutcome = value; },
    mutations: () => mutations,
    releases: () => releases,
    cancels: () => cancels,
    prompts: {
      beginAgentMutation: () => { mutations += 1; return () => { releases += 1; }; },
      cancel: async () => { cancels += 1; return cancelOutcome; },
      observe: async () => {},
      close: async () => true
    } as never
  };
}

const open: Array<{ app: FastifyInstance; ws: WebSocket }> = [];
afterEach(async () => {
  const closed = new Set<FastifyInstance>();
  for (const { app, ws } of open.splice(0)) {
    try { ws.close(); } catch { /* already closed */ }
    if (!closed.has(app)) { closed.add(app); await app.close().catch(() => { /* already closed */ }); }
  }
  vi.restoreAllMocks();
});

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

type Deps = { kind?: string; controlActive?: () => boolean; controlConnect?: () => boolean; tmux?: unknown; prompts?: unknown; query?: string; discovery?: unknown; sendOnOpen?: unknown };

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function connect(paneStream: PaneStreamProvider, deps: Deps = {}) {
  const kind = deps.kind ?? 'claude';
  const control = { connect: deps.controlConnect ?? (() => true), active: deps.controlActive ?? (() => true) } as never;
  const port = await freePort();
  const tickets = new TicketStore();
  const app = await buildApp(
    testConfig({ publicOrigin: new URL(`http://127.0.0.1:${port}`), projects: [testProject({ id: 'proj' })] as never }),
    { auth, control, dashboardUpdates, discovery: deps.discovery ?? discoveryOf(kind), tickets, paneStream, ...(deps.tmux === undefined ? {} : { tmux: deps.tmux }), ...(deps.prompts === undefined ? {} : { prompts: deps.prompts }) } as never
  );
  await app.listen({ host: '127.0.0.1', port });
  const ticket = tickets.mint('session', 'pane', 'agent-1').id;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/pane/agent-1${deps.query ?? ''}`, ['rac', ticket]);
  ws.binaryType = 'arraybuffer';
  open.push({ app, ws });
  const frames: Record<string, unknown>[] = [];
  const binary: Buffer[] = [];
  // every message in arrival order, so a test can assert the seed never precedes its size
  const order: string[] = [];
  let closeCode: number | undefined;
  ws.addEventListener('message', event => {
    const data = (event as MessageEvent).data;
    if (typeof data === 'string') { const frame = JSON.parse(data) as Record<string, unknown>; frames.push(frame); order.push(`frame:${String(frame.type)}`); }
    else { binary.push(Buffer.from(data as ArrayBuffer)); order.push('binary'); }
  });
  ws.addEventListener('close', event => { closeCode = (event as CloseEvent).code; });
  await new Promise<void>((resolve) => {
    // Optionally fire a frame synchronously inside the 'open' event — i.e. while the server
    // handler may still be mid-setup — to exercise the early-frame buffering.
    ws.addEventListener('open', () => { if (deps.sendOnOpen !== undefined) ws.send(JSON.stringify(deps.sendOnOpen)); resolve(); });
    ws.addEventListener('close', () => resolve());
    ws.addEventListener('error', () => resolve());
  });
  const send = (frame: unknown) => ws.send(JSON.stringify(frame));
  const viewport = (cols = 100, rows = 30, scrollback = 500) => send({ type: 'viewport', cols, rows, scrollback });
  return { frames, binary, order, send, viewport, closeCode: () => closeCode };
}

const encode = (data: string) => Buffer.from(data, 'utf8').toString('base64url');

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('pane socket did not reach the expected state');
}

describe('/ws/pane seed and size', () => {
  it('sends the actual size then the seed after the first viewport', async () => {
    const stream = fakePaneStream();
    stream.setSeed(Buffer.from('SEEDBYTES'));
    const { tmux, resizes } = fakeTmux(stream);
    const conn = await connect(stream.provider, { tmux });
    conn.viewport(100, 30);

    // the size frame reports the pane's actual (clamped) size, and the seed follows it
    await waitFor(() => conn.binary.length > 0);
    const size = conn.frames.find(frame => frame.type === 'size');
    expect(size).toEqual({ type: 'size', cols: 80, rows: 24 });
    expect(conn.binary[0]!.toString()).toBe('SEEDBYTES');
    // a second attached client smaller than the 100x30 claim wins: the pane is resized to it
    expect(resizes).toContainEqual({ cols: 80, rows: 24 });
    // the seed was captured to the depth the browser asked for
    expect(stream.seedDepths).toContain(500);
  });

  it('sends size before the seed even when two viewports arrive together', async () => {
    const stream = fakePaneStream();
    stream.setSeed(Buffer.from('SEEDBYTES'));
    const { tmux } = fakeTmux(stream);
    const conn = await connect(stream.provider, { tmux });
    // A mount-time viewport burst: the browser's onOpen and ResizeObserver both propose a
    // grid, so two viewport frames arrive back to back (often in one socket read). The seed
    // must still follow the size frame — the client buffers only a small pre-size window and
    // silently drops a large seed that arrives before its size, leaving the pane blank.
    conn.viewport(100, 30);
    conn.viewport(80, 24);

    await waitFor(() => conn.binary.length > 0);
    // wait for at least one size frame too, so the ordering assertion is not vacuous
    await waitFor(() => conn.order.includes('frame:size'));
    expect(conn.order.indexOf('frame:size')).toBeLessThan(conn.order.indexOf('binary'));
  });

  it('does not lose the first viewport that arrives during async setup', async () => {
    const stream = fakePaneStream();
    stream.setSeed(Buffer.from('SEEDBYTES'));
    const { tmux } = fakeTmux(stream);
    // The browser sends its first (and, until a resize, only) viewport right on open, while
    // the handler is still resolving the target/membership. A slow resolution here stands in
    // for a Worktree pane's `list-panes` spawn: the frame must be buffered, not dropped —
    // otherwise no size, no seed, and the pane stays blank while still taking input.
    const slowTarget = async (id: string) => { await delay(120); return id === 'agent-1' ? { agent: agentOf('claude'), socket } : undefined; };
    const slowDiscovery = {
      target: slowTarget,
      snapshotTarget: slowTarget,
      worktreesNow: () => []
    };
    const conn = await connect(stream.provider, { tmux, discovery: slowDiscovery, sendOnOpen: { type: 'viewport', cols: 100, rows: 30, scrollback: 500 } });

    // No further viewport is ever sent; the one buffered during setup must drive size + seed.
    await waitFor(() => conn.binary.length > 0);
    expect(conn.frames.find(frame => frame.type === 'size')).toEqual({ type: 'size', cols: 80, rows: 24 });
    expect(conn.binary[0]!.toString()).toBe('SEEDBYTES');
  });

  it('closes 1008 for a pane id outside the Agent\'s session', async () => {
    const stream = fakePaneStream();
    const { tmux } = fakeTmux(stream, { sessionPaneIds: async () => ['%1'] });
    const conn = await connect(stream.provider, { tmux, query: '?pane=%99' });
    await waitFor(() => conn.closeCode() !== undefined);
    expect(conn.closeCode()).toBe(1008);
  });
});

describe('/ws/pane clipboard', () => {
  it('forwards a pane copy to the browser as a clipboard frame', async () => {
    const stream = fakePaneStream();
    const { tmux } = fakeTmux(stream);
    const conn = await connect(stream.provider, { tmux });
    stream.clipboard('yanked line\n');
    await waitFor(() => conn.frames.some(frame => frame.type === 'clipboard'));
    expect(conn.frames.find(frame => frame.type === 'clipboard')).toEqual({ type: 'clipboard', text: 'yanked line\n' });
  });
});

describe('/ws/pane input', () => {
  // a picker on the pane (tmux `choose-tree`) refuses input; closing would only loop the
  // browser through "Reconnecting…" while the panel's notice offers the way out
  it('keeps the stream open when a pane mode refuses the keystroke', async () => {
    const stream = fakePaneStream();
    const { tmux } = fakeTmux(stream, { heldPaneMode: async () => 'tree-mode' });
    const conn = await connect(stream.provider, { tmux, prompts: fakePrompts().prompts });
    stream.refuseInput();
    conn.send({ type: 'input', data: encode('x') });
    await waitFor(() => stream.inputs.length > 0);
    await delay(100);
    expect(conn.closeCode()).toBeUndefined();
  });

  it('closes 1011 when input fails with no pane mode to blame', async () => {
    const stream = fakePaneStream();
    const { tmux } = fakeTmux(stream, { heldPaneMode: async () => undefined });
    const conn = await connect(stream.provider, { tmux, prompts: fakePrompts().prompts });
    stream.refuseInput();
    conn.send({ type: 'input', data: encode('x') });
    await waitFor(() => conn.closeCode() !== undefined);
    expect(conn.closeCode()).toBe(1011);
  });

  it('types base64url bytes into the pane byte-exact, taking and releasing the mutation lock', async () => {
    const stream = fakePaneStream();
    const { tmux } = fakeTmux(stream);
    const prompts = fakePrompts();
    const conn = await connect(stream.provider, { tmux, prompts: prompts.prompts });
    conn.send({ type: 'input', data: encode('hi') });
    await waitFor(() => stream.inputs.length > 0);
    expect(stream.inputs[0]!.toString('utf8')).toBe('hi');
    // the Agent's own pane takes the mutation lock and releases it, exactly as the input socket does
    await waitFor(() => prompts.releases() > 0);
    expect(prompts.mutations()).toBe(1);
    expect(prompts.releases()).toBe(1);
  });

  it('streams a sibling session pane and sends its input raw, without the mutation lock or Ctrl+C routing', async () => {
    // %2 is a member of the Agent's session (sessionPaneIds) but not the Agent's own pane (%1)
    const stream = fakePaneStream();
    const { tmux } = fakeTmux(stream);
    const prompts = fakePrompts();
    const conn = await connect(stream.provider, { tmux, prompts: prompts.prompts, query: '?pane=%2' });
    conn.viewport(100, 30);
    await waitFor(() => conn.binary.length > 0);

    // even a lone Ctrl+C reaches a non-Agent pane literally — no queued-prompt cancellation
    conn.send({ type: 'input', data: encode('\x03') });
    await waitFor(() => stream.inputs.length > 0);
    expect([...stream.inputs[0]!]).toEqual([0x03]);
    expect(prompts.mutations()).toBe(0);
    expect(prompts.cancels()).toBe(0);
  });

  it('rejects an input frame over 64 KiB decoded', async () => {
    const stream = fakePaneStream();
    const { tmux } = fakeTmux(stream);
    const conn = await connect(stream.provider, { tmux, prompts: fakePrompts().prompts });
    conn.send({ type: 'input', data: Buffer.alloc(65_537).toString('base64url') });
    await waitFor(() => conn.closeCode() !== undefined);
    expect(conn.closeCode()).toBe(1008);
    expect(stream.inputs).toHaveLength(0);
  });

  it('routes a lone Ctrl+C through cancellation while the Agent is working, not forwarding it', async () => {
    const stream = fakePaneStream();
    const { tmux } = fakeTmux(stream);
    const prompts = fakePrompts();
    prompts.setCancelOutcome('ok');
    const conn = await connect(stream.provider, { tmux, prompts: prompts.prompts });
    conn.send({ type: 'input', data: encode('\x03') });
    // the cancellation path ran (under the mutation lock) and the literal byte was not forwarded
    await waitFor(() => prompts.cancels() > 0);
    expect(stream.inputs).toHaveLength(0);
    expect(prompts.mutations()).toBe(1);
    await waitFor(() => prompts.releases() === 1);
    // the socket stays open — the interrupt was handled, not an error
    expect(conn.closeCode()).toBeUndefined();
  });

  it('forwards the literal Ctrl+C under the mutation lock when the Agent is not working', async () => {
    const stream = fakePaneStream();
    const { tmux } = fakeTmux(stream);
    const prompts = fakePrompts();
    prompts.setCancelOutcome('not-working');
    const conn = await connect(stream.provider, { tmux, prompts: prompts.prompts });
    conn.send({ type: 'input', data: encode('\x03') });
    await waitFor(() => stream.inputs.length > 0);
    expect([...stream.inputs[0]!]).toEqual([0x03]);
    expect(prompts.cancels()).toBe(1);
    await waitFor(() => prompts.releases() === 1);
  });
});

describe('/ws/pane flow control', () => {
  it('drops output while the browser is behind and reseeds once acks catch up', async () => {
    const stream = fakePaneStream();
    stream.setSeed(Buffer.from('FIRST-SEED'));
    const { tmux } = fakeTmux(stream);
    const conn = await connect(stream.provider, { tmux });
    conn.viewport(100, 30);
    await waitFor(() => conn.binary.some(buffer => buffer.toString() === 'FIRST-SEED'));

    // flood past the 256 KiB high-water mark without acking; output is dropped, not queued
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    for (let n = 0; n < 8; n += 1) stream.output(chunk);
    await new Promise(resolve => setTimeout(resolve, 50));
    const streamedBeforeAck = conn.binary.length;
    // the flood did not stream unboundedly: most of the 8 chunks were dropped, not forwarded
    expect(streamedBeforeAck).toBeLessThan(6);

    // acking below the 64 KiB low-water mark reseeds: a reseed frame, then a fresh seed whose
    // distinct bytes prove the replacement screen is actually re-delivered (not just the frame)
    stream.setSeed(Buffer.from('RECOVERY-SEED'));
    conn.send({ type: 'ack', bytes: 8 * 64 * 1024 });
    await waitFor(() => conn.frames.some(frame => frame.type === 'reseed'));
    await waitFor(() => conn.binary.some(buffer => buffer.toString() === 'RECOVERY-SEED'));
  });
});

describe('/ws/pane derive (Codex)', () => {
  const question = { id: 'q', text: 'Pick one', choices: ['1. keep', '2. drop'], source: 'parsed' as const };

  // open native follow-up chrome before the existing question frame enters answer mode
  it.each(['codex', 'omx'])('opens a queued %s question once and frames its choices', async kind => {
    const banner = '• Queued follow-up inputs\n  ? 1 question\n    shift+← to answer\n\n› Ask Codex to do anything\n  gpt-6-astra · /repo · main';
    const expanded = '• Queued follow-up inputs\n\nWhich approach?\n\n› 1. Small\n  2. Other\n\nenter submit   ctrl+] skip   alt+↓ main prompt';
    const stream = fakePaneStream();
    stream.setCapture(banner);
    const sendKeys = vi.fn(async () => true);
    const { tmux } = fakeTmux(stream, {
      // omit queued chrome from the isolated assistant text
      captureWindow: async () => ({ text: await stream.provider.get(socket, '$1').capture('%1', 100), latestAgentMessage: 'Working on the task', older: false }),
      capture: async () => stream.provider.get(socket, '$1').capture('%1', 100),
      sendKeys
    });
    const conn = await connect(stream.provider, { kind, tmux });
    await waitFor(() => sendKeys.mock.calls.length === 1);
    expect(sendKeys.mock.calls).toEqual([[socket, '%1', ['S-Left']]]);
    conn.send({ type: 'metadata' });
    await delay(350);
    expect(sendKeys).toHaveBeenCalledTimes(1);

    // the native redraw exposes choices without any automatic answer
    stream.setCapture(expanded);
    // use the real capture enrichment after the popup replaces the composer
    Object.assign(tmux, fakeTmux(stream).tmux);
    stream.activity();
    await waitFor(() => conn.frames.some(frame => frame.type === 'question' && (frame.question as { text?: string })?.text === 'Which approach?'));
    expect(conn.frames.find(frame => (frame.question as { text?: string })?.text === 'Which approach?')?.question).toMatchObject({ choices: ['Small', 'Other'], selectedIndex: 0 });
    expect(sendKeys).toHaveBeenCalledTimes(1);

    // do not override a deliberate return to the main prompt
    stream.setCapture(banner);
    stream.activity();
    await delay(350);
    expect(sendKeys).toHaveBeenCalledTimes(1);

    // a completed question rearms the next follow-up
    stream.setCapture('› Ask Codex to do anything');
    stream.activity();
    await delay(350);
    stream.setCapture(banner);
    stream.activity();
    await waitFor(() => sendKeys.mock.calls.length === 2);
    expect(sendKeys.mock.calls[1]).toEqual([socket, '%1', ['S-Left']]);
  });

  it('frames a question and metadata on change, and never re-parses an unchanged pane', async () => {
    const questions = codexAdapter.questions as { parse: (capture: string) => typeof question | undefined };
    const parse = vi.spyOn(questions, 'parse').mockImplementation(capture => capture.includes('CHOOSE') ? question : undefined);
    const stream = fakePaneStream();
    stream.setAssistantMessage('the answer');
    const { tmux } = fakeTmux(stream);
    const conn = await connect(stream.provider, { kind: 'codex', tmux });

    // metadata is carried once at subscribe
    await waitFor(() => conn.frames.some(frame => frame.type === 'metadata'));
    expect(conn.frames.find(frame => frame.type === 'metadata')!.metadata).toEqual({ message: 'the answer', overflow: false });

    // the pane prints a Codex-shaped choice list; the next frame carries the question
    stream.setCapture('CHOOSE an option');
    stream.activity();
    await waitFor(() => conn.frames.some(frame => frame.type === 'question' && JSON.stringify(frame.question) === JSON.stringify(question)));

    // an idle re-capture of the same pane must not run the parser again nor frame again
    const parsesAfter = parse.mock.calls.length;
    const framesAfter = conn.frames.length;
    stream.activity();
    stream.activity();
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(parse.mock.calls.length).toBe(parsesAfter);
    expect(conn.frames.length).toBe(framesAfter);
  });

  it('answers an on-demand metadata request', async () => {
    const stream = fakePaneStream();
    stream.setAssistantMessage('answer one');
    const { tmux } = fakeTmux(stream);
    const conn = await connect(stream.provider, { kind: 'codex', tmux });
    await waitFor(() => conn.frames.some(frame => frame.type === 'metadata'));

    const before = conn.frames.length;
    conn.send({ type: 'metadata' });
    await waitFor(() => conn.frames.length > before);
    expect(conn.frames.at(-1)!.type).toBe('metadata');
  });

  it('performs no derive for a Claude Agent', async () => {
    const stream = fakePaneStream();
    const { tmux } = fakeTmux(stream);
    const conn = await connect(stream.provider, { kind: 'claude', tmux });
    conn.viewport(100, 30);
    await waitFor(() => conn.binary.length > 0);
    conn.send({ type: 'metadata' });
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(conn.frames.every(frame => frame.type !== 'metadata' && frame.type !== 'question')).toBe(true);
  });
});

describe('/ws/pane lifecycle', () => {
  it('sends exit "pane closed" and closes 1000 when the pane is gone on a layout change', async () => {
    const stream = fakePaneStream();
    const { tmux } = fakeTmux(stream);
    const conn = await connect(stream.provider, { tmux });
    conn.viewport(100, 30);
    await waitFor(() => conn.binary.length > 0);

    // a killed pane has no window id over the control connection; the layout change re-checks it
    stream.setWindowId(undefined);
    stream.fire('onResize');
    await waitFor(() => conn.frames.some(frame => frame.type === 'exit' && frame.reason === 'pane closed'));
    await waitFor(() => conn.closeCode() !== undefined);
    expect(conn.closeCode()).toBe(1000);
  });

  it('forwards the control client\'s exit reason and closes 1011', async () => {
    const stream = fakePaneStream();
    const { tmux } = fakeTmux(stream);
    const conn = await connect(stream.provider, { tmux });
    conn.viewport(100, 30);
    await waitFor(() => conn.binary.length > 0);

    // the control client distinguishes a session ending from its own client being lost
    stream.exit('control client lost');
    await waitFor(() => conn.closeCode() !== undefined);
    expect(conn.frames.some(frame => frame.type === 'exit' && frame.reason === 'control client lost')).toBe(true);
    expect(conn.closeCode()).toBe(1011);
  });

  it('closes 1008 for a browser without the control session', async () => {
    const stream = fakePaneStream();
    const { tmux } = fakeTmux(stream);
    const conn = await connect(stream.provider, { tmux, controlConnect: () => false });
    await waitFor(() => conn.closeCode() !== undefined);
    expect(conn.closeCode()).toBe(1008);
  });
});

describe('/ws/pane Worktree target', () => {
  const worktree = { id: 'cora', projectId: 'proj', label: 'Cora', path: '/repo', identity: '/repo', available: true, pinned: false, main: false, detached: false, locked: false, push: { label: 'p', prompt: '$p' } };
  const member = { paneId: '%2', sessionId: '$1', pid: 2, path: '/repo', command: 'zsh', role: 'shell', title: '', socket };
  const notesPlace = { id: 'notes:/data/notes', kind: 'directory', projectId: 'notes', label: 'Notes', home: '/data/notes', hostPath: '/host/notes' };
  const scratchPlace = { id: 'scratch:/home/me/scratch', kind: 'scratch', projectId: 'scratch', label: '~ Scratch', home: '/home/me/scratch' };

  // drive /ws/pane against a Worktree target (by default discovery.target misses, so the handler
  // falls to the Worktree branch and checks membership against launch.placePanes). `target`
  // can resolve a live Agent (so the handler refuses that pane) and `prompts` is wired in so the
  // no-lock assertions on a raw pane are load-bearing. `forcedTarget` stands in for the
  // scanning lookup alone, when a test must tell it apart from the snapshot one.
  async function connectWorktree(query: string, placePanes: () => Promise<unknown[]>, stream: ReturnType<typeof fakePaneStream>, tmuxOverride: unknown, deps: { target?: (id: string) => Promise<unknown>; forcedTarget?: (id: string) => Promise<unknown>; prompts?: unknown; placeId?: string } = {}) {
    const placeId = deps.placeId ?? 'cora';
    const control = { connect: () => true, active: () => true } as never;
    const port = await freePort();
    const tickets = new TicketStore();
    // the dashboard lists a directory-Project and a Scratch Place beside the Worktree
    const target = deps.target ?? (async () => undefined);
    const discovery = { target: deps.forcedTarget ?? target, snapshotTarget: target, worktreesNow: () => [worktree], place: async (id: string) => [notesPlace, scratchPlace].find(place => place.id === id) } as never;
    const launch = { placePanes } as never;
    const app = await buildApp(
      testConfig({ publicOrigin: new URL(`http://127.0.0.1:${port}`), projects: [testProject({ id: 'proj' })] as never }),
      { auth, control, dashboardUpdates, discovery, launch, tickets, paneStream: stream.provider, tmux: tmuxOverride, ...(deps.prompts === undefined ? {} : { prompts: deps.prompts }) } as never
    );
    await app.listen({ host: '127.0.0.1', port });
    const ticket = tickets.mint('session', 'pane', placeId).id;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/pane/${encodeURIComponent(placeId)}${query}`, ['rac', ticket]);
    ws.binaryType = 'arraybuffer';
    open.push({ app, ws });
    const binary: Buffer[] = [];
    const frames: Record<string, unknown>[] = [];
    let closeCode: number | undefined;
    ws.addEventListener('message', event => { const data = (event as MessageEvent).data; if (typeof data === 'string') frames.push(JSON.parse(data) as Record<string, unknown>); else binary.push(Buffer.from(data as ArrayBuffer)); });
    ws.addEventListener('close', event => { closeCode = (event as CloseEvent).code; });
    await new Promise<void>(resolve => { ws.addEventListener('open', () => resolve()); ws.addEventListener('close', () => resolve()); ws.addEventListener('error', () => resolve()); });
    return { frames, binary, send: (frame: unknown) => ws.send(JSON.stringify(frame)), closeCode: () => closeCode };
  }

  it('streams a Console shell of the Worktree and sends its input raw', async () => {
    const stream = fakePaneStream();
    stream.setSeed(Buffer.from('SHELLSEED'));
    const prompts = fakePrompts();
    const { tmux } = fakeTmux(stream);
    const conn = await connectWorktree('?pane=%2', async () => [member], stream, tmux, { prompts: prompts.prompts });
    conn.send({ type: 'viewport', cols: 100, rows: 30, scrollback: 500 });
    await waitFor(() => conn.binary.length > 0);
    expect(conn.frames.find(frame => frame.type === 'size')).toEqual({ type: 'size', cols: 80, rows: 24 });
    expect(conn.binary[0]!.toString()).toBe('SHELLSEED');

    // a Console shell takes no mutation lock and no Ctrl+C routing — a lone Ctrl+C is literal
    conn.send({ type: 'input', data: encode('\x03') });
    await waitFor(() => stream.inputs.length > 0);
    expect([...stream.inputs[0]!]).toEqual([0x03]);
    // the wired-in prompts double proves the raw path never took the agent mutation lock or cancel
    expect(prompts.mutations()).toBe(0);
    expect(prompts.cancels()).toBe(0);
  });

  it('seeds a Console shell without a forced discovery scan', async () => {
    // the scanning lookup waits on and runs full rescans; a Place pane must resolve without it
    const stream = fakePaneStream();
    stream.setSeed(Buffer.from('SHELLSEED'));
    const { tmux } = fakeTmux(stream);
    let forced = 0;
    const conn = await connectWorktree('?pane=%2', async () => [member], stream, tmux, { forcedTarget: async () => { forced += 1; return undefined; } });
    conn.send({ type: 'viewport', cols: 100, rows: 30, scrollback: 500 });
    await waitFor(() => conn.binary.length > 0);
    expect(conn.binary[0]!.toString()).toBe('SHELLSEED');
    expect(forced).toBe(0);
  });

  it('refuses the live Agent\'s own pane on the Worktree path (it must use the Agent target)', async () => {
    // %1 is in the Worktree set but backs a live Agent, so raw unlocked writes must be refused
    const stream = fakePaneStream();
    const { tmux } = fakeTmux(stream);
    const agentPane = { paneId: '%1', sessionId: '$1', pid: 1, path: '/repo', command: 'claude', title: '', socket };
    const conn = await connectWorktree('?pane=%1', async () => [agentPane, member], stream, tmux, { target: async (id: string) => id === `${socket.fingerprint}:%1` ? { agent: agentOf('claude'), socket } : undefined });
    await waitFor(() => conn.closeCode() !== undefined);
    expect(conn.closeCode()).toBe(1008);
  });

  it('closes 1008 for a pane that is not in the Worktree set', async () => {
    const stream = fakePaneStream();
    const { tmux } = fakeTmux(stream);
    const conn = await connectWorktree('?pane=%99', async () => [member], stream, tmux);
    await waitFor(() => conn.closeCode() !== undefined);
    expect(conn.closeCode()).toBe(1008);
  });

  it('streams a Console shell at a directory-Project Place with no Agent', async () => {
    const stream = fakePaneStream();
    stream.setSeed(Buffer.from('NOTESSEED'));
    const { tmux } = fakeTmux(stream);
    const shell = { ...member, path: '/data/notes' };
    const placePanes = vi.fn(async () => [shell]);
    const conn = await connectWorktree('?pane=%2', placePanes, stream, tmux, { placeId: notesPlace.id });
    conn.send({ type: 'viewport', cols: 100, rows: 30, scrollback: 500 });
    await waitFor(() => conn.binary.length > 0);
    expect(conn.binary[0]!.toString()).toBe('NOTESSEED');
    expect(placePanes).toHaveBeenCalledWith(expect.objectContaining({ id: notesPlace.id, kind: 'directory' }));
  });

  it('streams a Console shell at a Scratch Place with no Agent', async () => {
    const stream = fakePaneStream();
    stream.setSeed(Buffer.from('SCRATCHSEED'));
    const { tmux } = fakeTmux(stream);
    const placePanes = vi.fn(async () => [{ ...member, path: '/home/me/scratch' }]);
    const conn = await connectWorktree('?pane=%2', placePanes, stream, tmux, { placeId: scratchPlace.id });
    conn.send({ type: 'viewport', cols: 100, rows: 30, scrollback: 500 });
    await waitFor(() => conn.binary.length > 0);
    expect(conn.binary[0]!.toString()).toBe('SCRATCHSEED');
    expect(placePanes).toHaveBeenCalledWith(scratchPlace);
  });

  it('closes 1008 for a Scratch folder the dashboard does not list', async () => {
    const stream = fakePaneStream();
    const { tmux } = fakeTmux(stream);
    const conn = await connectWorktree('?pane=%2', async () => [member], stream, tmux, { placeId: 'scratch:/etc' });
    await waitFor(() => conn.closeCode() !== undefined);
    expect(conn.closeCode()).toBe(1008);
  });

  it('closes 1008 when a Worktree target names no pane', async () => {
    const stream = fakePaneStream();
    const { tmux } = fakeTmux(stream);
    const conn = await connectWorktree('', async () => [member], stream, tmux);
    await waitFor(() => conn.closeCode() !== undefined);
    expect(conn.closeCode()).toBe(1008);
  });
});

describe('/ws/pane window-keyed Size claim', () => {
  it('shares one claim between two panes of the same window (keyed by window, not pane)', async () => {
    // Both panes resolve to window @7 (the fake client's windowId), so the two viewers share one
    // coordinator entry keyed by the window and release unpins exactly once — for the surviving
    // owner. Were the claim keyed by pane id (or the pane fallback used before windowKeyReady),
    // each socket would hold its own claim and unpin twice. This proves the /ws/pane handler keys
    // the Size claim by the resolved window id (app.ts INVARIANT), coverage carried over from the
    // retired /ws/logs socket test.
    const stream = fakePaneStream();
    const resizes: string[] = [];
    const unpins: string[] = [];
    const tmux = {
      size: async () => ({ cols: 80, rows: 24, clientLimit: { cols: 80, rows: 24 } }),
      resize: async (_s: unknown, pane: string) => { resizes.push(pane); return true; },
      unpinWindowSize: async (_s: unknown, pane: string) => { unpins.push(pane); return true; },
      sessionPaneIds: async () => ['%1', '%2'],
      captureWindow: async (_s: unknown, _p: string, _r: number, via: (depth: number) => Promise<string | undefined>) => {
        const text = await via(5_000);
        return text === undefined ? undefined : { text, older: false };
      }
    } as never;
    const panes: Record<string, string> = { 'agent-1': '%1', 'agent-2': '%2' };
    const target = async (id: string) => (panes[id] ? { agent: { ...agentOf('claude'), id, paneId: panes[id]! }, socket } : undefined);
    const discovery = {
      target,
      snapshotTarget: target,
      worktreesNow: () => []
    } as never;
    const control = { connect: () => true, active: () => true } as never;

    const port = await freePort();
    const tickets = new TicketStore();
    const app = await buildApp(
      testConfig({ publicOrigin: new URL(`http://127.0.0.1:${port}`), projects: [testProject({ id: 'proj' })] as never }),
      { auth, control, dashboardUpdates, discovery, tickets, paneStream: stream.provider, tmux } as never
    );
    await app.listen({ host: '127.0.0.1', port });

    const openViewport = async (id: string, cols: number, rows: number) => {
      const ticket = tickets.mint('session', 'pane', id).id;
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/pane/${id}`, ['rac', ticket]);
      ws.binaryType = 'arraybuffer';
      open.push({ app, ws });
      await new Promise<void>((resolve, reject) => { ws.addEventListener('open', () => resolve()); ws.addEventListener('error', () => reject(new Error('websocket failed to open'))); });
      ws.send(JSON.stringify({ type: 'viewport', cols, rows, scrollback: 500 }));
      return ws;
    };

    const first = await openViewport('agent-1', 100, 30);
    await waitFor(() => resizes.includes('%1'));
    const second = await openViewport('agent-2', 120, 40);
    await waitFor(() => resizes.includes('%2'));

    first.close();
    second.close();
    await waitFor(() => unpins.length >= 1);
    await new Promise(resolve => setTimeout(resolve, 100));

    // one window, one claim: exactly one unpin, for the window's surviving (latest) owner
    expect(unpins).toEqual(['%2']);
  });
});
