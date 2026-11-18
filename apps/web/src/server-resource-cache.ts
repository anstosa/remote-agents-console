import { useEffect, useReducer, useRef, useState } from 'react';
import { isResourceSnapshot, type ResourceSnapshot, type ResourceUsage } from '../../server/src/server-admin/resource-contracts.js';
import { readResourceStream, type ResourceRequest } from './server-resource-stream.js';
import { usagePercent } from './server-resource-values.js';

type ResourceUpdate<T> = (previous: T | undefined, sample: ResourceSnapshot | undefined, sampledAt: number) => T;
export type DiskUsage = Pick<ResourceSnapshot, 'host' | 'wsl'> & { refreshFailed: boolean };
export type ResourceAverages = { cpu: number | null; memory: number | null };
type MetricReading = ResourceAverages & { sampledAt: number };
type MetricBoundary = 'wsl' | 'host';
type Observation<T> = { value: T; sampledAt: number };
export type MetricUsage = { snapshot?: Pick<ResourceSnapshot, 'host' | 'wsl'>; refreshFailed: boolean };
type CachedMetrics = { host?: Observation<ResourceUsage>; wsl?: Observation<ResourceUsage>; boundary?: Observation<MetricBoundary>; attemptedAt: number; refreshFailed: boolean };
type MinuteMetrics = CachedMetrics & { history: MetricReading[] };
const diskRefreshMs = 10 * 60_000;
const metricRefreshMs = 60_000;
const averageWindowMs = 5 * metricRefreshMs;

// own each cadence, in-flight request, and last-good cache outside the flyout
function useResourcePoll<T>(request: ResourceRequest, enabled: boolean, endpoint: string, intervalMs: number, update: ResourceUpdate<T>, refreshOnOpen = false): T | undefined {
  const [value, setValue] = useState<T>();
  const refreshCurrent = useRef<() => void>(undefined);

  // sample immediately and independently of the flyout lifetime
  useEffect(() => {
    // clear this browser session's cache when it stops monitoring
    if (!enabled) { setValue(undefined); return; }
    let stopped = false;
    let active: AbortController | undefined;
    let deadline: number | undefined;

    // keep cached data visible and never overlap a scheduled or on-open refresh
    const refresh = async () => {
      // let an active refresh satisfy concurrent requests
      if (stopped || active !== undefined) return;
      const sampledAt = performance.now();
      const controller = new AbortController();
      active = controller;
      deadline = window.setTimeout(() => controller.abort(), 15_000);
      try {
        const response = await request(endpoint, { cache: 'no-store', signal: controller.signal });
        // keep transport failures inside the optional cache
        if (!response.ok) throw new Error('Resource usage unavailable');
        const sample: unknown = await response.json();
        // reject expired or invalid data before changing the cache
        if (controller.signal.aborted || !isResourceSnapshot(sample)) throw new Error('Invalid resource sample');
        // ignore replies after opt-out or session loss
        if (!stopped) setValue(previous => update(previous, sample, sampledAt));
      } catch {
        // let failures settle without suppressing the last usable reading
        if (!stopped) setValue(previous => update(previous, undefined, sampledAt));
      } finally {
        window.clearTimeout(deadline);
        active = undefined;
      }
    };

    // use one request owner for each cadence and any flyout refresh
    refreshCurrent.current = () => { void refresh(); };
    refreshCurrent.current();
    const timer = window.setInterval(refreshCurrent.current, intervalMs);
    // stop polling and abort the exact request when its scope ends
    return () => {
      stopped = true;
      refreshCurrent.current = undefined;
      window.clearInterval(timer);
      window.clearTimeout(deadline);
      active?.abort();
    };
  }, [enabled, request, endpoint, intervalMs, update]);

  // disks refresh on open without resetting their independent cadence
  useEffect(() => {
    // the metrics timer and live connection own their own refreshes
    if (enabled && refreshOnOpen) refreshCurrent.current?.();
  }, [enabled, refreshOnOpen]);

  return enabled ? value : undefined;
}

