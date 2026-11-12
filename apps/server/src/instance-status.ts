import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { RemoteServer } from './config/schema.js';
import type { Agent } from './domain/models.js';
import { instanceIconHashPattern } from './instance-icon-name.js';
import { agentPresentationAttentionState } from './notifications.js';
import { maxIconBytes, validateSvg } from './instance-icon-svg.js';

export type InstanceAttention = 'idle' | 'working' | 'question' | 'completed' | 'unavailable';
// iconHash names artwork this server has fetched, verified and can serve itself
export type InstanceStatus = { url: string; name: string; iconHash?: string; attention: InstanceAttention };
type PublishedIdentity = Pick<InstanceStatus, 'name' | 'iconHash'>;
// each signed peer surface has its own HMAC label, so a signature for one never authorizes another
export type PeerRequest = 'status' | 'icon';

// viewers built before the icon library drop a peer's whole identity for any other icon name;
// status can stop naming the icon once no viewer older than the iconHash field remains
export const legacyPeerIconNames: ReadonlySet<string> = new Set(['terminal', 'potato', 'heart']);
const statusClockSkewMs = 30_000;
const statusResponseBytes = 2_048;
const legacyMetadataResponseBytes = 8_192;
const statusCacheMs = 5_000;
const artworkRetryMs = 60_000;

// identify one artwork revision by its bytes
export function instanceIconHash(svg: string): string {
  return createHash('sha256').update(svg).digest('base64url');
}

// reduce dashboard details to one safe attention state
export function instanceAttention(dashboard: { agents: Array<Agent & { unread: boolean }> }): Exclude<InstanceAttention, 'unavailable'> {
  // prioritize active questions over completed notifications
  if (dashboard.agents.some(agent => agentPresentationAttentionState(agent) === 'question')) return 'question';
  // show active work before any retained completion notification
  if (dashboard.agents.some(agent => agentPresentationAttentionState(agent) === 'working')) return 'working';
  // retain completed state until its notification is viewed
  if (dashboard.agents.some(agent => agent.unread)) return 'completed';
  return 'idle';
}

// derive one domain-separated peer signature
function peerSignature(secret: string, purpose: PeerRequest, targetOrigin: string, timestamp: string): Buffer {
  return createHmac('sha256', secret).update(`rac-instance-${purpose}-v1\n${targetOrigin}\n${timestamp}`).digest();
}

// build authenticated peer request headers
function peerHeaders(secret: string, purpose: PeerRequest, targetOrigin: string, accept: string): Record<string, string> {
  const timestamp = String(Date.now());
  return { accept, 'x-rac-status-timestamp': timestamp, 'x-rac-status-signature': peerSignature(secret, purpose, targetOrigin, timestamp).toString('base64url') };
}

