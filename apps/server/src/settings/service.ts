import { createHmac, randomBytes } from 'node:crypto';
import { mkdir, open, rm } from 'node:fs/promises';
import { isIP } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import type { AgentKind } from '../adapters/types.js';
import { defaultIntegrationConfig, sourceSchema, type DavoSettings, type ValidatedConfig } from '../config/schema.js';
import { appApply, environmentDescription, envApply, knownEnvironmentKeys, labels, managedEnvironment, managedEnvironmentKeys, protectedEnvironment, protectedPath } from './catalog.js';
import { scratchHome } from '../places/places.js';
import { serverCheckout } from '../workspaces/server-checkout.js';
import { readPlaceholderRuntime, resolvedEnvironmentFallback, type EnvironmentFallbackContext, type PlaceholderRuntime } from './fallbacks.js';
import { SettingsError, settingsRestartProgress, type CloudflareStatus, type HostReceipt, type HostRequest, type Installation, type InstallationSource, type SettingsFallback, type SettingsInput, type SettingsIssue, type SettingsOperation, type SettingsSnapshot, type SettingsSource, type SettingsStatus, type SettingsTarget, type SettingsValidation } from './contracts.js';
import { credentialValues, hasEditorMarker, redactEditorSource, restoreEditorSource } from './editor-source.js';
import { environment, partitionEnvironment, patchEnvironment, restoreManagedEnvironment } from './env.js';
import { readBounded, writePrivate } from './files.js';
import { applyPatch, atPath, safePath, validPatchValue } from './patches.js';
import { applicationHash, contentHash, environmentProjection } from './proof.js';
import { applyAuthoredProjectPatch } from './project-normalization.js';
import { applicationSettingsSchema, installationSettingsPresentationSchema } from './schema.js';
import { HostSettingsTransport, revealBinding, settingsControlRoot, validateInstallation, type SettingsTransport } from './transport.js';
import { installationSettingsSchema, validateApplication, validateEnvironment, validateSvg } from './validation.js';

