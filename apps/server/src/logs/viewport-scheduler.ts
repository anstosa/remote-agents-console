export type ViewportRequest = { cols: number; rows: number; history: number; onFailure?: () => void };
export type PaneViewport = { cols: number; rows: number };
// clientLimit: the largest pane size every tmux client attached to the pane's
// session can display; absent when nothing is attached. window: the whole window the pane
// sits in, taken to be the pane alone when absent
export type PaneGeometry = PaneViewport & { clientLimit?: PaneViewport; window?: PaneViewport };

export class LatestViewportScheduler {
  private version = 0;
  private queue = Promise.resolve();

  constructor(
    private readonly resize: (cols: number, rows: number) => Promise<boolean>,
    private readonly show: (history: number) => void
  ) {}

  schedule(request: ViewportRequest): Promise<void> {
    const version = ++this.version;
    this.queue = this.queue.then(async () => {
      if (version !== this.version) return;
      const resized = await this.resize(request.cols, request.rows).catch(() => false);
      if (version !== this.version) return;
      if (!resized && request.onFailure !== undefined) return request.onFailure();
      this.show(request.history);
    });
    return this.queue;
  }
}

type PaneViewportViewer = {
  owner: symbol;
  read: () => Promise<PaneGeometry | undefined>;
  apply: (cols: number, rows: number) => Promise<boolean>;
  unpin: () => Promise<boolean>;
  // the grid this viewer last asked for
  size?: PaneViewport;
  // its pane was resized for it without a resize of its own, so the next re-clamp reports it
  moved?: boolean;
};

// One Size claim per key (a window): the latest live viewer drives it, through its own read
// and apply; the others conform to the size it leaves, and when it leaves the one before it
// drives again. Only the last viewer's release restores the window.
type PaneViewportEntry = {
  // the driving viewer, or a release's marker once no viewer is left
  owner: symbol;
  // live viewers in acquire order, the driver last
  viewers: PaneViewportViewer[];
  queue: Promise<void>;
  read: () => Promise<PaneGeometry | undefined>;
  apply: (cols: number, rows: number) => Promise<boolean>;
  unpin: () => Promise<boolean>;
  // the window size to restore: as the claim found it, grown to the largest a viewer asked for
  restore?: PaneViewport;
  // the last geometry read showed a terminal attached, which a release must re-clamp at once
  attached?: boolean;
  // a release waiting out its grace
  pending?: ReturnType<typeof setTimeout>;
};

export type PaneViewportLease = {
  resize: (cols: number, rows: number) => Promise<boolean>;
  ensure: (cols: number, rows: number) => Promise<{ ok: boolean; resized: boolean }>;
  release: () => Promise<void>;
  // this viewer took over a released claim still in its grace, so the window kept its size
  held: boolean;
};

// Never ask for more than an attached terminal can show, so a browser and a
// terminal sharing a pane get tmux's own smallest-client behaviour.
const within = (requested: PaneViewport, limit: PaneViewport | undefined): PaneViewport =>
  limit === undefined ? requested : { cols: Math.min(requested.cols, limit.cols), rows: Math.min(requested.rows, limit.rows) };

// what the window holds beside the pane (other panes and their borders)
const besidePane = (geometry: PaneGeometry): PaneViewport =>
  geometry.window === undefined ? { cols: 0, rows: 0 } : { cols: Math.max(0, geometry.window.cols - geometry.cols), rows: Math.max(0, geometry.window.rows - geometry.rows) };

// how long a released Size claim keeps the window at the browser's size, so a viewer that comes
// back (a Workspace switched away from and back) finds it unchanged and the program in the pane
// gets no SIGWINCH redraw
export const paneViewportGraceMs = 30_000;

export class PaneViewportCoordinator {
  private readonly entries = new Map<string, PaneViewportEntry>();

  constructor(private readonly graceMs = paneViewportGraceMs) {}

  acquire(
    key: string,
    read: () => Promise<PaneGeometry | undefined>,
    apply: (cols: number, rows: number) => Promise<boolean>,
    unpin: () => Promise<boolean>
  ): PaneViewportLease {
    const owner = Symbol(key);
    const existing = this.entries.get(key);
    const entry = existing ?? { owner, viewers: [], queue: Promise.resolve(), read, apply, unpin };
    entry.viewers.push({ owner, read, apply, unpin });
    this.drive(entry, entry.viewers.at(-1)!);
    const held = entry.pending !== undefined;
    // a viewer returning within a release's grace takes the claim over as it stands
    this.cancelPending(entry);
    this.entries.set(key, entry);
    return {
      resize: (cols, rows) => this.resize(key, entry, owner, cols, rows),
      ensure: (cols, rows) => this.ensure(key, entry, owner, cols, rows),
      release: () => this.release(key, entry, owner),
      held
    };
  }

  async restoreAll(): Promise<void> {
    await Promise.all([...this.entries.entries()].map(([key, entry]) => { entry.viewers.length = 0; return this.releaseClaim(key, entry, 0); }));
  }

  private drive(entry: PaneViewportEntry, viewer: PaneViewportViewer): void {
    entry.owner = viewer.owner;
    entry.read = viewer.read;
    entry.apply = viewer.apply;
    entry.unpin = viewer.unpin;
  }

  private viewer(entry: PaneViewportEntry, owner: symbol): PaneViewportViewer | undefined {
    return entry.viewers.find(viewer => viewer.owner === owner);
  }

  private live(entry: PaneViewportEntry, owner: symbol): boolean {
    return this.viewer(entry, owner) !== undefined;
  }

