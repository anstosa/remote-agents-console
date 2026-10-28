import { randomBytes } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import type { IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import type { TunnelHealth } from './contracts.js';

type DnsRecord = { address: string; family: number };
export type TunnelProbe = { outcome: 'disabled' | 'unavailable' | 'healthy' | 'origin-failed' | 'public-failed' | 'identity-mismatch'; canReconnect: boolean };
type MonitorOptions = { intervalMs?: number; failureThreshold?: number; now?: () => number; setInterval?: typeof setInterval; clearInterval?: typeof clearInterval };
type ProofOptions = { lookup?: (hostname: string) => Promise<DnsRecord[]>; fetch?: typeof fetch; httpsRequest?: typeof httpsRequest; timeoutMs?: number };
const proofPattern = /^[a-f0-9]{64}$/u;
const blockedIpv4 = new BlockList();
const blockedIpv6 = new BlockList();

// reject nonpublic ipv4 destinations
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4]
] as const) {
  blockedIpv4.addSubnet(network, prefix, 'ipv4');
}
// reject nonpublic ipv6 destinations
for (const [network, prefix] of [
  ['::', 96], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48],
  ['100::', 64], ['2001::', 32], ['2001:db8::', 32], ['2002::', 16], ['3ffe::', 16],
  ['fc00::', 7], ['fec0::', 10], ['fe80::', 10], ['ff00::', 8]
] as const) {
  blockedIpv6.addSubnet(network, prefix, 'ipv6');
}

// parse one bounded challenged health response
function healthProof(body: string): string | undefined {
  try {
    const value: unknown = JSON.parse(body);
    // require only the expected proof fields
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    return record.ok === true && typeof record.proof === 'string' && proofPattern.test(record.proof) ? record.proof : undefined;
  } catch {
    return undefined;
  }
}

// accept only globally routable dns answers
function publicAddress(record: DnsRecord): boolean {
  const family = isIP(record.address);
  // reject malformed or mislabeled answers
  if (family === 0 || family !== record.family) return false;
  return family === 4 ? !blockedIpv4.check(record.address, 'ipv4') : !blockedIpv6.check(record.address, 'ipv6');
}

// settle one promise within the remaining absolute deadline
async function within<T>(promise: Promise<T>, timeoutMs: number, onTimeout?: () => void): Promise<T | undefined> {
  // reject work that has already exhausted its budget
  if (timeoutMs <= 0) { onTimeout?.(); return undefined; }
  return await new Promise(resolvePromise => {
    let settled = false;
    // settle at most once and release the deadline
    const settle = (value?: T) => {
      // ignore late work completion
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(value);
    };
    const timer = setTimeout(() => { onTimeout?.(); settle(); }, timeoutMs);
    timer.unref?.();
    void promise.then(value => settle(value), () => settle());
  });
}

// resolve public addresses through one cancellable resolver
async function resolvePublic(hostname: string, timeoutMs: number, custom?: ProofOptions['lookup']): Promise<DnsRecord[] | undefined> {
  // retain injectable lookup behavior under the same deadline
  if (custom !== undefined) return await within(custom(hostname), timeoutMs);
  const resolver = new Resolver();
  const queries = await within(Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]), timeoutMs, () => resolver.cancel());
  // report an exhausted or entirely failed resolution
  if (queries === undefined) return undefined;
  const records: DnsRecord[] = [];
  // combine only successful address families
  for (const [index, query] of queries.entries()) {
    // skip absent address families
    if (query.status !== 'fulfilled') continue;
    // preserve every public-candidate answer
    for (const address of query.value) records.push({ address, family: index === 0 ? 4 : 6 });
  }
  return records;
}