// keep the last good disk reading of each namespace independently
const retainDisks = (latest: ResourceUsage | null | undefined, previous: ResourceUsage | null | undefined) =>
  latest != null && latest.diskError === undefined ? latest : previous ?? latest;

// preserve disk capacities during a failed refresh, not after a confirmed namespace change
const updateDisks: ResourceUpdate<DiskUsage> = (previous, sample) => {
  const refreshFailed = sample == null || sample.host === null || sample.host.diskError !== undefined || sample.wsl?.diskError !== undefined || (sample.errors?.length ?? 0) > 0;
  return {
    host: retainDisks(sample?.host, previous?.host) ?? null,
    wsl: sample?.wsl === undefined && !refreshFailed ? undefined : retainDisks(sample?.wsl, previous?.wsl) ?? undefined,
    refreshFailed
  };
};

// retain the last usable sample without presenting a failed refresh as new data
const mergeMetrics: ResourceUpdate<CachedMetrics> = (previous, sample, sampledAt) => {
  const refreshFailed = sample == null || sample.host === null || (sample.errors?.length ?? 0) > 0;
  const scope = sample?.wsl !== undefined ? 'wsl' : refreshFailed ? undefined : 'host';
  const scopeChanged = scope !== undefined && previous?.boundary !== undefined && scope !== previous.boundary.value;
  const last = scopeChanged ? undefined : previous;
  return {
    host: sample?.host != null ? { value: sample.host, sampledAt } : last?.host,
    wsl: sample?.wsl !== undefined ? { value: sample.wsl, sampledAt } : last?.wsl,
    boundary: scope !== undefined ? { value: scope, sampledAt } : last?.boundary,
    attemptedAt: sampledAt,
    refreshFailed
  };
};

// only minute samples contribute to the five-minute button averages
const updateMetrics: ResourceUpdate<MinuteMetrics> = (previous, sample, sampledAt) => {
  const cached = mergeMetrics(previous, sample, sampledAt);
  const scope = cached.boundary?.value;
  const history = scope === previous?.boundary?.value ? (previous?.history ?? []).filter(entry => sampledAt - entry.sampledAt < averageWindowMs) : [];
  const usage = scope === 'wsl' ? sample?.wsl : scope === 'host' ? sample?.host : undefined;
  const cpu = usage?.cpuPercent ?? null;
  const memory = usagePercent(usage?.memory?.usedBytes ?? null, usage?.memory?.totalBytes ?? null);
  // never count a stale, missing or synthetic reading
  if (cpu !== null || memory !== null) history.push({ sampledAt, cpu, memory });
  return { ...cached, history: history.slice(-5) };
};

// retain live data across flyout closes but stop inspection with the owning view
function useLiveMetrics(request: ResourceRequest, enabled: boolean, open: boolean): CachedMetrics | undefined {
  const [cached, setCached] = useState<CachedMetrics>();

  // open a single live connection only while the flyout and tab are visible
  useEffect(() => {
    // clear in-memory readings only when monitoring ends
    if (!enabled) { setCached(undefined); return; }
    // closing the flyout keeps the cache but does not open a stream
    if (!open) return;
    let stopped = false;
    let controller: AbortController | undefined;
    let retry: number | undefined;

    // stop both the active connection and any pending retry
    const stop = () => { controller?.abort(); window.clearTimeout(retry); };

    // reconnect in place without clearing cached readings
    const connect = async () => {
      // never refresh from a hidden or unmounted flyout
      if (stopped || document.visibilityState !== 'visible') return;
      const current = new AbortController();
      controller = current;
      try {
        await readResourceStream(request, current.signal, snapshot => {
          // discard a sample from a connection that just closed
          if (current.signal.aborted || stopped) return;
          const sampledAt = performance.now();
          setCached(previous => mergeMetrics(previous, snapshot, sampledAt));
        });
      } catch {
        // keep intentional disconnects silent
        if (current.signal.aborted || stopped) return;
        const sampledAt = performance.now();
        setCached(previous => mergeMetrics(previous, undefined, sampledAt));
        retry = window.setTimeout(() => { void connect(); }, 2_000);
      }
    };

    // hide/restore the live collector without touching the minute schedule
    const visibilityChanged = () => { stop(); void connect(); };
    document.addEventListener('visibilitychange', visibilityChanged);
    void connect();
    return () => { stopped = true; stop(); document.removeEventListener('visibilitychange', visibilityChanged); };
  }, [enabled, open, request]);

  return enabled ? cached : undefined;
}