type Live = { name?: (name: string) => Promise<void> | void; defaultAgent?: (kind: AgentKind | undefined) => Promise<void> | void; davo?: (settings: DavoSettings) => Promise<void> | void };
type Options = { controlRoot?: string; transport?: SettingsTransport; configPath?: string; checkout?: string; live?: Live; placeholderRuntime?: () => Promise<PlaceholderRuntime> };
type Document = { source: InstallationSource; content?: string; value?: unknown; revisionId: string; hash: string; existed: boolean };
// retain helper operation kinds independently of the narrower browser contract
type StoredOperation = Omit<SettingsOperation, 'kind'> & { kind?: HostRequest['kind'] };
const patchSchema = z.object({ op: z.enum(['set', 'remove', 'insert', 'move']), path: z.array(z.string()).max(16), value: z.unknown().optional(), index: z.number().int().optional(), from: z.number().int().optional(), to: z.number().int().optional(), revisionId: z.string().max(128).optional() }).strict();
const inputSchema = z.object({ changes: z.array(z.object({ sourceId: z.string().max(64), revisionId: z.string().min(1).max(128), patches: z.array(patchSchema).max(512).optional(), content: z.string().max(1_048_576).optional(), remove: z.boolean().optional(), migration: z.object({ mode: z.enum(['copy', 'adopt', 'empty']) }).strict().optional() }).strict()).min(1).max(10) }).strict();
const hostnameSchema = z.string().min(1).max(253).refine(value => value === value.trim() && value === value.toLowerCase() && isIP(value) === 0 && !/(?:^|\.)(?:localhost|local|internal|home|lan|test|invalid|example)$/u.test(value) && value.includes('.') && value.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label)), 'invalid hostname');
const connectorTokenSchema = z.string().trim().min(1).max(8192).refine(value => !/[\s\u0000-\u001f\u007f]/u.test(value) && !/^(?:docker|cloudflared|sudo|curl|wget)$/iu.test(value));
const cloudflareInputSchema = z.discriminatedUnion('action', [z.object({ action: z.literal('connect'), token: connectorTokenSchema.optional() }).strict(), z.object({ action: z.literal('activate'), hostname: hostnameSchema }).strict()]);
const hostKindSchema = z.enum(['inspect', 'read', 'validate', 'commit', 'restart', 'reveal', 'reconcile', 'recover', 'cloudflare']);
// accept only noncredentialed http service identities
function safeServiceUrl(value: string): boolean { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && url.username === '' && url.password === '' && url.pathname === '/' && url.search === '' && url.hash === ''; } catch { return false; } }
// accept only one canonical public https origin
function safeReconnectOrigin(value: unknown): value is string { try { if (typeof value !== 'string') return false; const url = new URL(value); return url.protocol === 'https:' && url.origin === value && url.pathname === '/' && hostnameSchema.safeParse(url.hostname).success; } catch { return false; } }
const cloudflareStatusSchema = z.object({ supported: z.boolean(), reason: z.string().regex(/^[a-z0-9_-]{1,80}$/u).optional(), mode: z.enum(['unconfigured', 'token', 'local']), enabled: z.boolean(), hostname: hostnameSchema.optional(), endpoint: z.string().max(512).refine(safeReconnectOrigin).optional(), tokenPresent: z.boolean(), serviceUrl: z.string().max(512).refine(safeServiceUrl), connected: z.boolean().optional(), verifiedAt: z.string().datetime().optional() }).strict();
// redact protected leaves without changing collection shape
function redact(value: unknown, path: string[] = [], protectedValues: readonly string[] = []): unknown {
  // protect credential-bearing structured leaves
  if (protectedPath(path)) {
    const present = value !== undefined;
    return { __racProtected: true, present, ...(present && (value === '' || value === null) ? { hasValue: false } : {}) };
  }
  // protect any ordinary string that repeats a credential from another source
  if (typeof value === 'string' && protectedValues.some(secret => secret.length > 0 && value.includes(secret))) return { __racProtected: true, present: true };
  // retain safe array rows for collection editing
  if (Array.isArray(value)) return value.map((child, index) => redact(child, [...path, String(index)], protectedValues));
  // retain safe object properties only
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redact(child, [...path, key], protectedValues)]));
  return value;
}
// expose resolved defaults only after controller authorization and credential filtering
function safeEnvironmentFallback(key: string, protectedValue: boolean, protectedValues: readonly string[], composeOwned: boolean, context: EnvironmentFallbackContext): SettingsFallback | undefined {
  // custom variables have no RAC-owned omission contract
  if (!knownEnvironmentKeys.some(known => known === key)) return undefined;
  const catalogued = resolvedEnvironmentFallback(key, context);
  // protected fields may describe omission but never carry concrete bytes
  if (protectedValue) return !protectedEnvironment(key) ? undefined : composeOwned ? { value: 'Hidden (from Compose environment)', kind: 'derived' } : catalogued?.kind === 'derived' ? catalogued : undefined;
  let fallback = catalogued;
  // preserve confirmed Compose ownership except for explicit runtime blank fallbacks
  if (composeOwned && !(key === 'RAC_HOST_NODE_BIN' && (process.env[key] === undefined || process.env[key]!.trim() === ''))) {
    const running = process.env[key];
    // missing, empty, and oversized values expose no substitute default
    if (running === undefined || running.trim().length === 0 || running.length > 4_096) return undefined;
    fallback = { value: `${running} (from Compose environment)`, kind: 'compose' };
  }
  const runtimeSecrets = [...knownEnvironmentKeys, ...managedEnvironmentKeys].filter(protectedEnvironment).map(protectedKey => process.env[protectedKey]).filter((secret): secret is string => secret !== undefined && secret.length > 0);
  // derived paths and application defaults can repeat credentials across sources too
  if (fallback !== undefined && (fallback.value.length > 4_096 || [...protectedValues, ...runtimeSecrets].some(secret => secret.length > 0 && fallback.value.includes(secret)))) return undefined;
  return fallback;
}
// compare only the narrowly supported live runtime values
function liveProjection(value: { name: string; defaultAgent?: AgentKind; integrations?: ValidatedConfig['integrations'] }): string {
  const voice = (value.integrations ?? defaultIntegrationConfig).realtime;
  return JSON.stringify({ name: value.name, defaultAgent: value.defaultAgent, voice: { enabled: voice.enabled, name: voice.name, context: voice.context } });
}
// compare only file-owned environment values against independently consumed proof
function environmentMatches(content: string, receipt: HostReceipt): boolean {
  // retain compatibility with receipts from before per-field ownership proof
  if (receipt.environmentFileHashes === undefined) return receipt.semanticHashes?.env === contentHash(environmentProjection(content));
  const values = environment(content); const expected = receipt.environmentFileHashes; const shadowed = new Set(receipt.shadowedEnvironmentKeys ?? []);
  return [...new Set([...Object.keys(values), ...Object.keys(expected)])].filter(key => envApply(key) !== 'saved-only' && !shadowed.has(key)).every(key => values[key] === undefined ? expected[key] === undefined : contentHash(values[key]) === expected[key]);
}
// retain tunnel activation without exposing profiles as a separate installation control
function automaticInstallationProfiles(content: string, installation: Installation): string {
  const active = ['cloudflared', 'cloudflared-credentials'].some(id => installation.sources[id]?.apply === 'cloudflared-recreate');
  const managedToken = installation.compose?.profiles.includes('tunnel-token') === true;
  // file presence alone never enables a tunnel or changes a native installation
  if (installation.kind !== 'compose' || !active && !managedToken) return content;
  try {
    const value = JSON.parse(content) as { compose?: { profiles: string[] } };
    // leave invalid or sparse input to existing validation rather than inventing deployment data
    if (!installationSettingsSchema.safeParse(value).success || value.compose === undefined) return content;
    // preserve the helper-managed token profile without enabling the legacy local tunnel
    if (managedToken && !value.compose.profiles.includes('tunnel-token')) return `${JSON.stringify({ ...value, compose: { ...value.compose, profiles: [...value.compose.profiles, 'tunnel-token'] } }, null, 2)}\n`;
    // retain an existing managed or legacy activation profile unchanged
    if (managedToken || value.compose.profiles.includes('tunnel')) return content;
    return `${JSON.stringify({ ...value, compose: { ...value.compose, profiles: [...value.compose.profiles, 'tunnel'] } }, null, 2)}\n`;
  } catch {
    // keep malformed source bytes intact for the existing safe validation error
    return content;
  }
}
// operate on files through one revisioned fixed host boundary
export class SettingsService {
  readonly controlRoot: string;
  private readonly transport: SettingsTransport;
  private readonly options: Options;
  private revisionKey = randomBytes(32);
  private keyReady?: Promise<void>;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly leases = new Map<string, { sessionId: string; expires: number; sourceId: string; revisionId: string; path: string[] }>();
  private liveState: string;
  private revisionIdentity = ['uninstalled', '0'];
  private sourceIdentities = new Map<string, string[]>();
  private desiredInstallation?: Installation;
  private placeholderCache?: { key: string; expires: number; value: Promise<PlaceholderRuntime> };
  // bind installation identity without an editable environment locator
  constructor(private readonly config: ValidatedConfig, options: Options = {}) { this.options = options; this.controlRoot = options.controlRoot ?? settingsControlRoot(); this.transport = options.transport ?? new HostSettingsTransport(this.controlRoot); this.liveState = liveProjection(config); }
  // share bounded read-only runtime lookups without letting draft values execute commands
  private placeholderRuntime(): Promise<PlaceholderRuntime> {
    const key = JSON.stringify([process.env.RAC_TMUX_BIN, process.env.RAC_HOST_TMUX_DIR, process.env.RAC_HOST_PATH, process.env.PATH]);
    // refresh inherited tmux PATH facts while deduplicating simultaneous snapshots
    if (this.placeholderCache?.key === key && this.placeholderCache.expires > Date.now()) return this.placeholderCache.value;
    const value = (this.options.placeholderRuntime ?? readPlaceholderRuntime)().catch(() => ({}));
    this.placeholderCache = { key, expires: Date.now() + 10_000, value };
    return value;
  }
  // persist opaque revision framing without storing source values
  private async initializeKey(): Promise<void> {
    // initialize once per process
    if (this.keyReady !== undefined) return await this.keyReady;
    this.keyReady = (async () => {
      const installation = await this.transport.installation();
      // keep uninstalled reads ephemeral and read-only
      if (installation === undefined) return;
      const path = join(this.controlRoot, 'revision.key');
      await mkdir(this.controlRoot, { recursive: true, mode: 0o700 });
      try { const file = await open(path, 'wx', 0o600); try { await file.writeFile(this.revisionKey.toString('base64url')); await file.sync(); } finally { await file.close(); } }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      const key = await readBounded(path, false, true);
      // reject substituted framing keys
      if (key === undefined || !/^[A-Za-z0-9_-]{43}$/u.test(key)) throw new SettingsError('settings_metadata_invalid', 503);
      this.revisionKey = Buffer.from(key, 'base64url');
    })();
    return await this.keyReady;
  }
  // never publish low-entropy raw source hashes
  private revision(id: string, content: unknown): string { return createHmac('sha256', this.revisionKey).update(Buffer.from(revealBinding(['rac-settings-revision/v1', ...this.revisionIdentity, id, ...(this.sourceIdentities.get(id.split(':')[0]!) ?? []), JSON.stringify(content)]), 'base64url')).digest('base64url'); }
  // use the installed allowlist or one honest read-only app source
  private async installation(): Promise<Installation | undefined> {
    await this.initializeKey(); const installation = await this.transport.installation();
    const desired = installation === undefined ? undefined : await this.metadata<Installation>('desired-installation.json');
    this.desiredInstallation = desired === undefined ? undefined : validateInstallation(desired);
    // bind pending handovers to the same installed capability and next generation
    if (installation !== undefined && this.desiredInstallation !== undefined && (this.desiredInstallation.installationId !== installation.installationId || this.desiredInstallation.hostControlRoot !== installation.hostControlRoot || ![installation.generation, installation.generation + 1].includes(this.desiredInstallation.generation))) throw new SettingsError('settings_metadata_invalid', 503);
    this.revisionIdentity = [installation?.installationId ?? 'uninstalled', String(installation?.generation ?? 0), String(this.desiredInstallation?.generation ?? installation?.generation ?? 0)];
    this.sourceIdentities = new Map(Object.entries(installation?.sources ?? {}).map(([id, source]) => [id, [source.path, source.serverPath ?? '', this.desiredInstallation?.sources[id]?.path ?? source.path, this.desiredInstallation?.sources[id]?.serverPath ?? source.serverPath ?? '']]));
    return installation;
  }
  // read current bytes instead of cached settings values
  private async documents(installation: Installation | undefined): Promise<Map<string, Document>> {
    const fallbackPath = this.options.configPath ?? process.env.RAC_CONFIG;
    const sources: Record<string, InstallationSource> = installation?.sources ?? (fallbackPath === undefined ? {} : { app: { path: fallbackPath, serverPath: fallbackPath, kind: 'json', apply: 'rac-restart' } });
    const documents = new Map<string, Document>();
    // read every installed source without persisting disclosure plaintext
    for (const [id, source] of Object.entries(sources)) {
      let content: string | undefined; let inspected: { contentHash: string; existed: boolean } | undefined;
      // host-only sources disclose only private identity metadata by default
      if (installation !== undefined && source.serverPath === undefined) {
        // inspection failure is not proof that an optional source is absent
        if (this.transport.inspect === undefined) throw new SettingsError('settings_inspection_unavailable', 503);
        inspected = await this.transport.inspect(id);
      } else content = installation === undefined ? await readBounded(source.path, source.optional) : await this.transport.read(id);
      let value: unknown;
      // preserve invalid external JSON as protected source repair mode
      if (content !== undefined && ['json', 'installation'].includes(source.kind)) { try { value = JSON.parse(content); } catch { value = undefined; } }
      const hash = inspected?.contentHash ?? contentHash(content); const existed = inspected?.existed ?? content !== undefined;
      documents.set(id, { source, content, value, hash, existed, revisionId: this.revision(id, [hash, existed]) });
    }
    return documents;
  }
  // read one revision-bound host source only for its authenticated controller
  private async sourceContent(installation: Installation | undefined, id: string, doc: Document, sessionId?: string): Promise<string | undefined> {
    // reuse locally available bytes without another disclosure exchange
    if (doc.content !== undefined || !doc.existed) return doc.content;
    // host-only bytes require the current browser session binding
    if (installation === undefined || sessionId === undefined) return undefined;
    const boot = await this.metadata<{ bootNonce: string }>('boot.json');
    const content = await this.transport.read(id, { bootNonce: boot?.bootNonce ?? '', sessionBinding: this.revision('controller', sessionId), revisionId: doc.revisionId, contentHash: doc.hash, existed: doc.existed });
    // refuse bytes that changed after the identity inspection
    if (content === undefined || contentHash(content) !== doc.hash) throw new SettingsError('settings_conflict', 409);
    return content;
  }
  // recognize one active whole-source disclosure without retaining its plaintext
  private wholeSourceDisclosed(sessionId: string | undefined, sourceId: string, revisionId: string): boolean {
    const now = Date.now();
    // prune expired capabilities before authorization
    for (const [id, lease] of this.leases) if (lease.expires < now) this.leases.delete(id);
    return sessionId !== undefined && [...this.leases.values()].some(lease => lease.sessionId === sessionId && lease.sourceId === sourceId && lease.revisionId === revisionId && lease.path.length === 0);
  }
  // provide safe property revisions for narrow nonsecret rebases
  private pathRevisions(id: string, value: unknown, path: string[] = [], result: Record<string, string> = {}, root: unknown = value): Record<string, string> {
    // omit protected subtrees from rebase capabilities
    if (protectedPath(path)) return result;
    result[JSON.stringify(path)] = this.pathRevision(id, root, path);
    // include exact object and array identities
    if (value !== null && typeof value === 'object') for (const [key, child] of Object.entries(value)) this.pathRevisions(id, child, [...path, key], result, root);
    return result;
  }
  // bind indexed fields to their containing collection, not just equal leaf values
  private pathRevision(id: string, root: unknown, path: string[]): string {
    const collections: unknown[] = []; let value = root;
    // preserve every indexed ancestor identity across stale document edits
    for (const part of path) {
      // a reordered or replaced row invalidates its old field capability
      if (Array.isArray(value)) collections.push(value);
      value = atPath(value, [part]);
    }
    return this.revision(`${id}:path:${JSON.stringify(path)}`, [value ?? null, collections]);
  }
  // expose no raw secret-bearing defaults
  async snapshot(controller = true, sessionId?: string): Promise<SettingsSnapshot> {
    const installation = await this.installation(); const documents = await this.documents(installation);
    const effective = installation === undefined ? undefined : await this.metadata<{ targets?: { rac?: HostReceipt } }>('effective.json');
    const shadowedEnvironment = new Set(effective?.targets?.rac?.shadowedEnvironmentKeys ?? []);
    // trust ownership only from this Compose installation generation
    const confirmedComposeOwnership = installation?.kind === 'compose' && effective?.targets?.rac?.generation === installation.generation;
    const contents = new Map<string, string>();
    // read each controller-visible source once before cross-source credential redaction
    for (const [id, doc] of documents) {
      const content = controller ? await this.sourceContent(installation, id, doc, sessionId) : doc.content;
      if (content !== undefined) contents.set(id, content);
    }
    const protectedValues = [...contents].flatMap(([id, content]) => credentialValues(content, documents.get(id)!.source.kind));
    let application: unknown;
    try { application = JSON.parse(contents.get('app') ?? 'null'); } catch { /* invalid sources have no provable dependent defaults */ }
    const fallbackContext: EnvironmentFallbackContext = { application, environment: environment(contents.get('env') ?? ''), installation, configPath: this.options.configPath, checkout: this.options.checkout ?? serverCheckout(), home: process.env.HOME ?? homedir(), ...(controller ? { runtime: await this.placeholderRuntime() } : {}) };
    // dynamic schema guidance must obey the same cross-source credential boundary
    const safePlaceholderPath = (value: string | undefined): string | undefined => value !== undefined && protectedValues.some(secret => secret.length > 0 && value.includes(secret)) ? undefined : value;
    const scratchDirectory = controller ? safePlaceholderPath(await scratchHome(undefined, this.config.projects)) : undefined;
    const sources: SettingsSource[] = [];
    // describe each current authoritative source
    for (const [id, doc] of documents) {
      const currentContent = contents.get(id);
      let currentValue = doc.value;
      // parse controller-disclosed host JSON for the structured editor only
      if (currentValue === undefined && currentContent !== undefined && ['json', 'installation'].includes(doc.source.kind)) {
        try { currentValue = JSON.parse(currentContent); } catch { currentValue = undefined; }
      }
      const editorContent = currentContent !== undefined && doc.source.kind === 'env' ? partitionEnvironment(currentContent, managedEnvironmentKeys).visible : currentContent;
      const editor = editorContent === undefined ? undefined : redactEditorSource(editorContent, doc.source.kind, doc.revisionId, protectedValues);
      const hasProtectedContent = editor?.hasProtectedContent ?? (doc.source.serverPath === undefined && doc.existed);
      const source: SettingsSource = { id, label: labels[id] ?? id, ...(controller ? { path: doc.source.path } : {}), format: doc.source.kind, exists: doc.existed, writable: controller && installation !== undefined, protected: hasProtectedContent, tracked: id === 'compose', revisionId: doc.revisionId, apply: id === 'installation' ? 'source-migration' : doc.source.apply, ...(controller && editor !== undefined ? { content: editor.content } : {}), hasProtectedContent, origin: 'Current installation file' };
      // derive strict recursive controls from the actual source schema
      if (doc.source.kind === 'json' || doc.source.kind === 'installation') {
        if (controller) source.value = redact(currentValue, [], protectedValues);
        source.schema = doc.source.kind === 'installation' ? installationSettingsPresentationSchema(installationSettingsSchema, controller ? safePlaceholderPath(installation?.hostCheckout) : undefined) : applicationSettingsSchema({ scratchDirectory });
        if (controller) source.pathRevisions = this.pathRevisions(id, currentValue);
      }
      // enumerate known and unknown dotenv entries without adjacent disclosure
      if (doc.source.kind === 'env') {
        const values = environment(currentContent ?? '');
        source.fields = [...new Set([...knownEnvironmentKeys, ...Object.keys(values).filter(key => !managedEnvironment(key))])].map(key => {
          const value = values[key];
          const present = Object.hasOwn(values, key);
          const protectedValue = protectedEnvironment(key) || value !== undefined && protectedValues.some(secret => secret.length > 0 && value.includes(secret));
          // distinguish confirmed conflicts from equal values or pending file edits
          const composeOwned = confirmedComposeOwnership && shadowedEnvironment.has(key);
          const winningSource = composeOwned && present && process.env[key] !== undefined && value !== process.env[key] ? 'Compose environment' : undefined;
          const fallback = controller ? safeEnvironmentFallback(key, protectedValue, protectedValues, composeOwned, fallbackContext) : undefined;
          // retain configured-empty semantics separately from the omitted-value hint
          const emptyValueHint = controller && !composeOwned && present && value === '' && key !== 'RAC_HOST_NODE_BIN' ? 'Empty (from explicit environment assignment)' : undefined;
          return { key, ...(emptyValueHint === undefined ? {} : { emptyValueHint }), description: environmentDescription(key), protected: protectedValue, present, ...(protectedValue && present && value === '' ? { hasValue: false } : {}), apply: shadowedEnvironment.has(key) ? 'saved-only' : envApply(key), ...(controller && !protectedValue && value !== undefined ? { value } : {}), ...(fallback === undefined ? {} : { fallback }), origin: 'Environment file', ...(winningSource === undefined ? {} : { winningSource }), ...(shadowedEnvironment.has(key) ? { overriddenBy: 'Compose owns this value. Editing this environment entry has no current effect; edit its Compose source instead.' } : present && process.env[key] !== undefined && values[key] !== process.env[key] ? { overriddenBy: 'The running process differs: this file may be pending or overridden by Compose/inherited environment.' } : {}) };
        });
      }
      // retain the legacy structured icon value for controller previews
      if (controller && doc.source.kind === 'svg') source.value = currentContent ?? '';
      sources.push(source);
    }
    // expose only the installed mode, never infer it from editable desired branches
    return { version: 1, ...(installation === undefined ? {} : { installationKind: installation.kind }), revisionId: this.revision('snapshot', sources.map(source => source.revisionId)), sources, status: await this.computeStatus(installation, documents) };
  }
  // read private proof records without returning their hashes
  private async metadata<T>(name: string): Promise<T | undefined> { const raw = await readBounded(join(this.controlRoot, name), true, true, 2_097_152); try { return raw === undefined ? undefined : JSON.parse(raw) as T; } catch { throw new SettingsError('settings_metadata_invalid', 503); } }
  // retain only bounded public operation fields
  private publicOperation(value: unknown): SettingsOperation | undefined {
    const operation = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{20,64}$/u), state: z.enum(['queued', 'running', 'complete', 'failed']), kind: hostKindSchema.optional(), phase: z.string().regex(/^[a-z0-9_-]{1,80}$/u).optional(), error: z.string().regex(/^[a-z0-9_-]{1,80}$/u).optional() }).passthrough().safeParse(value);
    // ignore malformed pointers without granting them authority
    if (!operation.success) return undefined;
    const restart = settingsRestartProgress(operation.data.restart);
    return { id: operation.data.id, state: operation.data.state, ...(operation.data.kind === 'cloudflare' ? { kind: operation.data.kind } : {}), ...(operation.data.phase ? { phase: operation.data.phase } : {}), ...(operation.data.error ? { error: operation.data.error } : {}), ...(restart ? { restart } : {}) };
  }
  // follow one durable deployment pointer without trusting arbitrary metadata
  private async deployment(kind?: HostRequest['kind']): Promise<{ operation: SettingsOperation; kind?: HostRequest['kind']; cloudflare?: Omit<CloudflareStatus, 'operation' | 'reconnectOrigin'>; reconnectOrigin?: string } | undefined> {
    const pointer = await this.metadata<Record<string, unknown>>('latest-deploy.json');
    const pointed = this.publicOperation(pointer);
    // retain an honestly absent deployment pointer
    if (pointer === undefined) return undefined;
    const pointerKind = hostKindSchema.safeParse(pointer.kind);
    // fail closed on a substituted deployment pointer
    if (pointed === undefined || !pointerKind.success) throw new SettingsError('settings_metadata_invalid', 503);
    // ignore a valid unrelated deployment
    if (kind !== undefined && pointerKind.data !== kind) return undefined;
    const status = await this.metadata<Record<string, unknown>>(`status/${pointed.id}.json`);
    const current = status === undefined ? pointed : this.publicOperation(status);
    // bind terminal status to the exact pointed operation
    if (current === undefined || status !== undefined && (status.id !== pointed.id || status.kind !== pointer.kind)) throw new SettingsError('settings_metadata_invalid', 503);
    const parsedCloudflare = status?.cloudflare === undefined ? undefined : cloudflareStatusSchema.safeParse(status.cloudflare);
    // reject substituted host status data rather than passing it to browsers
    if (parsedCloudflare !== undefined && !parsedCloudflare.success) throw new SettingsError('settings_metadata_invalid', 503);
    const reconnectOrigin = safeReconnectOrigin(pointer.reconnectOrigin) ? pointer.reconnectOrigin : undefined;
    return { operation: current, kind: pointerKind.data, ...(parsedCloudflare?.success ? { cloudflare: parsedCloudflare.data } : {}), ...(reconnectOrigin ? { reconnectOrigin } : {}) };
  }
  // refuse overlapping host mutations while one deployment owns the helper lock
  private async ensureNoDeployment(): Promise<void> {
    const current = await this.deployment();
    // keep all staged writes behind the active deployment
    if (current !== undefined && ['queued', 'running'].includes(current.operation.state)) throw new SettingsError('settings_operation_in_progress', 409);
  }
  // compare saved files with independently proved effective targets
  private async computeStatus(installation: Installation | undefined, documents: Map<string, Document>): Promise<SettingsStatus> {
    // fail closed when bootstrap capability is absent
    if (installation === undefined) return { pending: false, targets: [], effective: 'unknown', restartAvailable: false, reason: 'Settings host applier is not installed. Run scripts/install-settings-applier.sh on this host.' };
    const effective = await this.metadata<{ version: number; targets: Partial<Record<SettingsTarget, HostReceipt>> }>('effective.json');
    const liveFailure = await this.metadata<{ revisionId: string }>('live-pending.json');
    const targets = new Set<SettingsTarget>(); let known = true;
    // retain each independently required target
    for (const [id, doc] of documents) {
      // dormant files never manufacture a restart requirement
      if (doc.source.apply === 'saved-only' || doc.source.apply === 'live') continue;
      const target: SettingsTarget = doc.source.apply === 'cloudflared-recreate' ? 'cloudflared' : 'rac';
      const receipt = effective?.targets?.[target];
      // unproven startup is unknown, not fabricated success
      if (receipt === undefined || receipt.generation !== installation.generation) { known = false; targets.add(target); continue; }
      const matches = id === 'app' && doc.value !== undefined && receipt.semanticHashes?.app !== undefined ? receipt.semanticHashes.app === applicationHash(doc.value) : id === 'env' && doc.content !== undefined && (receipt.environmentFileHashes !== undefined || receipt.semanticHashes?.env !== undefined) ? environmentMatches(doc.content, receipt) : receipt.hashes[id] === doc.hash;
      if (!matches) targets.add(target);
    }
    // a failed live callback remains pending until replacement proof
    if (liveFailure !== undefined && effective?.targets.rac?.hashes.app !== documents.get('app')?.hash) targets.add('rac');
    const savedApplication = sourceSchema.safeParse(documents.get('app')?.value);
    // external live-field edits are not effective until a callback or boot consumes them
    if (savedApplication.success && liveProjection(savedApplication.data) !== this.liveState) targets.add('rac');
    let latest = await this.metadata<StoredOperation>('latest-deploy.json');
    // legacy restart discovery must not promote read-only connector inspections
    if (latest === undefined) {
      const legacy = await this.metadata<StoredOperation>('latest.json');
      // only the deployment pointer grants Cloudflare mutation ownership
      if (legacy?.kind === 'restart' || legacy?.kind === 'reconcile') latest = legacy;
    }
    // follow the persisted deployment identity instead of transient read operations
    if (latest !== undefined) latest = await this.metadata<StoredOperation>(`status/${latest.id}.json`) ?? latest;
    const restart = settingsRestartProgress(latest?.restart);
    const operation = latest !== undefined && ['restart', 'reconcile', 'cloudflare'].includes(latest.kind ?? '') ? { id: latest.id, state: latest.state, ...(latest.kind === 'cloudflare' ? { kind: 'cloudflare' as const } : {}), ...(latest.phase ? { phase: latest.phase } : {}), ...(latest.error ? { error: /^[a-z0-9_-]{1,80}$/u.test(latest.error) ? latest.error : 'Settings apply failed.' } : {}), ...(restart ? { restart } : {}) } : undefined;
    const env = environment(documents.get('env')?.content ?? '');
    const reloginRequired = ['RAC_SESSION_SECRET', 'RAC_PASSWORD_HASH'].some(key => env[key] !== undefined && env[key] !== process.env[key]);
    const publicOrigin = atPath(documents.get('app')?.value, ['publicOrigin']);
    return { pending: targets.size > 0, targets: [...targets], effective: known ? 'known' : 'unknown', restartAvailable: true, recoveryCommand: `~/.local/bin/rac-settings-recover ${installation.installationId}`, ...(operation ? { operation } : {}), ...(typeof publicOrigin === 'string' && publicOrigin !== this.config.publicOrigin.origin ? { reconnectOrigin: publicOrigin } : {}), ...(reloginRequired ? { reloginRequired: true } : {}) };
  }
  // refresh durable status for every authenticated browser
  async status(): Promise<SettingsStatus> { const installation = await this.installation(); return await this.computeStatus(installation, await this.documents(installation)); }
  // cache only validated noncredential Cloudflare status
  private async cacheCloudflare(value: unknown): Promise<Omit<CloudflareStatus, 'operation' | 'reconnectOrigin'>> {
    const parsed = cloudflareStatusSchema.safeParse(value);
    // refuse malformed helper data instead of partially exposing it
    if (!parsed.success) throw new SettingsError('settings_helper_invalid', 503);
    await writePrivate(join(this.controlRoot, 'cloudflare-status.json'), JSON.stringify(parsed.data));
    return parsed.data;
  }
  // read only the redacted server-owned Cloudflare cache
  private async cachedCloudflare(): Promise<Omit<CloudflareStatus, 'operation' | 'reconnectOrigin'> | undefined> {
    const value = await this.metadata<unknown>('cloudflare-status.json');
    // retain an honestly absent cache
    if (value === undefined) return undefined;
    const parsed = cloudflareStatusSchema.safeParse(value);
    // reject a substituted cache
    if (!parsed.success) throw new SettingsError('settings_metadata_invalid', 503);
    return parsed.data;
  }
  // request one bounded helper status outside active deployment windows
  private async queryCloudflare(installation: Installation): Promise<Omit<CloudflareStatus, 'operation' | 'reconnectOrigin'>> {
    const id = randomBytes(24).toString('base64url');
    try {
      const result = await this.transport.request({ version: 1, id, kind: 'cloudflare', generation: installation.generation, cloudflare: { action: 'status' } });
      return await this.cacheCloudflare(result.cloudflare);
    } finally { await rm(join(this.controlRoot, 'status', `${id}.json`), { force: true }); }
  }
  // expose current connector state without disclosing its token or host paths
  async cloudflareStatus(): Promise<CloudflareStatus> { return await this.serialized(async () => {
    const installation = await this.installation();
    // describe unavailable setup without inventing installed host state
    if (installation === undefined) return { supported: false, reason: 'settings_applier_unavailable', mode: 'unconfigured', enabled: false, tokenPresent: false, serviceUrl: `http://127.0.0.1:${this.config.listen.port}` };
    const latestDeployment = await this.deployment();
    // never queue a status request behind a long-running host operation
    if (latestDeployment !== undefined && ['queued', 'running'].includes(latestDeployment.operation.state)) {
      const cached = await this.cachedCloudflare();
      // report an honest temporary failure before the first cache exists
      if (cached === undefined) throw new SettingsError('cloudflare_status_pending', 503);
      return { ...cached, ...(latestDeployment.kind === 'cloudflare' ? { operation: latestDeployment.operation } : {}) };
    }
    const deployment = latestDeployment?.kind === 'cloudflare' ? latestDeployment : undefined;
    // consume terminal host proof before making another status request
    if (deployment?.cloudflare !== undefined) {
      await this.cacheCloudflare(deployment.cloudflare);
      // refresh idle liveness so terminal proof never freezes future connector state
      const current = await this.queryCloudflare(installation);
      const activated = deployment.operation.state === 'complete' && deployment.operation.phase === 'activated';
      return { ...current, operation: deployment.operation, ...(activated && deployment.reconnectOrigin ? { reconnectOrigin: deployment.reconnectOrigin } : {}) };
    }
    const current = await this.queryCloudflare(installation);
    return { ...current, ...(deployment ? { operation: deployment.operation } : {}) };
  }); }
  // stage one private connector action and publish only its operation identity
  async configureCloudflare(input: unknown): Promise<{ operation: SettingsOperation; reconnectOrigin?: string }> { return await this.serialized(async () => {
    const parsed = cloudflareInputSchema.safeParse(input);
    // reject malformed or cross-action fields before staging credentials
    if (!parsed.success) throw new SettingsError('invalid_cloudflare_request');
    const installation = await this.installation();
    // require installed helper authority before host setup
    if (installation === undefined) throw new SettingsError('settings_applier_unavailable', 503);
    await this.ensureNoDeployment();
    const current = await this.queryCloudflare(installation);
    // allow setup only through the supported Compose helper
    if (!current.supported || installation.kind !== 'compose') throw new SettingsError('cloudflare_setup_unsupported', 409);
    // require the connector phase before public route verification
    if (parsed.data.action === 'activate' && (current.mode !== 'token' || !current.enabled || !current.tokenPresent || current.connected !== true)) throw new SettingsError('cloudflare_connector_not_ready', 409);
    const documents = await this.documents(installation);
    const app = documents.get('app'); const installationDocument = documents.get('installation');
    // require both source identities for host compare-and-swap
    if (app === undefined || installationDocument === undefined) throw new SettingsError('cloudflare_setup_unsupported', 409);
    // avoid applying unrelated saved changes during the activating RAC restart
    if (parsed.data.action === 'activate') {
      const settingsStatus = await this.computeStatus(installation, documents);
      // keep unrelated pending files out of the activation restart
      if (settingsStatus.pending) throw new SettingsError('settings_changes_pending', 409);
    }
    const id = randomBytes(24).toString('base64url'); const operation: SettingsOperation = { id, state: 'queued', kind: 'cloudflare' }; let published = false;
    const reconnectOrigin = parsed.data.action === 'activate' ? `https://${parsed.data.hostname}` : undefined;
    try {
      await writePrivate(join(this.controlRoot, 'staging', id, 'cloudflare-connect'), JSON.stringify(parsed.data));
      await this.transport.request({ version: 1, id, kind: 'cloudflare', generation: installation.generation, sources: [{ id: 'app', contentHash: app.hash, existed: app.existed }, { id: 'installation', contentHash: installationDocument.hash, existed: installationDocument.existed }], cloudflare: { action: parsed.data.action, candidate: 'cloudflare-connect' } }, false, () => { published = true; });
      await writePrivate(join(this.controlRoot, 'latest-deploy.json'), JSON.stringify({ ...operation, kind: 'cloudflare', cloudflareAction: parsed.data.action, ...(reconnectOrigin ? { reconnectOrigin } : {}) }));
      this.leases.clear();
      return { operation, ...(reconnectOrigin ? { reconnectOrigin } : {}) };
    } finally { await this.cleanupStage(id, published); }
  }); }
  // resolve one current installed source without accepting a browser-selected path
  async editorFile(sourceId: string, revisionId: string): Promise<string> {
    const installation = await this.installation();
    // require the installed host allowlist
    if (installation === undefined) throw new SettingsError('settings_applier_unavailable', 503);
    const document = (await this.documents(installation)).get(sourceId);
    // expose neither unknown nor absent source paths
    if (document === undefined || !document.existed) throw new SettingsError('settings_source_unavailable', 404);
    // bind the launch to the bytes represented in the settings UI
    if (document.revisionId !== revisionId) throw new SettingsError('settings_conflict', 409);
    return document.source.path;
  }
  // serialize local preparation while the helper owns host mutation locking
  private async serialized<T>(action: () => Promise<T>): Promise<T> { const pending = this.tail.catch(() => undefined).then(action); this.tail = pending; return await pending; }
  // construct candidates from freshly read file truth
  private async prepare(input: unknown, id: string, sessionId?: string): Promise<{ installation: Installation; request: HostRequest; documents: Map<string, Document>; candidates: Map<string, string | undefined>; issues: SettingsIssue[] }> {
    const parsed = inputSchema.safeParse(input);
    // reject malformed input without echoing rejected values
    if (!parsed.success) throw new SettingsError('invalid_settings_request');
    const installation = await this.installation();
    if (installation === undefined) throw new SettingsError('settings_applier_unavailable', 503);
    await this.ensureNoDeployment();
    const documents = await this.documents(installation); const candidates = new Map<string, string | undefined>(); const sources: NonNullable<HostRequest['sources']> = [];
    const sourceContents = new Map<string, string>();
    // retain already-local bytes as validation baselines
    for (const [sourceId, document] of documents) if (document.content !== undefined) sourceContents.set(sourceId, document.content);
    let editorProtectedValues: string[] = [];
    // load one complete credential context only for whole-source editor submissions
    if (parsed.data.changes.some(change => change.content !== undefined)) {
      for (const [sourceId, document] of documents) {
        const content = await this.sourceContent(installation, sourceId, document, sessionId);
        if (content !== undefined) sourceContents.set(sourceId, content);
      }
      editorProtectedValues = [...sourceContents].flatMap(([sourceId, content]) => credentialValues(content, documents.get(sourceId)!.source.kind));
    }
    // load complete application and environment truth for cross-source validation
    for (const sourceId of ['app', 'env']) {
      const document = documents.get(sourceId);
      // retrieve only an existing host-only validation dependency
      if (document === undefined || !document.existed || sourceContents.has(sourceId)) continue;
      const content = await this.sourceContent(installation, sourceId, document, sessionId);
      if (content === undefined) throw new SettingsError('settings_reveal_required', 403);
      sourceContents.set(sourceId, content);
    }
    // apply each explicit source intent once
    for (const change of parsed.data.changes) {
      const doc = documents.get(change.sourceId);
      if (doc === undefined || candidates.has(change.sourceId) || change.content !== undefined && change.patches !== undefined || change.remove && (change.content !== undefined || change.patches !== undefined)) throw new SettingsError('invalid_settings_source');
      let baselineContent = sourceContents.get(change.sourceId) ?? doc.content;
      let baselineValue = doc.value;
      // retrieve the authenticated current source before applying typed host-only edits
      if (change.patches !== undefined && baselineContent === undefined && doc.existed) {
        baselineContent = await this.sourceContent(installation, change.sourceId, doc, sessionId);
        if (baselineContent === undefined) throw new SettingsError('settings_reveal_required', 403);
        sourceContents.set(change.sourceId, baselineContent);
      }
      // parse the freshly disclosed JSON so patches preserve every sibling property
      if (change.patches !== undefined && baselineContent !== undefined && ['json', 'installation'].includes(doc.source.kind)) {
        try { baselineValue = JSON.parse(baselineContent); } catch { baselineValue = undefined; }
      }
      const desiredSource = this.desiredInstallation?.sources[change.sourceId];
      // avoid editing an old owner after its replacement file has already been prepared
      if (change.sourceId !== 'installation' && this.desiredInstallation !== undefined && (desiredSource?.path !== doc.source.path || desiredSource.serverPath !== doc.source.serverPath)) throw new SettingsError('source_migration_restart_required', 409);
      // protected or structural edits require an exact document revision
      if (change.revisionId !== doc.revisionId) {
        const canRebase = doc.source.kind === 'json' && change.content === undefined && !change.remove && (change.patches?.length ?? 0) > 0 && change.patches!.every(patch => patch.op === 'set' && safePath(patch.path) && patch.path.length > 0 && !patch.path.some((_part, index) => protectedPath(patch.path.slice(0, index + 1))) && patch.revisionId === this.pathRevision(change.sourceId, baselineValue, patch.path));
        if (!canRebase) throw new SettingsError('settings_conflict', 409);
      }
      let content = change.content ?? baselineContent ?? '';
      // require deliberate optional deletion
      if (change.remove) { if (!doc.source.optional) throw new SettingsError('settings_source_required'); candidates.set(change.sourceId, undefined); }
      else {
        // rehydrate only unchanged revision-bound markers unless this session revealed the whole source
        if (change.content !== undefined) {
          const original = sourceContents.get(change.sourceId);
          const submitted = doc.source.kind === 'env' ? partitionEnvironment(change.content, managedEnvironmentKeys) : undefined;
          // reject attempts to reintroduce server-managed assignments through the raw editor
          if (submitted !== undefined && submitted.hidden.length > 0) throw new SettingsError('invalid_environment_patch');
          const originalEnvironment = original !== undefined && doc.source.kind === 'env' ? partitionEnvironment(original, managedEnvironmentKeys) : undefined;
          const originalEditorContent = originalEnvironment?.visible ?? original;
          const submittedEditorContent = submitted?.visible ?? change.content;
          if (originalEditorContent !== undefined && this.wholeSourceDisclosed(sessionId, change.sourceId, doc.revisionId)) {
            // never persist editor protocol text from a revealed document
            if (hasEditorMarker(submittedEditorContent)) throw new SettingsError('settings_protected_content_changed');
            content = submittedEditorContent;
          } else if (originalEditorContent !== undefined) content = restoreEditorSource(submittedEditorContent, originalEditorContent, doc.source.kind, doc.revisionId, editorProtectedValues);
          else if (doc.existed) throw new SettingsError('settings_reveal_required', 403);
          // reattach only the original managed records after validating the editable projection
          if (originalEnvironment !== undefined) content = restoreManagedEnvironment(content, originalEnvironment.hidden);
        }
        // preserve unchanged protected values in typed dotenv edits
        if (change.patches !== undefined && doc.source.kind === 'env') {
          // apply each typed field without changing unrelated source records
          for (const patch of change.patches) {
            // accept only one keyed string edit or removal
            if (patch.path.length !== 1 || !['set', 'remove'].includes(patch.op) || patch.op === 'set' && typeof patch.value !== 'string') throw new SettingsError('invalid_environment_patch');
            const key = patch.path[0]!;
            // keep generated VAPID material outside direct settings mutations
            if (managedEnvironment(key)) throw new SettingsError('invalid_environment_patch');
            const value = patch.op === 'remove' || patch.value === '' ? undefined : patch.value as string;
            content = patchEnvironment(content, key, value);
          }
        } else if (change.patches !== undefined && ['json', 'installation'].includes(doc.source.kind)) {
          // require valid structured truth instead of replacing an unreadable host file
          if (baselineValue === undefined && doc.existed) throw new SettingsError(doc.source.kind === 'installation' ? 'invalid_installation_settings' : 'invalid_application_json');
          let value: unknown = structuredClone(baselineValue ?? {});
          // normalize only explicitly authored project values
          for (const patch of change.patches) value = change.sourceId === 'app' ? applyAuthoredProjectPatch(value, patch) : applyPatch(value, patch);
          content = `${JSON.stringify(value, null, 2)}\n`;
        } else if (change.patches !== undefined) throw new SettingsError('invalid_settings_patch');
        // derive hidden profiles only after the exact revision and disclosure checks
        if (change.sourceId === 'installation' && doc.source.kind === 'installation') content = automaticInstallationProfiles(content, installation);
        // reject masked sentinels in blind whole-source replacements
        if (!validPatchValue(content) || Buffer.byteLength(content) > 1_048_576) throw new SettingsError('invalid_settings_value');
        candidates.set(change.sourceId, content);
        await writePrivate(join(this.controlRoot, 'staging', id, change.sourceId), content);
      }
      sources.push({ id: change.sourceId, contentHash: doc.hash, existed: doc.existed, ...(change.remove ? { remove: true } : { candidate: change.sourceId }), ...(change.migration ? { migration: change.migration } : {}) });
    }
    const issues: SettingsIssue[] = [];
    const candidateEnv = candidates.has('env') ? candidates.get('env') ?? '' : sourceContents.get('env') ?? '';
    // validate auth literals and application cross-field rules together
    await validateEnvironment(candidateEnv);
    const appContent = candidates.has('app') ? candidates.get('app') : sourceContents.get('app');
    if (appContent !== undefined) { let app: unknown; try { app = JSON.parse(appContent); } catch { throw new SettingsError('invalid_application_json'); } issues.push(...await validateApplication(app, { ...process.env, ...environment(candidateEnv) })); }
    // validate additional structured and inert sources before host validation
    for (const [sourceId, content] of candidates) {
      if (content === undefined) continue;
      const kind = documents.get(sourceId)!.source.kind;
      if (kind === 'installation') { try { installationSettingsSchema.parse(JSON.parse(content)); } catch { throw new SettingsError('invalid_installation_settings'); } }
      if (kind === 'svg') validateSvg(content);
      if (kind === 'credentials') { try { const credentials: unknown = JSON.parse(content); if (credentials === null || typeof credentials !== 'object' || Array.isArray(credentials)) throw new Error(); } catch { throw new SettingsError('invalid_cloudflare_credentials'); } }
    }
    return { installation, documents, candidates, issues, request: { version: 1, id, kind: 'validate', generation: installation.generation, sources } };
  }
  // validate complete candidates without deploying or persisting source files
  async validate(input: SettingsInput, sessionId?: string): Promise<SettingsValidation> {
    return await this.serialized(async () => {
      const id = randomBytes(24).toString('base64url'); let published = false;
      try {
        const prepared = await this.prepare(input, id, sessionId);
        // return field validation before publishing candidates
        if (prepared.issues.length > 0) return { valid: false, issues: prepared.issues };
        await this.transport.request(prepared.request, true, () => { published = true; });
        return { valid: true, issues: [] };
      } catch (error) {
        // preserve exact helper-attributed source issues
        if (error instanceof SettingsError && error.statusCode === 400) return { valid: false, issues: error.issues.length > 0 ? error.issues : [{ sourceId: input.changes?.[0]?.sourceId ?? 'app', path: [], code: error.code, message: error.code.replaceAll('_', ' ') }] };
        throw error;
      } finally {
        await this.cleanupStage(id, published);
      }
    });
  }
  // never delete candidates still owned by a queued or running helper
  private async cleanupStage(id: string, published: boolean): Promise<void> {
    const terminal = published ? await this.metadata<{ state?: string }>(`status/${id}.json`) : undefined;
    // clean definite local failures or already-finished helper work only
    if (!published || terminal?.state === 'complete' || terminal?.state === 'failed') await rm(join(this.controlRoot, 'staging', id), { recursive: true, force: true });
  }
  // commit durable files first and apply only already-proven live callbacks
  async save(input: SettingsInput, sessionId?: string): Promise<SettingsSnapshot> { return await this.serialized(async () => {
    const id = randomBytes(24).toString('base64url'); let published = false;
    try {
      const prepared = await this.prepare(input, id, sessionId);
      if (prepared.issues.length > 0) throw new SettingsError('invalid_settings', 400, prepared.issues);
      await this.transport.request({ ...prepared.request, kind: 'commit' }, true, () => { published = true; });
      this.leases.clear();
      // preserve the existing narrow live behavior after durable commit
      if (prepared.candidates.has('app')) {
        const applied = JSON.parse(this.liveState) as { name: string; defaultAgent?: AgentKind; voice: DavoSettings }; const after = sourceSchema.parse(JSON.parse(prepared.candidates.get('app')!));
        const retryLive = await this.metadata('live-pending.json') !== undefined;
        try {
          // compare actual runtime values rather than an unconsumed manual edit
          if (after.name !== applied.name || retryLive) { if (this.options.live?.name === undefined) throw new Error(); await this.options.live.name(after.name); }
          // refresh launch defaults only through their supported callback
          if (after.defaultAgent !== applied.defaultAgent || retryLive) { if (this.options.live?.defaultAgent === undefined) throw new Error(); await this.options.live.defaultAgent(after.defaultAgent); }
          // exclude provider and tool authorization from the live voice surface
          const voice: DavoSettings = { enabled: after.integrations.realtime.enabled, name: after.integrations.realtime.name, context: after.integrations.realtime.context };
          // prove every changed voice value through the live consumer
          if (JSON.stringify(voice) !== JSON.stringify(applied.voice) || retryLive) { if (this.options.live?.davo === undefined) throw new Error(); await this.options.live.davo(voice); }
          this.liveState = liveProjection(after);
          await rm(join(this.controlRoot, 'live-pending.json'), { force: true });
        } catch { await writePrivate(join(this.controlRoot, 'live-pending.json'), JSON.stringify({ revisionId: this.revision('app', prepared.candidates.get('app')) })); }
      }
      return await this.snapshot(true, sessionId);
    } finally {
      // retain uncertain published candidates for helper crash recovery
      await this.cleanupStage(id, published);
    }
  }); }
  // bridge legacy narrow preferences through the same serializer
  async updateApplication(patches: SettingsInput['changes'][number]['patches'], sessionId: string): Promise<void> { const snapshot = await this.snapshot(true, sessionId); const source = snapshot.sources.find(source => source.id === 'app'); if (source === undefined) throw new SettingsError('settings_source_unavailable', 503); await this.save({ changes: [{ sourceId: 'app', revisionId: source.revisionId, patches }] }, sessionId); }
  // disclose one revision-bound value to the current controller only
  async reveal(input: { sourceId: string; revisionId: string; path?: string[] }, sessionId: string): Promise<{ value: unknown; revisionId: string; leaseId: string; expiresAt: string }> {
    const installation = await this.installation(); const documents = await this.documents(installation); const doc = documents.get(input.sourceId);
    if (doc === undefined || input.revisionId !== doc.revisionId) throw new SettingsError('settings_conflict', 409);
    const path = input.path ?? [];
    if (!safePath(path)) throw new SettingsError('invalid_settings_path');
    // keep generated VAPID material outside direct settings disclosures
    if (doc.source.kind === 'env' && path.length === 1 && managedEnvironment(path[0]!)) throw new SettingsError('invalid_settings_path');
    // disclose host-only bytes only for this explicit controller-bound request
    const boot = await this.metadata<{ bootNonce: string }>('boot.json');
    const content = doc.source.serverPath === undefined && installation !== undefined ? await this.transport.read(input.sourceId, { bootNonce: boot?.bootNonce ?? '', sessionBinding: this.revision('controller', sessionId), revisionId: doc.revisionId, contentHash: doc.hash, existed: doc.existed }) : doc.content;
    let structuredValue = doc.value;
    // parse selected host-only structured values only inside this disclosure request
    if (path.length > 0 && content !== undefined && ['json', 'installation', 'credentials'].includes(doc.source.kind)) {
      try { structuredValue = JSON.parse(content); } catch { throw new SettingsError('invalid_settings_value'); }
    }
    const value = path.length === 0 ? doc.source.kind === 'env' ? partitionEnvironment(content ?? '', managedEnvironmentKeys).visible : content : doc.source.kind === 'env' && path.length === 1 ? environment(content ?? '')[path[0]!] : atPath(structuredValue, path);
    // re-read selected bytes before publishing a disclosure
    let current: { contentHash: string; existed: boolean } | undefined;
    // host metadata and local bytes both retain absent-versus-empty identity
    if (installation !== undefined && doc.source.serverPath === undefined) current = await this.transport.inspect?.(input.sourceId);
    else {
      const latestContent = installation === undefined ? await readBounded(doc.source.path, doc.source.optional) : await this.transport.read(input.sourceId);
      current = { contentHash: contentHash(latestContent), existed: latestContent !== undefined };
    }
    if (current === undefined || this.revision(input.sourceId, [current.contentHash, current.existed]) !== input.revisionId) throw new SettingsError('settings_conflict', 409);
    const leaseId = randomBytes(24).toString('base64url'); const expires = Date.now() + 60_000;
    // bound lease metadata and retain no disclosed values
    for (const [id, lease] of this.leases) if (lease.expires < Date.now()) this.leases.delete(id);
    if (this.leases.size >= 1024) this.leases.clear();
    this.leases.set(leaseId, { sessionId, expires, sourceId: input.sourceId, revisionId: doc.revisionId, path: [...path] });
    return { value, revisionId: doc.revisionId, leaseId, expiresAt: new Date(expires).toISOString() };
  }
  // revoke only this browser's disclosure lease
  async remask(leaseId: string, sessionId: string): Promise<{ ok: true }> { if (this.leases.get(leaseId)?.sessionId === sessionId) this.leases.delete(leaseId); return { ok: true }; }
  // queue an explicit fixed restart that survives this process
  async restart(): Promise<SettingsOperation> { return await this.serialized(async () => { const installation = await this.installation(); if (installation === undefined) throw new SettingsError('settings_applier_unavailable', 503); const documents = await this.documents(installation); const status = await this.computeStatus(installation, documents); if (status.operation !== undefined && ['queued', 'running'].includes(status.operation.state)) return status.operation; if (!status.pending) throw new SettingsError('settings_restart_not_pending', 409); const id = randomBytes(24).toString('base64url'); const operation: SettingsOperation = { id, state: 'queued' }; await this.transport.request({ version: 1, id, kind: 'restart', generation: installation.generation, targets: status.targets, sources: [...documents].map(([id, doc]) => ({ id, contentHash: doc.hash, existed: doc.existed })) }, false); await writePrivate(join(this.controlRoot, 'latest-deploy.json'), JSON.stringify({ ...operation, kind: 'restart' })); this.leases.clear(); return operation; }); }
  // return bounded redacted durable operation progress
  async operation(id: string): Promise<SettingsOperation | undefined> { if (!/^[A-Za-z0-9_-]{20,64}$/u.test(id)) throw new SettingsError('invalid_settings_operation'); const result = await this.metadata<SettingsOperation>(`status/${id}.json`); const restart = settingsRestartProgress(result?.restart); return result === undefined ? undefined : { id: result.id, state: result.state, ...(result.kind === 'cloudflare' ? { kind: result.kind } : {}), ...(result.phase ? { phase: result.phase } : {}), ...(result.error && /^[a-z0-9_-]{1,80}$/u.test(result.error) ? { error: result.error } : {}), ...(restart ? { restart } : {}) }; }
}
