import type { Agent, Dashboard, DashboardPlace, DashboardProject, DashboardWorktree } from '../domain/models.js';
import type { LaunchResolution } from '../launch/resolution.js';
import type { StackState } from '../worktree-commands/service.js';
import type { ReviewTourCapability, StoredReviewTourSummary } from '../review-tour/contracts.js';
import type { CodeReviewCapability } from '../code-review/contracts.js';
import type { KeysConfig } from '../config/keys.js';
import type { ButtonCatalog } from '../button-actions/catalog.js';
import type { WatchSummary } from '../watches/service.js';

// one Worktree on the wire, augmented with the per-Worktree state the loader adds:
// its stack controls and its resolved Launch profile
export type PayloadWorktree = DashboardWorktree & { stack?: StackState; launch?: LaunchResolution };
export type DashboardPayload = Omit<Dashboard, 'agents' | 'projects' | 'places'> & {
  // `launch` carries each scope's resolved Launch profile so the web renders the Launch
  // menu without re-deriving it (a running agent's is its worktree's; a scratch agent's
  // is `scratchLaunch`); `scratchLaunch` is the Scratch group's resolution.
  // completionId stays stable from pending detection through unread publication
  // `watches`: the Watches the Agent set (ADR 0019)
  agents: Array<Agent & { unread: boolean; completionId?: string; queuedPromptCount: number; stack?: StackState; launch?: LaunchResolution; watches?: WatchSummary[] }>;
  // a non-git `directory` Project carries its own resolved Launch profile so the web renders
  // a Project-level Launch button (it has no Worktrees to launch through); omitted otherwise
  projects: Array<Omit<DashboardProject, 'worktrees'> & { worktrees: PayloadWorktree[]; launch?: LaunchResolution }>;
  // each directory-Project and Scratch Place carries the Launch profile of its scope (its
  // Project's, or the Scratch Place's own falling back to the Scratch group's)
  places: Array<DashboardPlace & { launch?: LaunchResolution }>;
  cleanupPending: number;
  notesRevision?: number;
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
export const dashboardFingerprint = (dashboard: DashboardPayload): string => JSON.stringify([dashboard.agents, dashboard.projects, dashboard.places, dashboard.cleanupPending, dashboard.notesRevision, dashboard.scratchLaunch, dashboard.reviewTour, dashboard.codeReview, dashboard.reviews, dashboard.buttons]);

export class DashboardUpdates<T = DashboardPayload> {
  private loader?: () => Promise<T>;
  private current?: T;
  private fingerprint = '';
  private refreshInFlight?: Promise<T>;
  private readonly listeners = new Set<(value: T) => void>();

  constructor(private readonly identify: (value: T) => string = value => JSON.stringify(value)) {}

  setLoader(loader: () => Promise<T>): void { this.loader = loader; }

  refresh(): Promise<T> {
    if (this.refreshInFlight !== undefined) return this.refreshInFlight;
    if (this.loader === undefined) return Promise.reject(new Error('dashboard loader unavailable'));
    const refresh = this.loader().then(value => {
      const fingerprint = this.identify(value);
      this.current = value;
      if (fingerprint === this.fingerprint) return value;
      this.fingerprint = fingerprint;
      for (const listener of this.listeners) {
        try { listener(value); }
        catch { this.listeners.delete(listener); }
      }
      return value;
    }).finally(() => {
      if (this.refreshInFlight === refresh) this.refreshInFlight = undefined;
    });
    this.refreshInFlight = refresh;
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
