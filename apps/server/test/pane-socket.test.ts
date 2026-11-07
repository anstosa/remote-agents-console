import { createServer } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { TicketStore } from '../src/auth/tickets.js';
import { codexAdapter } from '../src/adapters/codex.js';
import type { PaneActivitySubscriber, PaneClient, PaneStreamProvider } from '../src/tmux/control.js';
import { testConfig, testProject } from './helpers/config.js';
import { openPaneSocket } from './helpers/pane-socket.js';

// Drive the real /ws/panes handler over a real WebSocket, with a fake pane stream (so no
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
const agentOf = (kind: string) => ({ id: 'agent-1', pane: { paneId: '%1', sessionId: 'sockfp:$1', socketFingerprint: 'sockfp' }, home: '/repo', title: 'Ready', kind, attention: 'finished' });
const discoveryOf = (kind: string) => {
  const target = async (id: string) => (id === 'agent-1' ? { agent: agentOf(kind), socket } : undefined);
  // the project proxy inspects every WS upgrade; no worktrees means it passes ours to Fastify
  return { target, snapshotTarget: target, worktreesNow: () => [] } as never;
};

// a control client whose activity and bytes the test drives, recording what it was asked to
// type and how deep it seeded
function fakePaneStream() {
  let subscriber: PaneActivitySubscriber | undefined;
  // each subscribed pane's subscriber, for streams of several panes at once
  const subscribers = new Map<string, PaneActivitySubscriber>();
  const paneSeeds = new Map<string, Buffer>();
  const inputs: Buffer[] = [];
  const seedDepths: number[] = [];
  let seedBytes: Buffer = Buffer.from('SEED');
  let seedOutput: Buffer | undefined;
  let seedHandler: ((deliver: (bytes: Buffer) => boolean) => Promise<boolean>) | undefined;
  let captureText = 'idle';
  let assistantMessage: string | undefined;
  // windowId is the pane socket's liveness signal (a gone pane has none), so a closed pane is
  // simulated by clearing it, not by failing size()
  let windowId: string | undefined = '@7';
  let inputAccepted = true;
  const client: PaneClient = {
    subscribe(pane, sub) { subscriber = sub; subscribers.set(pane, sub); return () => { if (subscribers.get(pane) === sub) subscribers.delete(pane); }; },
    capture: async () => captureText,
    windowId: async () => windowId,
    sendInput: async (_pane, bytes) => { inputs.push(Buffer.from(bytes)); return inputAccepted; },
    // model output immediately after the snapshot reply in the same parser turn
    seed: async (pane, depth, deliver) => {
      seedDepths.push(depth);
      // let lifecycle cases hold or refuse the snapshot boundary
      if (seedHandler !== undefined) return seedHandler(deliver);
      const delivered = deliver(paneSeeds.get(pane) ?? seedBytes);
      // a live redraw can follow the capture before an awaiting caller resumes
      if (seedOutput !== undefined) subscriber?.onOutput?.(seedOutput);
      return delivered;
    }
  };
  const provider: PaneStreamProvider = { get: () => client, openPaneKeys: () => new Set(), closeAll: () => {} };
  return {
    provider,
    inputs,
    seedDepths,
    // observe readiness before sending pre-viewport stream events
    subscribed: () => subscriber !== undefined,
    setSeed: (value: Buffer) => { seedBytes = value; },
    setPaneSeed: (pane: string, value: Buffer) => { paneSeeds.set(pane, value); },
    subscribedPanes: () => [...subscribers.keys()],
    outputTo: (pane: string, bytes: Buffer) => subscribers.get(pane)?.onOutput?.(bytes),
    // script the first live redraw at the capture boundary
    setSeedOutput: (value: Buffer) => { seedOutput = value; },
    // control deferred capture replies and failures without changing transport behavior
    setSeedHandler: (value: (deliver: (bytes: Buffer) => boolean) => Promise<boolean>) => { seedHandler = value; },
    setWindowId: (value: string | undefined) => { windowId = value; },
    refuseInput: () => { inputAccepted = false; },
    setCapture: (value: string) => { captureText = value; },
    setAssistantMessage: (value: string | undefined) => { assistantMessage = value; },
    assistantMessage: () => assistantMessage,
    output: (bytes: Buffer) => subscriber?.onOutput?.(bytes),
    fire: (event: 'onReseed' | 'onResize') => subscriber?.[event]?.(),
    // a layout change reaches every pane of the session
    fireAll: (event: 'onReseed' | 'onResize') => { for (const each of subscribers.values()) each[event]?.(); },
    exit: (reason: string) => subscriber?.onExit?.(reason),
    activity: () => subscriber?.onActivity?.(),
    clipboard: (text: string) => subscriber?.onClipboard?.(text),
    foreground: (command: string) => subscriber?.onForeground?.(command)
  };
}