// prefer the newer of two real observations, even during partial refreshes
const newerObservation = <T,>(minute: Observation<T> | undefined, live: Observation<T> | undefined) =>
  (live?.sampledAt ?? -Infinity) >= (minute?.sampledAt ?? -Infinity) ? live : minute;

// compare Windows and WSL independently so a partial response cannot roll either back
function newestMetrics(minute: CachedMetrics | undefined, live: CachedMetrics | undefined, open: boolean): MetricUsage | undefined {
  // leave the skeleton up only before either source has settled
  if (minute === undefined && live === undefined) return undefined;
  const scope = newerObservation(minute?.boundary, live?.boundary)?.value;
  const minuteForScope = minute?.boundary === undefined || minute.boundary.value === scope ? minute : undefined;
  const liveForScope = live?.boundary === undefined || live.boundary.value === scope ? live : undefined;
  const host = newerObservation(minuteForScope?.host, liveForScope?.host)?.value ?? null;
  const wsl = newerObservation(minuteForScope?.wsl, liveForScope?.wsl)?.value;
  const lastAttempt = (live?.attemptedAt ?? -Infinity) >= (minute?.attemptedAt ?? -Infinity) ? live : minute;
  return {
    snapshot: host === null && wsl === undefined ? undefined : { host, wsl },
    refreshFailed: lastAttempt?.refreshFailed === true || (open && live?.refreshFailed === true)
  };
}

// average known observations independently so missing values never count as zero
const mean = (history: MetricReading[], metric: keyof ResourceAverages): number | null => {
  let count = 0;
  let total = 0;
  // sum only observed values for this gauge
  for (const entry of history) {
    const value = entry[metric];
    // skip unavailable measurements without discarding the other gauge
    if (value === null) continue;
    total += value;
    count += 1;
  }
  return count === 0 ? null : total / count;
};

// expire the rolling window on time even when the next poll fails or is pending
function useResourceAverages(history: MetricReading[] | undefined): ResourceAverages {
  // render again when the next observation ages out
  const [, expire] = useReducer((revision: number) => revision + 1, 0);
  const now = performance.now();
  const recent = (history ?? []).filter(entry => now - entry.sampledAt < averageWindowMs);
  const next = recent[0]?.sampledAt;
  // own at most one expiry timer for the oldest remaining observation
  useEffect(() => {
    // do not leave a timer when monitoring is off or no sample remains
    if (next === undefined) return;
    const timer = window.setTimeout(expire, Math.max(1, Math.ceil(next + averageWindowMs - performance.now())));
    return () => window.clearTimeout(timer);
  }, [next]);
  return { cpu: mean(recent, 'cpu'), memory: mean(recent, 'memory') };
}

// expose the caches to the button and its flyout without coupling their schedules
export function useServerResourceCache(request: ResourceRequest, enabled: boolean, open: boolean) {
  const minute = useResourcePoll(request, enabled, '/api/server/resources/metrics', metricRefreshMs, updateMetrics);
  const live = useLiveMetrics(request, enabled, open);
  const disks = useResourcePoll(request, enabled, '/api/server/resources/disks', diskRefreshMs, updateDisks, open);
  const averages = useResourceAverages(minute?.history);
  return { metrics: newestMetrics(minute, live, open), disks, averages };
}