// read one local boot proof under a short deadline
async function localProof(origin: string, challenge: string, options: ProofOptions, timeoutMs: number): Promise<string | undefined> {
  const fetcher = options.fetch ?? fetch;
  const deadline = Date.now() + timeoutMs;
  const controller = new AbortController();
  try {
    const response = await within(fetcher(`${origin}/healthz?racChallenge=${challenge}`, { redirect: 'manual', signal: controller.signal, headers: { 'cache-control': 'no-store' } }), Math.max(1, Math.min(1_000, timeoutMs)), () => controller.abort());
    // reject redirects and unhealthy responses
    if (response === undefined || !response.ok || response.status < 200 || response.status >= 300) return undefined;
    const body = await within(response.text(), deadline - Date.now(), () => controller.abort());
    return body === undefined ? undefined : healthProof(body);
  } catch {
    return undefined;
  }
}

// read one public proof through a pinned validated address
function publicProof(hostname: string, port: number, record: DnsRecord, challenge: string, options: ProofOptions): Promise<string | undefined> {
  return new Promise(resolvePromise => {
    const requester = options.httpsRequest ?? httpsRequest;
    const timeoutMs = options.timeoutMs ?? 4_000;
    let response: IncomingMessage | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    let length = 0;
    const chunks: Buffer[] = [];
    // settle exactly once
    const settle = (value?: string) => {
      // ignore duplicate transport completion
      if (settled) return;
      settled = true;
      // release the absolute request deadline
      if (deadline !== undefined) clearTimeout(deadline);
      resolvePromise(value);
    };
    const request = requester({
      protocol: 'https:', hostname, servername: hostname, port, method: 'GET',
      path: `/healthz?racChallenge=${challenge}`,
      headers: { host: port === 443 ? hostname : `${hostname}:${port}`, 'cache-control': 'no-store' },
      lookup: (_hostname, lookupOptions, callback) => {
        // satisfy node's address-list lookup contract
        if (lookupOptions.all) callback(null, [record]);
        else callback(null, record.address, record.family);
      }
    }, incoming => {
      response = incoming;
      incoming.on('data', (chunk: Buffer) => {
        length += chunk.length;
        // bound response memory
        if (length > 8 * 1024) { request.destroy(); settle(); return; }
        chunks.push(chunk);
      });
      incoming.once('end', () => {
        // accept only direct healthy tls responses
        if (!incoming.statusCode || incoming.statusCode < 200 || incoming.statusCode >= 300) { settle(); return; }
        settle(healthProof(Buffer.concat(chunks).toString('utf8')));
      });
      incoming.once('aborted', () => settle());
      incoming.once('error', () => settle());
    });
    deadline = setTimeout(() => { request.destroy(); response?.destroy(); settle(); }, timeoutMs);
    deadline.unref?.();
    request.once('error', () => settle());
    request.end();
  });
}

// compare one loopback proof with one pinned public proof
export async function probeTunnelRoute(input: { localOrigin: string; hostname: string; port?: number }, options: ProofOptions = {}): Promise<TunnelProbe> {
  const deadline = Date.now() + (options.timeoutMs ?? 5_000);
  const challenge = randomBytes(32).toString('hex');
  const local = await localProof(input.localOrigin, challenge, options, deadline - Date.now());
  // distinguish origin downtime from tunnel degradation
  if (local === undefined) return { outcome: 'origin-failed', canReconnect: true };
  const records = await resolvePublic(input.hostname, deadline - Date.now(), options.lookup);
  // reject dns rebinding and empty answers
  if (records === undefined || records.length === 0 || records.some(record => !publicAddress(record))) return { outcome: 'public-failed', canReconnect: true };
  const remaining = deadline - Date.now();
  // enforce the one absolute probe deadline
  if (remaining <= 0) return { outcome: 'public-failed', canReconnect: true };
  const remote = await publicProof(input.hostname, input.port ?? 443, records[0]!, challenge, { ...options, timeoutMs: remaining });
  // classify a missing public proof separately from a wrong server
  if (remote === undefined) return { outcome: 'public-failed', canReconnect: true };
  return { outcome: remote === local ? 'healthy' : 'identity-mismatch', canReconnect: true };
}

