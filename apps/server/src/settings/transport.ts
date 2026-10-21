import { createDecipheriv, createHash, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from 'node:crypto';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { rm } from 'node:fs/promises';
import { SettingsError, settingsRestartProgress, type HostReply, type HostRequest, type Installation, type RevealContext, type SettingsIssue } from './contracts.js';
import { readBounded, writePrivate } from './files.js';

export type SettingsTransport = { installation(): Promise<Installation | undefined>; request(request: HostRequest, wait?: boolean, published?: () => void): Promise<HostReply>; read(sourceId: string, context?: RevealContext): Promise<string | undefined>; inspect?(sourceId: string): Promise<NonNullable<HostReply['sourceMetadata']>> };
// frame disclosure identities with unambiguous bounded lengths
export function revealBinding(fields: (string | number | boolean)[]): string { return Buffer.concat([Buffer.from([1]), ...fields.flatMap(field => { const bytes = Buffer.from(String(field)); const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length); return [length, bytes]; })]).toString('base64url'); }
const pathSchema = z.string().max(4096).refine(value => isAbsolute(value) && !/[\0\r\n]/u.test(value));
// allow Docker's unlimited sentinel or bounded concurrency
const composeParallelSchema = z.number().int().refine(value => value === -1 || value >= 1 && value <= 64);
const sourceIdSchema = z.enum(['app', 'env', 'installation', 'compose', 'compose-override', 'cloudflared', 'cloudflared-credentials', 'wrapper', 'icon-heart', 'icon-potato']);
const descriptorSchema = z.object({
  version: z.literal(1), installationId: z.string().regex(/^[A-Za-z0-9_-]{12,64}$/u), generation: z.number().int().positive(), uid: z.number().int().nonnegative(), gid: z.number().int().nonnegative(), kind: z.enum(['compose', 'systemd']), hostControlRoot: pathSchema, hostCheckout: pathSchema, serverCheckout: pathSchema, allowedRoots: z.array(pathSchema).min(1).max(32),
  sources: z.record(sourceIdSchema, z.object({ path: pathSchema, serverPath: pathSchema.optional(), kind: z.enum(['json', 'env', 'compose', 'cloudflared', 'credentials', 'wrapper', 'svg', 'installation']), optional: z.boolean().optional(), apply: z.enum(['saved-only', 'rac-restart', 'cloudflared-recreate', 'live']) }).strict()),
  compose: z.object({ projectDirectory: pathSchema, projectName: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/u), files: z.array(pathSchema).min(1).max(16), envFiles: z.array(pathSchema).max(16), profiles: z.array(z.string().regex(/^[A-Za-z0-9_.-]+$/u)).max(16), options: z.object({ parallel: composeParallelSchema.optional(), compatibility: z.boolean().optional() }).strict().optional() }).strict().optional(),
  native: z.object({ unit: z.literal('remote-agent-console.service'), environmentFile: pathSchema, cloudflaredUnit: z.string().regex(/^[A-Za-z0-9_.@-]{1,128}\.service$/u).optional() }).strict().optional()
}).strict();
// check lexical containment before host realpath and ownership validation
function contained(path: string, roots: string[]): boolean { return roots.some(root => { const part = relative(resolve(root), resolve(path)); return part === '' || !part.startsWith('..') && !isAbsolute(part); }); }
// validate helper-owned handover attribution without accepting foreign identities
function migrationIssues(request: HostRequest, metadata: unknown): SettingsIssue[] {
  const parsed = z.object({ sourceIds: z.array(sourceIdSchema).min(1).max(10) }).strict().safeParse(metadata);
  if (!parsed.success || !['validate', 'commit'].includes(request.kind)) throw new SettingsError('settings_helper_invalid', 503);
  const requested = new Set((request.sources ?? []).map(source => source.id));
  // require unique source ids owned by this exact request
  if (new Set(parsed.data.sourceIds).size !== parsed.data.sourceIds.length || parsed.data.sourceIds.some(sourceId => !requested.has(sourceId))) throw new SettingsError('settings_helper_invalid', 503);
  return parsed.data.sourceIds.map(sourceId => ({ sourceId, path: [], code: 'migration_required', message: 'Source handover is required before saving.' }));
}
// validate a descriptor without treating a path or transcript as authority
export function validateInstallation(raw: unknown): Installation {
  let value: Installation;
  try { value = descriptorSchema.parse(raw); } catch { throw new SettingsError('settings_installation_invalid', 503); }
  // bound every immutable selector to installed host roots
  if (value.uid !== process.getuid?.() || value.gid !== process.getgid?.() || !contained(value.hostCheckout, value.allowedRoots) || Object.values(value.sources).some(source => !contained(source.path, value.allowedRoots)) || value.kind === 'compose' && (value.compose === undefined || !contained(value.compose.projectDirectory, value.allowedRoots) || [...value.compose.files, ...value.compose.envFiles].some(path => !contained(path, value.allowedRoots))) || value.kind === 'systemd' && (value.native === undefined || !contained(value.native.environmentFile, value.allowedRoots))) throw new SettingsError('settings_installation_invalid', 503);
  return value;
}
// resolve the out-of-band installer locator
export function settingsControlRoot(args = process.argv.slice(2)): string {
  const index = args.indexOf('--settings-control');
  return index >= 0 && typeof args[index + 1] === 'string' ? args[index + 1]! : '/run/rac-settings-control';
}