// a fake tmux adapter: enough of the surface a pane stream touches, with settable size and a
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
      // preserve unwatched fixture input through the durable activity boundary
      withExternalActivity: async (_id: string, effect: () => unknown | Promise<unknown>) => await effect(),
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

type Deps = { kind?: string; controlActive?: () => boolean; controlConnect?: () => boolean; tmux?: unknown; prompts?: unknown; pane?: string; discovery?: unknown; sendOnOpen?: Record<string, unknown> };

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

// a listening app and a browser's pane socket on it
async function serve(paneStream: PaneStreamProvider, deps: Deps = {}) {
  const kind = deps.kind ?? 'claude';
  const control = { connect: deps.controlConnect ?? (() => true), active: deps.controlActive ?? (() => true) } as never;
  const port = await freePort();
  const tickets = new TicketStore();
  const app = await buildApp(
    testConfig({ publicOrigin: new URL(`http://127.0.0.1:${port}`), projects: [testProject({ id: 'proj' })] as never }),
    { auth, control, dashboardUpdates, discovery: deps.discovery ?? discoveryOf(kind), tickets, paneStream, ...(deps.tmux === undefined ? {} : { tmux: deps.tmux }), ...(deps.prompts === undefined ? {} : { prompts: deps.prompts }) } as never
  );
  await app.listen({ host: '127.0.0.1', port });
  const socket = await openPaneSocket(port, tickets);
  open.push({ app, ws: socket.ws });
  return socket;
}

async function connect(paneStream: PaneStreamProvider, deps: Deps = {}) {
  const socket = await serve(paneStream, deps);
  // Optionally send a frame right behind the `open` — i.e. while the server handler is still
  // mid-setup — to exercise the early-frame buffering.
  const conn = socket.stream(1, 'agent-1', deps.pane, deps.sendOnOpen);
  const viewport = (cols = 100, rows = 30, scrollback = 500) => conn.send({ type: 'viewport', cols, rows, scrollback });
  return { ...conn, socket, viewport };
}

const encode = (data: string) => Buffer.from(data, 'utf8').toString('base64url');

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('pane socket did not reach the expected state');
}

