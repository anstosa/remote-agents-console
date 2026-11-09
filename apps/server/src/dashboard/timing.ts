import { performance } from 'node:perf_hooks';
import type { DashboardBuild } from './updates.js';

export const msSince = (start: number): number => Math.round((performance.now() - start) * 10) / 10;

// Runs `work` and records how long it took (to its promise settling) as `steps[name]`. A step
// run once per Agent, Worktree or Project keeps its slowest run: those runs are parallel, so
// they overlap one another and the step that awaits them all.
export function timed<T>(steps: Record<string, number> | undefined, name: string, work: () => T): T {
  if (steps === undefined) return work();
  const start = performance.now();
  const done = () => { steps[name] = Math.max(steps[name] ?? 0, msSince(start)); };
  let result: T;
  try { result = work(); } catch (error) { done(); throw error; }
  if (result instanceof Promise) return result.finally(done) as T;
  done();
  return result;
}

// builds faster than this that served no page load are the poll's routine and unlogged
const slowBuildMs = 250;
// and slow ones are logged at most this often, so a server whose every 500 ms poll is slow
// cannot flood the file and rotate the page-load records away
const slowBuildEveryMs = 10_000;

// The dashboard's timing report: one record per build that served a page load (GET
// /api/dashboard or a /ws/dashboard connecting), and a sample of builds that took
// `slowBuildMs` or more. It runs after the response went out; the extra serialization
// measures the HTTP payload (the response itself was serialized by Fastify).
export const dashboardTimingReport = (append: (record: unknown) => Promise<void>) => {
  let lastSlow = -Infinity;
  return (build: DashboardBuild, value: unknown): void => {
    const served = build.callers.some(caller => caller.trigger === 'http');
    if (!served && !build.callers.some(caller => caller.trigger === 'ws')) {
      if ((build.ms ?? 0) < slowBuildMs || build.startedAt - lastSlow < slowBuildEveryMs) return;
      lastSlow = build.startedAt;
    }
    const serializing = performance.now();
    const jsonBytes = served && value !== undefined ? Buffer.byteLength(JSON.stringify(value)) : undefined;
    void append({
      at: new Date(performance.timeOrigin + build.startedAt).toISOString(),
      // since the server process started, so a cold build right after a restart stands out
      uptimeMs: Math.round(build.startedAt),
      trigger: build.callers[0]!.trigger,
      callers: build.callers,
      ms: build.ms,
      ...(value === undefined ? { failed: true } : {}),
      steps: build.steps,
      counts: build.counts,
      eventLoop: build.eventLoop,
      ...(jsonBytes === undefined ? {} : { http: { jsonBytes, serializeMs: msSince(serializing) } })
    });
  };
};