// authenticate one signed peer request for the surface it targets
export function validPeerRequest(secret: string, purpose: PeerRequest, targetOrigin: string, timestamp: unknown, signature: unknown, now = Date.now()): boolean {
  // require the server-only shared secret and header shape
  if (secret.length < 32 || typeof timestamp !== 'string' || typeof signature !== 'string' || !/^\d{13}$/u.test(timestamp)) return false;
  const requestedAt = Number(timestamp);
  // reject stale or future replay windows
  if (!Number.isSafeInteger(requestedAt) || Math.abs(now - requestedAt) > statusClockSkewMs) return false;
  let provided: Buffer;
  // reject malformed signature encodings
  try { provided = Buffer.from(signature, 'base64url'); }
  catch { return false; }
  const expected = peerSignature(secret, purpose, targetOrigin, timestamp);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

// validate a remote status response
function isInstanceAttention(value: unknown): value is Exclude<InstanceAttention, 'unavailable'> {
  return value === 'idle' || value === 'working' || value === 'question' || value === 'completed';
}

// validate one bounded published identity
function publishedIdentity(value: unknown): PublishedIdentity | undefined {
  // require one metadata object
  if (value === null || typeof value !== 'object') return undefined;
  const metadata = value as { name?: unknown; iconHash?: unknown };
  // require a safe name
  if (typeof metadata.name !== 'string' || metadata.name !== metadata.name.trim() || metadata.name.length === 0 || metadata.name.length > 80 || metadata.name.includes('\0')) return undefined;
  // a missing or malformed hash leaves the terminal icon
  const iconHash = typeof metadata.iconHash === 'string' && instanceIconHashPattern.test(metadata.iconHash) ? metadata.iconHash : undefined;
  return { name: metadata.name, ...(iconHash === undefined ? {} : { iconHash }) };
}

// provide stable navigation while a peer is unavailable
function unavailableStatus(server: RemoteServer): InstanceStatus {
  return { url: server.url.origin, name: server.url.hostname, attention: 'unavailable' };
}

// query identity from pre-metadata peers
async function legacyPublishedIdentity(server: RemoteServer): Promise<PublishedIdentity | undefined> {
  try {
    const response = await fetch(new URL('/api/auth/bootstrap', server.url), { headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(4_000) });
    // reject unsuccessful legacy responses
    if (!response.ok) return undefined;
    const serialized = await boundedResponseText(response, legacyMetadataResponseBytes);
    // reject oversized legacy responses
    if (serialized === undefined) return undefined;
    const payload: unknown = JSON.parse(serialized);
    // require a matching self-published origin
    if (payload === null || typeof payload !== 'object' || (payload as { server?: { url?: unknown } }).server?.url !== server.url.origin) return undefined;
    return publishedIdentity((payload as { server: unknown }).server);
  } catch {
    return undefined;
  }
}

// read one deliberately small peer response
async function boundedResponseText(response: Response, maxBytes = statusResponseBytes): Promise<string | undefined> {
  const declaredLength = Number(response.headers.get('content-length'));
  // reject declared oversize responses before streaming
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) return undefined;
  // accept an empty response stream for validation
  if (response.body === null) return '';
  const reader = response.body.getReader();
  // keep a byte-order mark so artwork hashes match the publisher's bytes
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
  let text = '';
  let bytes = 0;
  try {
    // stop reading at the fixed protocol limit
    while (true) {
      const chunk = await reader.read();
      // flush the decoder after the stream ends
      if (chunk.done) return `${text}${decoder.decode()}`;
      bytes += chunk.value.byteLength;
      // cancel an oversized or dishonest response
      if (bytes > maxBytes) {
        await reader.cancel();
        return undefined;
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

// query one configured instance without browser credentials
async function remoteInstanceStatus(server: RemoteServer, secret: string, known?: PublishedIdentity): Promise<InstanceStatus> {
  try {
    const response = await fetch(new URL('/api/instance-status', server.url), { headers: peerHeaders(secret, 'status', server.url.origin, 'application/json'), redirect: 'error', signal: AbortSignal.timeout(4_000) });
    // reject non-successful remote responses
    if (!response.ok) return unavailableStatus(server);
    const serialized = await boundedResponseText(response);
    // reject oversized remote responses
    if (serialized === undefined) return unavailableStatus(server);
    const payload: unknown = JSON.parse(serialized);
    // reject malformed remote responses
    if (payload === null || typeof payload !== 'object' || !isInstanceAttention((payload as { attention?: unknown }).attention)) return unavailableStatus(server);
    const attention = (payload as { attention: Exclude<InstanceAttention, 'unavailable'> }).attention;
    const identity = publishedIdentity(payload) ?? known ?? await legacyPublishedIdentity(server) ?? { name: server.url.hostname };
    return { url: server.url.origin, ...identity, attention };
  } catch {
    return unavailableStatus(server);
  }
}

// fetch one peer's chosen artwork; undefined means that hash is not usable static SVG, a throw means try again later
async function remoteInstanceArtwork(server: RemoteServer, secret: string, hash: string): Promise<string | undefined> {
  const response = await fetch(new URL('/api/instance-icon', server.url), { headers: peerHeaders(secret, 'icon', server.url.origin, 'image/svg+xml'), redirect: 'error', signal: AbortSignal.timeout(4_000) });
  // retry unsuccessful responses on a later poll
  if (!response.ok) throw new Error('peer artwork unavailable');
  const svg = await boundedResponseText(response, maxIconBytes);
  if (svg === undefined) return undefined;
  // artwork replaced between the status and this read is retried rather than remembered
  if (instanceIconHash(svg) !== hash) throw new Error('peer artwork changed');
  try { validateSvg(svg); return svg; }
  catch { return undefined; }
}

// coalesce identical peer polls across browser sessions
export class RemoteInstanceStatusPoller {
  private readonly cached = new Map<string, { expiresAt: number; status: InstanceStatus }>();
  private readonly pending = new Map<string, Promise<InstanceStatus>>();
  private readonly identities = new Map<string, PublishedIdentity>();
  // the last verified artwork per peer origin, kept until a newer one verifies
  private readonly artworks = new Map<string, { hash: string; svg: string }>();
  // a peer's announced hash that is not servable: refused for good, or retried after retryAt
  private readonly refused = new Map<string, { hash: string; retryAt?: number }>();

  constructor(private readonly secret: string) {}

  // query every configured peer with shared cache entries
  async statuses(servers: RemoteServer[]): Promise<InstanceStatus[]> {
    return await Promise.all(servers.map(async server => await this.status(server)));
  }

  // serve cached peer artwork by its content hash
  artwork(hash: string): string | undefined {
    for (const entry of this.artworks.values()) if (entry.hash === hash) return entry.svg;
    return undefined;
  }

  // name the artwork to publish for a peer's announced hash, fetching it only when the hash changes
  private async publishedHash(server: RemoteServer, hash: string): Promise<string | undefined> {
    const origin = server.url.origin;
    if (this.artworks.get(origin)?.hash === hash) return hash;
    const refused = this.refused.get(origin);
    if (refused?.hash !== hash || refused.retryAt !== undefined && refused.retryAt <= Date.now()) {
      try {
        const svg = await remoteInstanceArtwork(server, this.secret, hash);
        if (svg !== undefined) {
          this.artworks.set(origin, { hash, svg });
          this.refused.delete(origin);
          return hash;
        }
        this.refused.set(origin, { hash });
        this.artworks.delete(origin);
      } catch {
        this.refused.set(origin, { hash, retryAt: Date.now() + artworkRetryMs });
      }
    }
    // the previous artwork stands in while a new one is retried; artwork the peer cannot serve shows the terminal
    return this.refused.get(origin)?.retryAt === undefined ? undefined : this.artworks.get(origin)?.hash;
  }

  // reuse one fresh or in-flight peer result
  private async status(server: RemoteServer): Promise<InstanceStatus> {
    const cached = this.cached.get(server.url.origin);
    // reuse the current five-second result
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.status;
    const pending = this.pending.get(server.url.origin);
    // join an identical active poll
    if (pending !== undefined) return await pending;
    const refresh = remoteInstanceStatus(server, this.secret, this.identities.get(server.url.origin)).then(async received => {
      const known = this.identities.get(server.url.origin);
      let status: InstanceStatus = received.attention === 'unavailable' && known !== undefined ? { url: received.url, ...known, attention: received.attention } : received;
      if (status.attention !== 'unavailable') {
        const { iconHash, ...rest } = status;
        // publish a hash only once its artwork is verified and servable here
        const published = iconHash === undefined ? undefined : await this.publishedHash(server, iconHash);
        status = published === undefined ? rest : { ...rest, iconHash: published };
        // retain the last published identity across outages
        this.identities.set(server.url.origin, { name: status.name, ...(status.iconHash === undefined ? {} : { iconHash: status.iconHash }) });
      }
      this.cached.set(server.url.origin, { expiresAt: Date.now() + statusCacheMs, status });
      return status;
    }).finally(() => {
      // remove only the completed refresh
      if (this.pending.get(server.url.origin) === refresh) this.pending.delete(server.url.origin);
    });
    this.pending.set(server.url.origin, refresh);
    return await refresh;
  }
}
