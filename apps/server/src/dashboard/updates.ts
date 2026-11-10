import { randomUUID } from 'node:crypto';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { msSince } from './timing.js';
import type { Agent, CleanupTarget, Dashboard, DashboardPlace, DashboardProject, DashboardWorktree } from '../domain/models.js';
import type { CleanupVersion } from '../cleanup/service.js';
import type { LaunchResolution } from '../launch/resolution.js';
import type { StackState } from '../worktree-commands/service.js';
import type { ReviewTourCapability, StoredReviewTourSummary } from '../review-tour/contracts.js';
import type { CodeReviewCapability } from '../code-review/contracts.js';
import type { KeysConfig } from '../config/keys.js';
import type { ButtonCatalog } from '../button-actions/catalog.js';
import type { WatchSummary } from '../watches/service.js';
import type { NotificationEvent, NotificationState } from '../notification-events.js';

// one Worktree on the wire, augmented with the per-Worktree state the loader adds:
// its stack controls and its resolved Launch profile
export type PayloadWorktree = DashboardWorktree & { stack?: StackState; launch?: LaunchResolution };
export type DashboardPayload = Omit<Dashboard, 'agents' | 'projects' | 'places'> & {
  // `launch` carries each scope's resolved Launch profile so the web renders the Launch
  // menu without re-deriving it (a running agent's is its worktree's; a scratch agent's
  // is `scratchLaunch`); `scratchLaunch` is the Scratch group's resolution.
  // completionId stays stable from pending detection through unread publication
  // `watches`: the Watches the Agent set (ADR 0019)
  agents: Array<Agent & { unread: boolean; completionId?: string; notificationEvent?: NotificationEvent; notificationState?: NotificationState; queuedPromptCount: number; stack?: StackState; launch?: LaunchResolution; watches?: WatchSummary[] }>;
  // a non-git `directory` Project carries its own resolved Launch profile so the web renders
  // a Project-level Launch button (it has no Worktrees to launch through); omitted otherwise
  projects: Array<Omit<DashboardProject, 'worktrees'> & { worktrees: PayloadWorktree[]; launch?: LaunchResolution }>;
  // each directory-Project and Scratch Place carries the Launch profile of its scope (its
  // Project's, or the Scratch Place's own falling back to the Scratch group's)
  places: Array<DashboardPlace & { launch?: LaunchResolution }>;
  cleanupPending: number;
  cleanupTargets?: CleanupTarget[];
  cleanupVersion?: CleanupVersion;
  notesRevision?: number;
  // moves when the GitHub data views read over HTTP changes, so they read it again
  githubRevision?: number;
  // how many Pull requests hold a reason the operator has not been shown: the Overview's badge
  githubBadge?: number;
  scratchLaunch?: LaunchResolution;
  reviewTour: ReviewTourCapability;
  // every Review preset the Code review offers, each with its agent's runnable state
  codeReview: CodeReviewCapability;
  reviews: StoredReviewTourSummary[];
  // whether an `editor` is configured, so the web shows its Editor button (never the command)
  editor?: true;
  // the operator's key tables, each terminal command reduced to its program name
  keys?: KeysConfig;
  buttons?: ButtonCatalog;
};

// fingerprint every dashboard field that drives browser refreshes
export const dashboardFingerprint = (dashboard: DashboardPayload): string => JSON.stringify([dashboard.agents, dashboard.projects, dashboard.places, dashboard.cleanupPending, dashboard.cleanupTargets, dashboard.cleanupVersion, dashboard.notesRevision, dashboard.githubRevision, dashboard.githubBadge, dashboard.scratchLaunch, dashboard.reviewTour, dashboard.codeReview, dashboard.reviews, dashboard.buttons]);

// who asked for a dashboard: GET /api/dashboard, a /ws/dashboard connect, the server's poll,
// its first build at boot, the cleanup scan, or anything else (mutation routes, job and
// settings callbacks, Conductor reads)
export type DashboardTrigger = 'http' | 'ws' | 'poll' | 'boot' | 'cleanup' | 'other';

// One build's timeline. There is no queue: the first caller starts a build and every caller
// until it settles joins it, `atMs` into it, and gets its value. The loader adds its `steps`
// (ms) and `counts`; `publish` is the fingerprint and the listeners (each /ws/dashboard send).
export type DashboardBuild = {
  callers: Array<{ trigger: DashboardTrigger; atMs: number }>;
  startedAt: number;
  steps: Record<string, number>;
  counts: Record<string, number>;
  ms?: number;
  // the whole process's event loop over the build: the share of it spent running code, and
  // the longest a timer was held up (blocking work)
  eventLoop?: { utilization: number; maxDelayMs: number };
};