// retain one bounded cached route-health state
export class TunnelHealthMonitor {
  private health: TunnelHealth = { state: 'unknown', failures: 0, reconnecting: false, canReconnect: false };
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private generation = 0;
  // bind one probe and deterministic timing controls
  constructor(private readonly probe: () => Promise<TunnelProbe>, private readonly options: MonitorOptions = {}) {}
  // return one immutable browser snapshot
  snapshot(): TunnelHealth { return { ...this.health }; }
  // publish reconnect lifecycle without changing route evidence
  reconnecting(active: boolean, failed = false): void {
    const { error, ...health } = this.health;
    // retain route diagnostics independently from reconnect progress
    this.health = { ...health, reconnecting: active, ...(failed ? { error: 'reconnect_failed' } : error === undefined || error === 'reconnect_failed' ? {} : { error }) };
  }
  // start one immediate check and one nonoverlapping cadence
  start(): void {
    // preserve one timer owner
    if (this.timer !== undefined) return;
    this.generation += 1;
    void this.checkNow();
    this.timer = (this.options.setInterval ?? setInterval)(() => { void this.checkNow(); }, this.options.intervalMs ?? 15_000);
    this.timer.unref?.();
  }
  // stop updates from timers and in-flight checks
  stop(): void {
    this.generation += 1;
    // clear only an owned timer
    if (this.timer !== undefined) (this.options.clearInterval ?? clearInterval)(this.timer);
    this.timer = undefined;
  }
  // execute at most one probe and ignore stale completion
  async checkNow(): Promise<void> {
    // coalesce overlapping intervals
    if (this.running) return;
    this.running = true;
    const generation = this.generation;
    // expose first-check progress without hiding prior degradation
    if (this.health.state === 'unknown') this.health = { ...this.health, state: 'checking' };
    try {
      const result = await this.probe();
      // discard a completion after stop or restart
      if (generation !== this.generation) return;
      this.apply(result);
    } catch {
      // report monitor failure without clearing proved degradation
      if (generation === this.generation && this.health.state !== 'degraded') this.health = { ...this.health, state: 'unknown', checkedAt: new Date((this.options.now ?? Date.now)()).toISOString(), failures: 0, error: 'origin_unavailable' };
    } finally { this.running = false; }
  }
  // fold one probe into the failure threshold
  private apply(result: TunnelProbe): void {
    const checkedAt = new Date((this.options.now ?? Date.now)()).toISOString();
    // clear evidence only for authoritative decommission
    if (result.outcome === 'disabled') { this.health = { state: 'disabled', checkedAt, failures: 0, reconnecting: this.health.reconnecting, canReconnect: false }; return; }
    // retain proved degradation across transient capability loss
    if (result.outcome === 'unavailable') {
      this.health = this.health.state === 'degraded'
        ? { ...this.health, checkedAt, canReconnect: false }
        : { state: 'disabled', checkedAt, failures: 0, reconnecting: this.health.reconnecting, canReconnect: false };
      return;
    }
    // clear degradation only after exact public identity proof
    if (result.outcome === 'healthy') { this.health = { state: 'healthy', checkedAt, lastHealthyAt: checkedAt, failures: 0, reconnecting: this.health.reconnecting, canReconnect: result.canReconnect }; return; }
    // preserve proved degradation through unrelated origin downtime
    if (result.outcome === 'origin-failed') {
      this.health = this.health.state === 'degraded'
        ? { ...this.health, checkedAt, reconnecting: this.health.reconnecting, canReconnect: result.canReconnect }
        : { state: 'unknown', checkedAt, ...(this.health.lastHealthyAt ? { lastHealthyAt: this.health.lastHealthyAt } : {}), failures: 0, reconnecting: this.health.reconnecting, canReconnect: result.canReconnect, error: 'origin_unavailable' };
      return;
    }
    const failures = this.health.failures + 1;
    const error = result.outcome === 'identity-mismatch' ? 'tunnel_identity_mismatch' : 'tunnel_unreachable';
    const state = failures >= (this.options.failureThreshold ?? 2) || this.health.state === 'degraded' ? 'degraded' : 'unknown';
    this.health = { state, checkedAt, ...(this.health.lastHealthyAt ? { lastHealthyAt: this.health.lastHealthyAt } : {}), failures, reconnecting: this.health.reconnecting, canReconnect: result.canReconnect, error };
  }
}