describe('pane stream seed and size', () => {
  // an early tmux recovery must wait for a usable browser grid
  it('defers a reseed before the first viewport until size is sent', async () => {
    const stream = fakePaneStream();
    const { tmux } = fakeTmux(stream);
    const conn = await connect(stream.provider, { tmux });
    await waitFor(stream.subscribed);
    stream.fire('onReseed');
    await delay(20);

    expect(stream.seedDepths).toEqual([]);
    expect(conn.binary).toEqual([]);
    conn.viewport();
    await waitFor(() => conn.binary.length > 0);
    expect(conn.order.indexOf('frame:size')).toBeGreaterThanOrEqual(0);
    expect(conn.order.indexOf('frame:size')).toBeLessThan(conn.order.indexOf('binary'));
    expect(stream.seedDepths).toHaveLength(1);
  });

  // reconnect when resizing succeeds but its actual grid cannot be reported
  it('refuses to seed when the post-resize size read fails', async () => {
    const stream = fakePaneStream();
    const size = vi.fn().mockResolvedValueOnce({ cols: 80, rows: 24, clientLimit: { cols: 80, rows: 24 } }).mockResolvedValue(undefined);
    const { tmux, resizes } = fakeTmux(stream, { size });
    const conn = await connect(stream.provider, { tmux });
    conn.viewport();
    await waitFor(() => conn.closeCode() !== undefined || conn.binary.length > 0);

    expect(resizes).toContainEqual({ cols: 80, rows: 24 });
    expect(conn.closeCode()).toBe(1011);
    expect(conn.binary).toEqual([]);
    expect(stream.seedDepths).toEqual([]);
  });

  // authority may be revoked while the tmux capture is still pending
  it('refuses deferred seed delivery after control is lost', async () => {
    const stream = fakePaneStream();
    let active = true;
    let pending: { deliver: (bytes: Buffer) => boolean; resolve: (delivered: boolean) => void } | undefined;
    // hold the snapshot until the control lease changes
    stream.setSeedHandler(deliver => new Promise(resolve => { pending = { deliver, resolve }; }));
    const { tmux } = fakeTmux(stream);
    const conn = await connect(stream.provider, { tmux, controlActive: () => active });
    conn.viewport();
    await waitFor(() => pending !== undefined);
    active = false;

    expect(pending!.deliver(Buffer.from('REVOKED-SEED'))).toBe(false);
    pending!.resolve(false);
    await waitFor(() => conn.closeCode() !== undefined);
    stream.output(Buffer.from('REVOKED-LIVE'));
    await delay(20);
    expect(conn.binary).toEqual([]);
    expect(conn.closeCode()).toBe(1008);
  });

  // closing a viewer must retire a capture without replacing its close reason
  it('refuses deferred seed delivery after the viewer closes', async () => {
    const stream = fakePaneStream();
    let pending: { deliver: (bytes: Buffer) => boolean; resolve: (delivered: boolean) => void } | undefined;
    // retain the capture callback beyond the client connection lifetime
    stream.setSeedHandler(deliver => new Promise(resolve => { pending = { deliver, resolve }; }));
    const { tmux } = fakeTmux(stream);
    const conn = await connect(stream.provider, { tmux });
    conn.viewport();
    await waitFor(() => pending !== undefined);
    conn.close();
    await delay(50);

    expect(pending!.deliver(Buffer.from('CLOSED-SEED'))).toBe(false);
    pending!.resolve(false);
    stream.output(Buffer.from('CLOSED-LIVE'));
    await delay(20);
    expect(conn.binary).toEqual([]);
    // a stream the browser closed gets no `closed` back, and the socket stays up
    expect(conn.closeCode()).toBeUndefined();
    expect(conn.socket.unknown).toEqual([]);
  });

  // never lose the first restored transcript repaint behind the snapshot gate
  it('sends size, seed and an immediate post-capture redraw in order', async () => {
    const stream = fakePaneStream();
    stream.setSeed(Buffer.from('OPENING-SESSION'));
    stream.setSeedOutput(Buffer.from('RESTORED-HISTORY'));
    const { tmux } = fakeTmux(stream);
    const conn = await connect(stream.provider, { tmux });
    conn.viewport(100, 30);

    await waitFor(() => conn.binary.length === 2);
    expect(conn.binary.map(bytes => bytes.toString())).toEqual(['OPENING-SESSION', 'RESTORED-HISTORY']);
    const sizeAt = conn.order.indexOf('frame:size');
    expect(sizeAt).toBeGreaterThanOrEqual(0);
    expect(conn.order.slice(sizeAt).filter(event => event === 'frame:size' || event === 'binary')).toEqual(['frame:size', 'binary', 'binary']);
  });

  // never declare a baseline-less connection live after an unsuccessful capture
  it.each(['refused', 'rejected'])('reconnects when initial seed delivery is %s', async outcome => {
    const stream = fakePaneStream();
    stream.setSeedHandler(async () => {
      // exercise both the failed reply and rejected command paths
      if (outcome === 'rejected') throw new Error('capture failed');
      return false;
    });
    const { tmux } = fakeTmux(stream);
    const conn = await connect(stream.provider, { tmux });
    conn.viewport();

    await waitFor(() => conn.closeCode() !== undefined);
    expect(conn.closeCode()).toBe(1011);
    expect(conn.binary).toEqual([]);
  });

  // a superseded capture must not reopen the live gate while its replacement is pending
  it('ignores old seed delivery and failure after a newer reseed starts', async () => {
    const stream = fakePaneStream();
    const pending: Array<{ deliver: (bytes: Buffer) => boolean; resolve: (delivered: boolean) => void }> = [];
    stream.setSeedHandler(deliver => new Promise(resolve => { pending.push({ deliver, resolve }); }));
    const { tmux } = fakeTmux(stream);
    const conn = await connect(stream.provider, { tmux });
    conn.viewport();
    await waitFor(() => pending.length === 1);
    stream.fire('onReseed');
    await waitFor(() => pending.length === 2);

    expect(pending[0]!.deliver(Buffer.from('STALE-SEED'))).toBe(false);
    pending[0]!.resolve(false);
    // let the old failure settle while the replacement still owns the live gate
    await delay(20);
    stream.output(Buffer.from('PRE-NEW-SEED'));
    expect(pending[1]!.deliver(Buffer.from('NEW-SEED'))).toBe(true);
    stream.output(Buffer.from('RESTORED-HISTORY'));
    pending[1]!.resolve(true);

    await waitFor(() => conn.binary.length === 2);
    expect(conn.binary.map(bytes => bytes.toString())).toEqual(['NEW-SEED', 'RESTORED-HISTORY']);
    expect(conn.closeCode()).toBeUndefined();
  });

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
    const conn = await connect(stream.provider, { tmux, pane: '%99' });
    await waitFor(() => conn.closeCode() !== undefined);
    expect(conn.closeCode()).toBe(1008);
  });
});

describe('pane stream clipboard', () => {
  it('forwards a pane copy to the browser as a clipboard frame', async () => {
    const stream = fakePaneStream();
    const { tmux } = fakeTmux(stream);
    const conn = await connect(stream.provider, { tmux });
    await waitFor(stream.subscribed);
    stream.clipboard('yanked line\n');
    await waitFor(() => conn.frames.some(frame => frame.type === 'clipboard'));
    expect(conn.frames.find(frame => frame.type === 'clipboard')).toEqual({ type: 'clipboard', text: 'yanked line\n' });
  });
});