  // size the window for its driver's grid, remembering the window to restore
  private async apply(entry: PaneViewportEntry, geometry: PaneGeometry, cols: number, rows: number): Promise<boolean> {
    entry.attached = geometry.clientLimit !== undefined;
    const beside = besidePane(geometry);
    const baseline = entry.restore ?? geometry.window ?? geometry;
    entry.restore = { cols: Math.max(baseline.cols, cols + beside.cols), rows: Math.max(baseline.rows, rows + beside.rows) };
    const target = within({ cols, rows }, geometry.clientLimit);
    return await entry.apply(target.cols, target.rows).catch(() => false);
  }

  private cancelPending(entry: PaneViewportEntry): void {
    clearTimeout(entry.pending);
    entry.pending = undefined;
  }

  private enqueue<T>(entry: PaneViewportEntry, operation: () => Promise<T>): Promise<T> {
    const next = entry.queue.then(operation, operation);
    entry.queue = next.then(() => undefined, () => undefined);
    return next;
  }

  private resize(key: string, entry: PaneViewportEntry, owner: symbol, cols: number, rows: number): Promise<boolean> {
    return this.enqueue(entry, async () => {
      const viewer = this.viewer(entry, owner);
      if (this.entries.get(key) !== entry || viewer === undefined) return false;
      viewer.size = { cols, rows };
      // the size it is about to get reaches the viewer anyway
      viewer.moved = false;
      // a viewer that does not drive the claim conforms to the size the driver leaves
      if (entry.owner !== owner) return true;
      const geometry = await entry.read().catch(() => undefined);
      if (geometry === undefined) return false;
      if (entry.owner !== owner) return this.live(entry, owner);
      return await this.apply(entry, geometry, cols, rows);
    });
  }

  private ensure(key: string, entry: PaneViewportEntry, owner: symbol, cols: number, rows: number): Promise<{ ok: boolean; resized: boolean }> {
    return this.enqueue(entry, async () => {
      const viewer = this.viewer(entry, owner);
      if (this.entries.get(key) !== entry || viewer === undefined) return { ok: false, resized: false };
      viewer.size = { cols, rows };
      const moved = viewer.moved === true;
      viewer.moved = false;
      // the driver moved the window under a viewer that does not drive it: report its new size
      if (entry.owner !== owner) return { ok: true, resized: true };
      const geometry = await entry.read().catch(() => undefined);
      if (geometry === undefined) return { ok: false, resized: false };
      if (entry.owner !== owner) return { ok: this.live(entry, owner), resized: true };
      entry.attached = geometry.clientLimit !== undefined;
      // the limit is re-read every tick: a terminal attaching, detaching or
      // resizing moves the target just as an external layout change does
      const target = within({ cols, rows }, geometry.clientLimit);
      if (geometry.cols === target.cols && geometry.rows === target.rows) return { ok: true, resized: moved };
      const resized = await entry.apply(target.cols, target.rows).catch(() => false);
      return { ok: resized, resized };
    });
  }

  private release(key: string, entry: PaneViewportEntry, owner: symbol): Promise<void> {
    const index = entry.viewers.findIndex(viewer => viewer.owner === owner);
    if (this.entries.get(key) !== entry || index < 0) return Promise.resolve();
    entry.viewers.splice(index, 1);
    const next = entry.viewers.at(-1);
    if (next === undefined) return this.releaseClaim(key, entry, this.graceMs);
    if (entry.owner === owner) this.handBack(entry, next);
    return Promise.resolve();
  }

  // the viewer before the one that left drives again, and its pane gets back the grid it asked for
  private handBack(entry: PaneViewportEntry, next: PaneViewportViewer): void {
    this.drive(entry, next);
    void this.enqueue(entry, async () => {
      const size = next.size;
      if (entry.owner !== next.owner || size === undefined) return;
      const geometry = await entry.read().catch(() => undefined);
      if (geometry === undefined || entry.owner !== next.owner) return;
      const target = within(size, geometry.clientLimit);
      if (geometry.cols === target.cols && geometry.rows === target.rows) return;
      if (await this.apply(entry, geometry, size.cols, size.rows)) next.moved = true;
    });
  }

  // the last viewer left: hold the window through the grace, then restore it
  private releaseClaim(key: string, entry: PaneViewportEntry, graceMs: number): Promise<void> {
    const releasing = Symbol(key);
    entry.owner = releasing;
    // restoreAll supersedes a release still in its grace
    this.cancelPending(entry);
    if (graceMs <= 0 || entry.attached === true) return this.restore(key, entry, releasing);
    entry.pending = setTimeout(() => { entry.pending = undefined; void this.restore(key, entry, releasing); }, graceMs);
    entry.pending.unref();
    return Promise.resolve();
  }

  private restore(key: string, entry: PaneViewportEntry, releasing: symbol): Promise<void> {
    return this.enqueue(entry, async () => {
      if (this.entries.get(key) !== entry || entry.owner !== releasing) return;
      if (entry.restore !== undefined) {
        // the window's size goes back through whichever pane drove last, so size that pane
        // for the window, keeping what sits beside it
        const geometry = await entry.read().catch(() => undefined);
        const beside = geometry === undefined ? { cols: 0, rows: 0 } : besidePane(geometry);
        const target = within({ cols: entry.restore.cols - beside.cols, rows: entry.restore.rows - beside.rows }, geometry?.clientLimit);
        await entry.apply(target.cols, target.rows).catch(() => false);
        // leave the window to tmux so a terminal attached later is sized normally
        try { await entry.unpin(); } catch { /* best effort, like the restore */ }
      }
      if (this.entries.get(key) === entry && entry.owner === releasing) this.entries.delete(key);
    });
  }
}