type DashboardObservation = { operationId: string; at: number; status: 'pending' | 'settled' | 'failed' };
type DashboardObservationOptions = {
  thresholdMs: number;
  now?: () => number;
  record: (stage: 'observation_started' | 'observation_settled', observation: DashboardObservation) => void;
};

export class DashboardUpdates<T = DashboardPayload> {
  private loader?: (build: DashboardBuild) => Promise<T>;
  private report?: (build: DashboardBuild, value: T | undefined) => void;
  private current?: T;
  private fingerprint = '';
  private refreshInFlight?: Promise<T>;
  private building?: DashboardBuild;
  private readonly listeners = new Set<(value: T) => void>();

  // keep slow observation diagnostics optional
  constructor(private readonly identify: (value: T) => string = value => JSON.stringify(value), private readonly observation?: DashboardObservationOptions) {}

  // `report` gets every settled build (its value undefined when the loader failed)
  setLoader(loader: (build: DashboardBuild) => Promise<T>, report?: (build: DashboardBuild, value: T | undefined) => void): void { this.loader = loader; this.report = report; }

  // coalesce builds while retaining timing and observation identities
  refresh(trigger: DashboardTrigger = 'other'): Promise<T> {
    if (this.refreshInFlight !== undefined) {
      if (this.building !== undefined) this.building.callers.push({ trigger, atMs: msSince(this.building.startedAt) });
      return this.refreshInFlight;
    }
    if (this.loader === undefined) return Promise.reject(new Error('dashboard loader unavailable'));
    const build: DashboardBuild = { callers: [{ trigger, atMs: 0 }], startedAt: performance.now(), steps: {}, counts: {} };
    const delay = monitorEventLoopDelay({ resolution: 10 });
    delay.enable();
    const busy = performance.eventLoopUtilization();
    let built: T | undefined;
    // use wall time for durable diagnostic stages
    const now = this.observation?.now ?? (() => Date.now());
    const operationId = randomUUID();
    const startedAt = now();
    let slow = false;
    let failed = false;
    // record only observations exceeding the threshold
    const slowTimer = this.observation === undefined ? undefined : setTimeout(() => {
      slow = true;
      // persist the true operation start only after the slow threshold
      try { this.observation?.record('observation_started', { operationId, at: startedAt, status: 'pending' }); } catch { /* diagnostics never gate refresh */ }
    }, this.observation.thresholdMs);
    slowTimer?.unref?.();
    // retain the loader failure for the terminal diagnostic stage
    const loaded = this.loader(build).catch(error => {
      failed = true;
      throw error;
    });
    // publish the same instrumented build to every waiter
    const refresh = loaded.then(value => {
      built = value;
      const publishing = performance.now();
      const fingerprint = this.identify(value);
      this.current = value;
      if (fingerprint !== this.fingerprint) {
        this.fingerprint = fingerprint;
        for (const listener of this.listeners) {
          try { listener(value); }
          catch { this.listeners.delete(listener); }
        }
      }
      build.steps.publish = msSince(publishing);
      return value;
    }).finally(() => {
      // stop a fast observation before it can enter the journal
      if (slowTimer !== undefined) clearTimeout(slowTimer);
      // pair only slow observations with one terminal stage
      if (slow) {
        try { this.observation?.record('observation_settled', { operationId, at: now(), status: failed ? 'failed' : 'settled' }); } catch { /* diagnostics never gate refresh */ }
      }
      if (this.refreshInFlight === refresh) this.refreshInFlight = undefined;
      build.ms = msSince(build.startedAt);
      delay.disable();
      build.eventLoop = { utilization: Math.round(performance.eventLoopUtilization(busy).utilization * 1000) / 1000, maxDelayMs: Math.round(delay.max / 1e5) / 10 };
      const report = this.report;
      // once every caller, an HTTP response included, has had the value
      if (report !== undefined) setImmediate(() => { try { report(build, built); } catch { /* timing never breaks the dashboard */ } });
    });
    this.refreshInFlight = refresh;
    this.building = build;
    return refresh;
  }

  subscribe(listener: (value: T) => void): () => void {
    this.listeners.add(listener);
    if (this.current !== undefined) {
      try { listener(this.current); }
      catch (error) {
        this.listeners.delete(listener);
        throw error;
      }
    }
    return () => { this.listeners.delete(listener); };
  }

  close(): void {
    this.loader = undefined;
    this.listeners.clear();
  }
}