describe('pane stream foreground', () => {
  it("forwards the pane's foreground command as a foreground frame", async () => {
    const stream = fakePaneStream();
    const { tmux } = fakeTmux(stream);
    const conn = await connect(stream.provider, { tmux });
    await waitFor(stream.subscribed);
    stream.foreground('nvim');
    await waitFor(() => conn.frames.some(frame => frame.type === 'foreground'));
    expect(conn.frames.find(frame => frame.type === 'foreground')).toEqual({ type: 'foreground', command: 'nvim' });
  });
});

describe('pane stream input', () => {
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

  // preserve durable authority after moving input into multiplexed pane sessions
  it.each(['hi', '\x03'])('waits for durable external activity before agent input %j', async input => {
    const stream = fakePaneStream();
    const { tmux } = fakeTmux(stream);
    const prompts = fakePrompts();
    let releaseActivity!: () => void;
    // hold the durable stamp ahead of either possible pane effect
    const ready = new Promise<void>(resolve => { releaseActivity = resolve; });
    // model the prompt service's durable-before-effect boundary
    const activity = vi.fn(async (_id: string, effect: () => unknown | Promise<unknown>) => { await ready; return await effect(); });
    Object.assign(prompts.prompts, { withExternalActivity: activity });
    const conn = await connect(stream.provider, { tmux, prompts: prompts.prompts });
    conn.send({ type: 'input', data: encode(input) });
    await waitFor(() => activity.mock.calls.length === 1);
    expect(activity.mock.calls[0]![0]).toBe('agent-1');
    expect(stream.inputs).toHaveLength(0);
    expect(prompts.cancels()).toBe(0);
    expect(prompts.releases()).toBe(0);
    releaseActivity();
    await waitFor(() => prompts.releases() === 1);
    expect(stream.inputs.map(bytes => bytes.toString('utf8'))).toEqual(input === 'hi' ? ['hi'] : []);
    expect(prompts.cancels()).toBe(input === '\x03' ? 1 : 0);
  });

  // a failed durable stamp must not type or cancel an agent turn
  it.each(['hi', '\x03'])('fails closed when external activity cannot be recorded for %j', async input => {
    const stream = fakePaneStream();
    const { tmux } = fakeTmux(stream);
    const prompts = fakePrompts();
    // reject before the supplied effect can run
    const activity = vi.fn(async () => { throw new Error('activity store unavailable'); });
    Object.assign(prompts.prompts, { withExternalActivity: activity });
    const conn = await connect(stream.provider, { tmux, prompts: prompts.prompts });
    conn.send({ type: 'input', data: encode(input) });
    await waitFor(() => conn.closeCode() !== undefined);
    expect(conn.closeCode()).toBe(1011);
    expect(activity).toHaveBeenCalledTimes(1);
    expect(stream.inputs).toHaveLength(0);
    expect(prompts.cancels()).toBe(0);
    expect(prompts.releases()).toBe(1);
  });

  it('streams a sibling session pane and sends its input raw, without the mutation lock or Ctrl+C routing', async () => {
    // %2 is a member of the Agent's session (sessionPaneIds) but not the Agent's own pane (%1)
    const stream = fakePaneStream();
    const { tmux } = fakeTmux(stream);
    const prompts = fakePrompts();
    const conn = await connect(stream.provider, { tmux, prompts: prompts.prompts, pane: '%2' });
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

describe('pane stream flow control', () => {
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
    stream.setSeedOutput(Buffer.from('RECOVERY-REDRAW'));
    conn.send({ type: 'ack', bytes: 8 * 64 * 1024 });
    await waitFor(() => conn.frames.some(frame => frame.type === 'reseed'));
    await waitFor(() => conn.binary.some(buffer => buffer.toString() === 'RECOVERY-SEED'));
    await waitFor(() => conn.binary.some(buffer => buffer.toString() === 'RECOVERY-REDRAW'));
  });
});

describe('pane stream derive (Codex)', () => {
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
    expect(conn.frames.find(frame => (frame.question as { text?: string })?.text === 'Which approach?')?.question).toMatchObject({ choices: ['Small', 'Other'], field: { kind: 'choice', choices: ['Small', 'Other'] }, pane: { selectedIndex: 0 } });
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

    // the pane prints a Codex-shaped choice list; the next frame carries the question in its
    // Transport-neutral shape: the choices as its answer field
    stream.setCapture('CHOOSE an option');
    stream.activity();
    await waitFor(() => conn.frames.some(frame => frame.type === 'question' && frame.question !== null));
    expect(conn.frames.find(frame => frame.type === 'question' && frame.question !== null)!.question).toEqual({ ...question, field: { kind: 'choice', choices: ['1. keep', '2. drop'] } });

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

describe('pane stream lifecycle', () => {
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

  it('negotiates permessage-deflate, so pane seeds cross the network compressed', async () => {
    const stream = fakePaneStream();
    const { tmux } = fakeTmux(stream);
    const socket = await serve(stream.provider, { tmux });
    expect(socket.ws.extensions).toContain('permessage-deflate');
  });

  it('closes 1008 for a browser without the control session', async () => {
    const stream = fakePaneStream();
    const { tmux } = fakeTmux(stream);
    const conn = await connect(stream.provider, { tmux, controlConnect: () => false });
    await waitFor(() => conn.closeCode() !== undefined);
    expect(conn.closeCode()).toBe(1008);
  });
});

describe('pane stream Worktree target', () => {
  const worktree = { id: 'cora', projectId: 'proj', label: 'Cora', path: '/repo', identity: '/repo', available: true, pinned: false, main: false, detached: false, locked: false, push: { label: 'p', prompt: '$p' } };
  const member = { paneId: '%2', sessionId: '$1', pid: 2, path: '/repo', command: 'zsh', role: 'shell', title: '', socket };
  const notesPlace = { id: 'notes:/data/notes', kind: 'directory', projectId: 'notes', label: 'Notes', home: '/data/notes', hostPath: '/host/notes' };
  const scratchPlace = { id: 'scratch:/home/me/scratch', kind: 'scratch', projectId: 'scratch', label: '~ Scratch', home: '/home/me/scratch' };

  // drive a stream against a Worktree target (by default discovery.target misses, so the handler
  // falls to the Worktree branch and checks membership against launch.placePanes). `target`
  // can resolve a live Agent (so the handler refuses that pane) and `prompts` is wired in so the
  // no-lock assertions on a raw pane are load-bearing. `forcedTarget` stands in for the
  // scanning lookup alone, when a test must tell it apart from the snapshot one.
  async function connectWorktree(pane: string | undefined, placePanes: () => Promise<unknown[]>, stream: ReturnType<typeof fakePaneStream>, tmuxOverride: unknown, deps: { target?: (id: string) => Promise<unknown>; forcedTarget?: (id: string) => Promise<unknown>; prompts?: unknown; placeId?: string } = {}) {
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
    const socket = await openPaneSocket(port, tickets);
    open.push({ app, ws: socket.ws });
    return socket.stream(1, placeId, pane);
  }

  it('streams a Console shell of the Worktree and sends its input raw', async () => {
    const stream = fakePaneStream();
    stream.setSeed(Buffer.from('SHELLSEED'));
    const prompts = fakePrompts();
    const { tmux } = fakeTmux(stream);
    const conn = await connectWorktree('%2', async () => [member], stream, tmux, { prompts: prompts.prompts });
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
    const conn = await connectWorktree('%2', async () => [member], stream, tmux, { forcedTarget: async () => { forced += 1; return undefined; } });
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
    const conn = await connectWorktree('%1', async () => [agentPane, member], stream, tmux, { target: async (id: string) => id === `${socket.fingerprint}:%1` ? { agent: agentOf('claude'), socket } : undefined });
    await waitFor(() => conn.closeCode() !== undefined);
    expect(conn.closeCode()).toBe(1008);
  });

  it('closes 1008 for a pane that is not in the Worktree set', async () => {
    const stream = fakePaneStream();
    const { tmux } = fakeTmux(stream);
    const conn = await connectWorktree('%99', async () => [member], stream, tmux);
    await waitFor(() => conn.closeCode() !== undefined);
    expect(conn.closeCode()).toBe(1008);
  });

  it('streams a Console shell at a directory-Project Place with no Agent', async () => {
    const stream = fakePaneStream();
    stream.setSeed(Buffer.from('NOTESSEED'));
    const { tmux } = fakeTmux(stream);
    const shell = { ...member, path: '/data/notes' };
    const placePanes = vi.fn(async () => [shell]);
    const conn = await connectWorktree('%2', placePanes, stream, tmux, { placeId: notesPlace.id });
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
    const conn = await connectWorktree('%2', placePanes, stream, tmux, { placeId: scratchPlace.id });
    conn.send({ type: 'viewport', cols: 100, rows: 30, scrollback: 500 });
    await waitFor(() => conn.binary.length > 0);
    expect(conn.binary[0]!.toString()).toBe('SCRATCHSEED');
    expect(placePanes).toHaveBeenCalledWith(scratchPlace);
  });

  it('closes 1008 for a Scratch folder the dashboard does not list', async () => {
    const stream = fakePaneStream();
    const { tmux } = fakeTmux(stream);
    const conn = await connectWorktree('%2', async () => [member], stream, tmux, { placeId: 'scratch:/etc' });
    await waitFor(() => conn.closeCode() !== undefined);
    expect(conn.closeCode()).toBe(1008);
  });

  it('closes 1008 when a Worktree target names no pane', async () => {
    const stream = fakePaneStream();
    const { tmux } = fakeTmux(stream);
    const conn = await connectWorktree(undefined, async () => [member], stream, tmux);
    await waitFor(() => conn.closeCode() !== undefined);
    expect(conn.closeCode()).toBe(1008);
  });
});

describe('pane stream closed during setup', () => {
  // the browser flicks past a Workspace: its stream closes while the viewport it sent is still
  // waiting on the window id, which must then not size the window for a viewer that is gone
  it('takes no Size claim for a viewport left waiting on the window id', async () => {
    const stream = fakePaneStream();
    const client = stream.provider.get(socket as never, '$1');
    const windowId = client.windowId.bind(client);
    let resolveWindow!: () => void;
    const windowHeld = new Promise<void>(resolve => { resolveWindow = resolve; });
    client.windowId = async pane => { await windowHeld; return await windowId(pane); };
    const { tmux, resizes } = fakeTmux(stream);
    const conn = await connect(stream.provider, { tmux });
    conn.viewport();
    await waitFor(stream.subscribed);
    conn.close();
    await delay(50);
    resolveWindow();
    await delay(50);

    expect(resizes).toEqual([]);
    expect(conn.binary).toEqual([]);
  });
});

describe('pane stream window-keyed Size claim', () => {
  it('shares one claim between two panes of the same window (keyed by window, not pane)', async () => {
    // Both panes resolve to window @7 (the fake client's windowId), so the two viewers share one
    // coordinator entry keyed by the window and release (with no grace here) unpins exactly once —
    // for the window. Were the claim keyed by pane id (or the pane fallback used before
    // windowKeyReady), each stream would hold its own claim and unpin twice. This proves the
    // pane stream keys the Size claim by the resolved window id (pane-session.ts INVARIANT), coverage
    // carried over from the retired /ws/logs socket test.
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
    const target = async (id: string) => (panes[id] ? { agent: { ...agentOf('claude'), id, pane: { ...agentOf('claude').pane, paneId: panes[id]! } }, socket } : undefined);
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
      { auth, control, dashboardUpdates, discovery, tickets, paneStream: stream.provider, tmux, paneViewportGraceMs: 0 } as never
    );
    await app.listen({ host: '127.0.0.1', port });

    // both panes stream over one socket, each stream its own Size claim user
    const socket = await openPaneSocket(port, tickets);
    open.push({ app, ws: socket.ws });
    const openViewport = (stream: number, id: string, cols: number, rows: number) => socket.stream(stream, id, undefined, { type: 'viewport', cols, rows, scrollback: 500 });

    const first = openViewport(1, 'agent-1', 100, 30);
    await waitFor(() => resizes.includes('%1'));
    const second = openViewport(2, 'agent-2', 120, 40);
    await waitFor(() => resizes.includes('%2'));

    first.close();
    second.close();
    await waitFor(() => unpins.length >= 1);
    await new Promise(resolve => setTimeout(resolve, 100));

    // one window, one claim: exactly one unpin, by the window id so a dead pane cannot strand it
    expect(unpins).toEqual(['@7']);
  });
});

describe('pane stream timing frame', () => {
  it('ignores a timing frame from an older client without closing the stream', async () => {
    const stream = fakePaneStream();
    const { tmux } = fakeTmux(stream);
    const conn = await connect(stream.provider, { tmux });
    conn.viewport();
    await waitFor(() => conn.binary.length > 0);
    conn.send({ type: 'timing', attempt: 'initial', marks: { open: 30 } });
    conn.send({ type: 'input', data: encode('ok') });
    await waitFor(() => stream.inputs.length > 0);
    expect(conn.closeCode()).toBeUndefined();
  });
});

describe('pane socket multiplexing', () => {
  // the Agent's own pane (%1) and a sibling pane of its session (%2), on one socket
  const twoStreams = async (deps: Deps = {}) => {
    const stream = fakePaneStream();
    stream.setPaneSeed('%1', Buffer.from('SEED-ONE'));
    stream.setPaneSeed('%2', Buffer.from('SEED-TWO'));
    const { tmux } = fakeTmux(stream);
    const socket = await serve(stream.provider, { tmux, prompts: fakePrompts().prompts, ...deps });
    const viewport = { type: 'viewport', cols: 100, rows: 30, scrollback: 500 };
    const one = socket.stream(1, 'agent-1', undefined, viewport);
    const two = socket.stream(2, 'agent-1', '%2', viewport);
    await waitFor(() => one.binary.length > 0 && two.binary.length > 0);
    return { stream, socket, one, two };
  };

  it('interleaves two streams on one socket, each with its own frames and bytes', async () => {
    const { stream, one, two } = await twoStreams();
    expect(one.binary.map(String)).toEqual(['SEED-ONE']);
    expect(two.binary.map(String)).toEqual(['SEED-TWO']);
    expect(one.order.indexOf('frame:size')).toBeLessThan(one.order.indexOf('binary'));
    expect(two.order.indexOf('frame:size')).toBeLessThan(two.order.indexOf('binary'));

    stream.outputTo('%2', Buffer.from('to-two-a'));
    stream.outputTo('%1', Buffer.from('to-one'));
    stream.outputTo('%2', Buffer.from('to-two-b'));
    await waitFor(() => one.binary.length === 2 && two.binary.length === 3);
    expect(one.binary.map(String)).toEqual(['SEED-ONE', 'to-one']);
    expect(two.binary.map(String)).toEqual(['SEED-TWO', 'to-two-a', 'to-two-b']);

    // input routes by stream id: the sibling pane takes its bytes raw
    two.send({ type: 'input', data: encode('x') });
    await waitFor(() => stream.inputs.length > 0);
    expect(stream.inputs.map(String)).toEqual(['x']);
  });

  it('closing one stream releases it and leaves the other streaming', async () => {
    const { stream, socket, one, two } = await twoStreams();
    one.close();
    await waitFor(() => !stream.subscribedPanes().includes('%1'));
    stream.outputTo('%1', Buffer.from('gone'));
    stream.outputTo('%2', Buffer.from('still'));
    await waitFor(() => two.binary.length === 2);
    expect(two.binary.map(String)).toEqual(['SEED-TWO', 'still']);
    expect(one.binary.map(String)).toEqual(['SEED-ONE']);
    expect(one.closeCode()).toBeUndefined();
    expect(socket.closeCode()).toBeUndefined();
  });

  it('ends only the stream the server closes', async () => {
    const { stream, socket, one, two } = await twoStreams();
    // a frame no stream understands is that stream's policy violation, not the socket's
    one.send({ type: 'bogus' });
    await waitFor(() => one.closeCode() !== undefined);
    expect(one.closeCode()).toBe(1008);
    stream.outputTo('%2', Buffer.from('still'));
    await waitFor(() => two.binary.length === 2);
    expect(two.closeCode()).toBeUndefined();
    expect(socket.closeCode()).toBeUndefined();
  });

  it('refuses a pane outside the Agent\'s session on its stream alone', async () => {
    const { stream, socket, one } = await twoStreams();
    const outside = socket.stream(3, 'agent-1', '%99');
    await waitFor(() => outside.closeCode() !== undefined);
    expect(outside.closeCode()).toBe(1008);
    expect(outside.binary).toEqual([]);
    stream.outputTo('%1', Buffer.from('still'));
    await waitFor(() => one.binary.length === 2);
    expect(socket.closeCode()).toBeUndefined();
  });

  it('authorizes every open against the browser session holding control', async () => {
    let connected = true;
    const { socket, one } = await twoStreams({ controlConnect: () => connected });
    connected = false;
    const refused = socket.stream(3, 'agent-1');
    await waitFor(() => refused.closeCode() !== undefined);
    expect(refused.closeCode()).toBe(1008);
    expect(one.closeCode()).toBeUndefined();
  });

  it('refuses an unknown target and a malformed open on their streams', async () => {
    const { socket, one } = await twoStreams();
    const unknown = socket.stream(3, 'agent-404', undefined);
    const nameless = socket.stream(4, '', undefined);
    socket.send({ type: 'open', stream: 5, target: 'agent-1', pane: 2 });
    await waitFor(() => unknown.closeCode() !== undefined && nameless.closeCode() !== undefined);
    expect(unknown.closeCode()).toBe(1008);
    expect(nameless.closeCode()).toBe(1008);
    expect(one.closeCode()).toBeUndefined();
    expect(socket.closeCode()).toBeUndefined();
  });

  it('ends a stream whose id is opened again, and refuses the repeat', async () => {
    const { stream, socket, one, two } = await twoStreams();
    const again = socket.stream(1, 'agent-1');
    await waitFor(() => again.closeCode() !== undefined);
    expect(again.closeCode()).toBe(1008);
    await waitFor(() => !stream.subscribedPanes().includes('%1'));
    expect(two.closeCode()).toBeUndefined();
  });

  // split Terminal panes share one tmux window, so one Size claim, and a switch opens their
  // streams in the same tick: neither may be torn down for not being the claim's latest viewer
  it('streams two panes of one window opened together, through a layout change', async () => {
    const stream = fakePaneStream();
    stream.setPaneSeed('%1', Buffer.from('SEED-ONE'));
    stream.setPaneSeed('%2', Buffer.from('SEED-TWO'));
    const { tmux, resizes } = fakeTmux(stream);
    const socket = await serve(stream.provider, { tmux, prompts: fakePrompts().prompts });
    const one = socket.stream(1, 'agent-1', undefined, { type: 'viewport', cols: 100, rows: 30, scrollback: 500 });
    const two = socket.stream(2, 'agent-1', '%2', { type: 'viewport', cols: 90, rows: 20, scrollback: 500 });
    await waitFor(() => one.binary.length > 0 && two.binary.length > 0);
    // the driver's resize re-lays out the window under the other pane
    stream.fireAll('onResize');
    await delay(100);
    one.send({ type: 'viewport', cols: 110, rows: 32, scrollback: 500 });
    await delay(100);
    expect(one.closeCode()).toBeUndefined();
    expect(two.closeCode()).toBeUndefined();
    expect(one.frames.some(frame => frame.type === 'size')).toBe(true);
    expect(two.frames.some(frame => frame.type === 'size')).toBe(true);
    expect(resizes.length).toBeGreaterThan(0);
  });

  it('caps one socket at 64 streams', async () => {
    const stream = fakePaneStream();
    const { tmux } = fakeTmux(stream);
    const socket = await serve(stream.provider, { tmux });
    const streams = Array.from({ length: 64 }, (_, index) => socket.stream(index + 1, 'agent-1'));
    const over = socket.stream(65, 'agent-1');
    await waitFor(() => over.closeCode() !== undefined);
    expect(over.closeCode()).toBe(1008);
    await delay(50);
    expect(streams.every(probe => probe.closeCode() === undefined)).toBe(true);
    // a closed stream frees its slot
    streams[0]!.close();
    await delay(50);
    const freed = socket.stream(66, 'agent-1', undefined, { type: 'viewport', cols: 100, rows: 30, scrollback: 500 });
    await waitFor(() => freed.binary.length > 0);
    expect(freed.closeCode()).toBeUndefined();
  });

  it('keeps the slot of a stream closed mid-setup until its setup settles', async () => {
    // open-then-close must not pile up target lookups past the cap
    const stream = fakePaneStream();
    const { tmux } = fakeTmux(stream);
    let lookups = 0;
    let finish!: () => void;
    const finished = new Promise<void>(resolve => { finish = resolve; });
    const slowTarget = async (id: string) => { lookups += 1; await finished; return id === 'agent-1' ? { agent: agentOf('claude'), socket } : undefined; };
    const socketConn = await serve(stream.provider, { tmux, discovery: { target: slowTarget, snapshotTarget: slowTarget, worktreesNow: () => [] } });
    const churn = Array.from({ length: 64 }, (_, index) => { const probe = socketConn.stream(index + 1, 'agent-1'); probe.close(); return probe; });
    const over = socketConn.stream(65, 'agent-1');
    await waitFor(() => over.closeCode() !== undefined);
    expect(over.closeCode()).toBe(1008);
    expect(lookups).toBe(64);
    expect(churn.every(probe => probe.closeCode() === undefined)).toBe(true);

    // once their lookups settle, the slots are free again
    finish();
    await delay(50);
    const after = socketConn.stream(66, 'agent-1', undefined, { type: 'viewport', cols: 100, rows: 30, scrollback: 500 });
    await waitFor(() => after.binary.length > 0);
    expect(after.closeCode()).toBeUndefined();
  });

  it.each([
    ['a non-JSON frame', 'not json'],
    ['a frame without a stream id', JSON.stringify({ type: 'viewport', cols: 100, rows: 30 })],
    ['a fractional stream id', JSON.stringify({ type: 'close', stream: 1.5 })],
    ['a stream id past 32 bits', JSON.stringify({ type: 'close', stream: 2 ** 32 })],
    ['a binary frame', Buffer.from('raw')]
  ])('closes the whole socket 1008 on %s', async (_label, data) => {
    const { socket, one, two } = await twoStreams();
    socket.sendRaw(data);
    await waitFor(() => socket.closeCode() !== undefined);
    expect(socket.closeCode()).toBe(1008);
    expect(one.closeCode()).toBe(1008);
    expect(two.closeCode()).toBe(1008);
  });

  it('ignores a frame for a stream that already ended', async () => {
    const { socket, one, two } = await twoStreams();
    one.close();
    one.send({ type: 'input', data: encode('late') });
    socket.send({ type: 'ack', bytes: 4, stream: 9 });
    await delay(50);
    expect(socket.closeCode()).toBeUndefined();
    expect(two.closeCode()).toBeUndefined();
  });

  it('closes the socket 1008 and every stream on it once control is lost', async () => {
    let active = true;
    const { socket } = await twoStreams({ controlActive: () => active });
    active = false;
    await waitFor(() => socket.closeCode() !== undefined);
    expect(socket.closeCode()).toBe(1008);
  });
});