// exchange fixed queue envelopes with the host
export class HostSettingsTransport implements SettingsTransport {
  // bind one fixed control directory
  constructor(readonly root: string, private readonly timeoutMs = 60_000) {}
  // validate the private authority record
  async installation(): Promise<Installation | undefined> {
    const content = await readBounded(join(this.root, 'installation.json'), true, true);
    // report uninstalled capability honestly
    if (content === undefined) return undefined;
    let value: Installation;
    try { value = validateInstallation(JSON.parse(content)); } catch { throw new SettingsError('settings_installation_invalid', 503); }
    // reject incompatible authority and users
    return value;
  }
  // publish and await one durable host result
  async request(request: HostRequest, wait = true, published?: () => void): Promise<HostReply> {
    // restrict queue identities and protocol
    if (!/^[A-Za-z0-9_-]{20,64}$/u.test(request.id) || request.version !== 1) throw new SettingsError('invalid_settings_operation');
    await writePrivate(join(this.root, 'queued', `${request.id}.json`), JSON.stringify(request));
    // transfer staging ownership only after the atomic queue rename succeeds
    published?.();
    // return explicit asynchronous progress
    if (!wait) return { version: 1, id: request.id, kind: request.kind, state: 'queued' };
    const until = Date.now() + this.timeoutMs;
    // wait only on this operation's fixed status
    while (Date.now() < until) {
      const raw = await readBounded(join(this.root, 'status', `${request.id}.json`), true, true, 2_097_152);
      // reject substituted status envelopes
      if (raw !== undefined) {
        const result = JSON.parse(raw) as HostReply;
        // accept only matching terminal replies
        if (result.version !== 1 || result.id !== request.id || result.kind !== request.kind) throw new SettingsError('settings_helper_invalid', 503);
        const migrationRequired = result.error === 'migration-required';
        // reject metadata outside the one scoped failure contract
        if (result.errorMetadata !== undefined && (result.state !== 'failed' || !migrationRequired)) throw new SettingsError('settings_helper_invalid', 503);
        if (result.state === 'failed' && migrationRequired) throw new SettingsError('migration_required', 400, migrationIssues(request, result.errorMetadata));
        if (result.state === 'failed') throw new SettingsError(/^[a-z0-9_-]{1,80}$/u.test(result.error ?? '') ? result.error!.replaceAll('-', '_') : 'settings_helper_failed', 503);
        if (result.state === 'complete') {
          const { restart: untrustedRestart, ...safeResult } = result;
          const restart = settingsRestartProgress(untrustedRestart);
          return { ...safeResult, ...(restart ? { restart } : {}), receipt: result.receipt ?? (result as HostReply & { privateRecord?: HostReply['receipt'] }).privateRecord };
        }
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new SettingsError('settings_helper_pending', 503);
  }
  // inspect host-only identity without disclosing its bytes
  async inspect(sourceId: string): Promise<NonNullable<HostReply['sourceMetadata']>> {
    const installation = await this.installation();
    if (installation?.sources[sourceId] === undefined) throw new SettingsError('settings_source_unavailable', 503);
    const id = randomBytes(24).toString('base64url');
    try {
      const result = await this.request({ version: 1, id, kind: 'inspect', generation: installation.generation, inspect: { sourceId } });
      const metadata = result.sourceMetadata;
      // consume only this selected source's private identity metadata
      if (metadata?.sourceId !== sourceId || !/^[0-9a-f]{64}$/u.test(metadata.contentHash) || typeof metadata.existed !== 'boolean') throw new SettingsError('settings_helper_invalid', 503);
      return metadata;
    } finally { await rm(join(this.root, 'status', `${id}.json`), { force: true }); }
  }
  // transfer explicitly requested host bytes without durable plaintext
  async read(sourceId: string, context?: RevealContext): Promise<string | undefined> {
    const installation = await this.installation();
    const source = installation?.sources[sourceId];
    // restrict reads to installed source identities
    if (installation === undefined || source === undefined) throw new SettingsError('settings_source_unavailable', 503);
    // directory-bound sources are readable locally
    if (source.serverPath !== undefined) return await readBounded(source.serverPath, source.optional);
    // require explicit controller and consumed-revision disclosure context
    if (context === undefined) throw new SettingsError('settings_reveal_required', 403);
    const key = generateKeyPairSync('x25519');
    const id = randomBytes(24).toString('base64url');
    const expiresAt = Date.now() + 60_000;
    const publicKey = key.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'); const nonce = randomBytes(32).toString('base64url');
    const binding = revealBinding([installation.installationId, installation.generation, context.bootNonce, context.sessionBinding, id, sourceId, context.revisionId, context.contentHash, context.existed, nonce, expiresAt, publicKey]);
    const result = await this.request({ version: 1, id, kind: 'reveal', generation: installation.generation, reveal: { ...context, sourceId, publicKey, nonce, binding, expiresAt } });
    try {
      const envelope = result.response;
      // reject expired, replayed, or malformed ciphertext
      if (envelope === undefined || envelope.version !== 1 || envelope.binding !== binding || envelope.expiresAt !== expiresAt || Date.now() >= expiresAt || envelope.ciphertext.length > 1_400_000) throw new SettingsError('settings_reveal_unavailable', 503);
      const sender = createPublicKey({ key: Buffer.from(envelope.publicKey, 'base64url'), type: 'spki', format: 'der' });
      // reject substituted algorithms and noncanonical parameters
      if (sender.asymmetricKeyType !== 'x25519' || Buffer.from(envelope.salt, 'base64url').length !== 32) throw new SettingsError('settings_reveal_unavailable', 503);
      const secret = diffieHellman({ privateKey: key.privateKey, publicKey: sender });
      const derived = Buffer.from(hkdfSync('sha256', secret, Buffer.from(envelope.salt, 'base64url'), Buffer.concat([Buffer.from('rac-settings-reveal/v1'), createHash('sha256').update(binding).digest()]), 32));
      const iv = Buffer.from(envelope.iv, 'base64url'); const tag = Buffer.from(envelope.tag, 'base64url');
      // use the fixed gcm sizes
      if (iv.length !== 12 || tag.length !== 16) throw new SettingsError('settings_reveal_unavailable', 503);
      const cipher = createDecipheriv('aes-256-gcm', derived, iv, { authTagLength: 16 });
      cipher.setAAD(Buffer.from(binding)); cipher.setAuthTag(tag);
      try { return Buffer.concat([cipher.update(Buffer.from(envelope.ciphertext, 'base64url')), cipher.final()]).toString('utf8'); }
      finally { secret.fill(0); derived.fill(0); }
    } catch { throw new SettingsError('settings_reveal_unavailable', 503); }
    finally { await rm(join(this.root, 'status', `${id}.json`), { force: true }); }
  }
}
