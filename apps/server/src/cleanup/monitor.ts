import type { DashboardPayload } from '../dashboard/updates.js';
import type { DashboardUpdates } from '../dashboard/updates.js';
import type { CleanupTarget } from '../domain/models.js';

type Scanner = { scan(): Promise<CleanupTarget[]> };

export class CleanupMonitor {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;

  // configure scan cadence and dashboard refresh
  constructor(
    private readonly cleanup: Scanner,
    private readonly dashboard: Pick<DashboardUpdates<DashboardPayload>, 'refresh'>,
    private readonly intervalMs = 60 * 60 * 1_000
  ) {}

  start(): void {
    if (this.timer !== undefined) return;
    void this.run();
    this.timer = setInterval(() => void this.run(), this.intervalMs);
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  // scan once and publish cached results
  private run(): Promise<void> {
    if (this.running !== undefined) return this.running;
    const running = this.cleanup.scan().then(async () => {
      await this.dashboard.refresh().catch(() => undefined);
    }).catch(() => undefined).finally(() => {
      if (this.running === running) this.running = undefined;
    });
    this.running = running;
    return running;
  }
}
