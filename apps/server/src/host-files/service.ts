import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { basename, dirname, join, relative, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { previewFileBytes, type WorkspaceFilePreview } from '../workspace-files/service.js';
import {
  HostFilesError,
  type CollisionDecision,
  type FavoriteView,
  type FileEntry,
  type HostFileIdentity,
  type HostFileStat,
  type HostFilesBackend,
  type HostFilesItemResult,
  type HostFilesMutationResult,
  type HostFilesPlace,
  type HostFilesSession,
  type HostFilesTreeManifest,
  type OperationConflict,
  type OperationKind,
  type OperationResult,
} from './contracts.js';
import { BackendHostFileFavorites, sameFavoriteObject, type FavoriteRewrite, type HostFileFavorites } from './favorites.js';
import { HostFilesTokenService, type HostFileTokenPayload } from './tokens.js';
import { createZipStream, preflightZipSelections, type HostFilesZipSelection } from './zip.js';

export const hostFilesLimits = {
  listEntries: 10_000,
  recursiveEntries: 10_000,
  recursiveBytes: 1024 * 1024 * 1024,
  operationItems: 1_000,
  uploadFiles: 100,
  uploadFileBytes: 1024 * 1024 * 1024,
  uploadTotalBytes: 2 * 1024 * 1024 * 1024,
  previewBytes: 5 * 1024 * 1024,
} as const;

type PreparedItem = {
  source?: HostFileTokenPayload;
  sourceManifest?: HostFilesTreeManifest;
  destinationPath?: string;
  destinationIdentity?: HostFileIdentity;
  destinationManifest?: HostFilesTreeManifest;
  conflictId?: string;
  keepBothPath?: string;
  name?: string;
};
type PreparedOperation = {
  id: string;
  kind: OperationKind;
  sessionId: string;
  placeId: string;
  destination?: HostFileTokenPayload;
  items: PreparedItem[];
  conflicts: OperationConflict[];
  createdAt: number;
  expiresAt: number;
  operation: OperationResult;
  promise?: Promise<void>;
};
type UploadFile = {
  clientId: string;
  name: string;
  size: number;
  destinationPath: string;
  destinationIdentity?: HostFileIdentity;
  destinationManifest?: HostFilesTreeManifest;
  conflictId?: string;
  keepBothPath?: string;
  token?: string;
  decision?: CollisionDecision;
  operationId: string;
  state: 'prepared'|'authorized'|'uploading'|'skipped'|'completed'|'failed';
  result?: HostFilesItemResult;
};
type PreparedUpload = {
  id: string;
  sessionId: string;
  placeId: string;
  destination: HostFileTokenPayload;
  files: UploadFile[];
  conflicts: OperationConflict[];
  expiresAt: number;
  release?: () => void;
  parentIdentity: HostFileIdentity;
  expiryTimer?: NodeJS.Timeout;
  mutation: Promise<void>;
  createdAt: number;
  loggedTerminal?: boolean;
};
type PreparedDownload = {
  id: string;
  sessionId: string;
  placeId: string;
  filename: string;
  selections: HostFilesZipSelection[];
  single?: HostFileTokenPayload;
  state: 'prepared'|'streaming'|'completed'|'failed';
  bytesCompleted: number;
  error?: string;
  expiresAt: number;
  opened: boolean;
  createdAt: number;
};

export type PrepareOperationInput =
  | { kind: 'create-file'; name: string; destinationDirectoryToken: string }
  | { kind: 'create-folder'; name: string; destinationDirectoryToken: string }
  | { kind: 'rename'; sourceToken: string; newName: string; destinationDirectoryToken: string }
  | { kind: 'copy'|'move'; sourceTokens: string[]; destinationDirectoryToken: string }
  | { kind: 'delete'; sourceTokens: string[] };
export type PrepareOperationResponse = { operationId: string; kind: OperationKind; totalItems: number; conflicts: OperationConflict[]; confirmation?: { permanent: true; names: string[]; count: number } };
export type PrepareUploadInput = { destinationDirectoryToken: string; files: Array<{ clientId: string; name: string; size: number }> };
export type DownloadOpen = { filename: string; contentType: string; stream: Readable };

// compare the complete identity bound into a fresh capability
function sameIdentity(left: HostFileIdentity, right: HostFileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.ctimeNs === right.ctimeNs && left.mtimeNs === right.mtimeNs
    && left.size === right.size && left.nlink === right.nlink && left.kind === right.kind;
}

// compare two complete frozen recursive manifests
function sameManifest(left: HostFilesTreeManifest, right: HostFilesTreeManifest): boolean {
  // require matching roots, totals and entry counts
  if (left.root !== right.root || left.totalBytes !== right.totalBytes || left.entries.length !== right.entries.length) return false;
  return left.entries.every((entry, index) => {
    const candidate = right.entries[index];
    return candidate !== undefined && entry.path === candidate.path && entry.linkTarget === candidate.linkTarget && sameIdentity(entry.identity, candidate.identity);
  });
}

// derive one non-sensitive Place identifier for lifecycle logs
function placeLogId(placeId: string): string {
  return createHash('sha256').update(placeId).digest('base64url').slice(0, 12);
}

// validate one leaf created by a browser action
export function validHostFileName(name: string): boolean {
  return typeof name === 'string' && name !== '' && name !== '.' && name !== '..' && Buffer.byteLength(name) <= 255 && !/[\/\0-\x1f\x7f]/u.test(name);
}

// map backend metadata into the public row contract
function entryOf(stat: HostFileStat, token: string): FileEntry {
  return {
    name: stat.name,
    hostPath: stat.path,
    kind: stat.kind,
    ...(stat.symlinkTargetKind === undefined ? {} : { symlinkTargetKind: stat.symlinkTargetKind }),
    owner: { uid: stat.uid, label: stat.owner },
    permissions: stat.permissions,
    mode: stat.mode,
    modifiedAt: stat.modifiedAt,
    size: stat.sizeBytes,
    objectToken: token,
  };
}

// choose a deterministic non-conflicting sibling name
function keepBothCandidate(path: string, attempt: number): string {
  const name = basename(path);
  const dot = name.startsWith('.') ? -1 : name.lastIndexOf('.');
  const extension = dot > 0 ? name.slice(dot) : '';
  const stem = extension === '' ? name : name.slice(0, -extension.length);
  const suffix = attempt === 1 ? ' (copy)' : ` (copy ${attempt})`;
  const next = `${stem}${suffix}${extension}`;
  // preserve the filesystem component byte limit
  if (Buffer.byteLength(next) > 255) throw new HostFilesError('limit_exceeded', 'keep-both name exceeds filesystem limits', 413);
  return join(dirname(path), next);
}

// preserve only top-level selections whose ancestor is not also selected
function deduplicateSources(tokens: HostFileTokenPayload[]): HostFileTokenPayload[] {
  const ordered = [...tokens].sort((left, right) => left.path.length - right.path.length || left.path.localeCompare(right.path));
  const retained: HostFileTokenPayload[] = [];
  // compare each selected path with already-retained ancestors
  for (const token of ordered) {
    const nested = retained.some(parent => {
      const local = relative(parent.path, token.path);
      return parent.identity.kind === 'directory' && local !== '' && local !== '..' && !local.startsWith(`..${sep}`);
    });
    // retain distinct hardlink names and non-descendants
    if (!nested) retained.push(token);
  }
  return retained;
}

// reject batches that derive more than one write to the same path
function requireUniqueDestinationPaths(paths: readonly string[]): void {
  // compare canonical backend paths before allocating per-item authority
  if (new Set(paths).size !== paths.length) throw new HostFilesError('invalid_request', 'batch contains duplicate destination paths', 400);
}

class PathLockRegistry {
  private active = new Map<string, string[]>();

  // acquire one set of overlapping source and destination roots
  acquire(operationId: string, paths: readonly string[]): () => void {
    const normalized = [...new Set(paths)].sort();
    // reject overlap with every active operation
    for (const [owner, held] of this.active) {
      // ignore no owner except the exact same operation
      if (owner === operationId) continue;
      const collision = normalized.some(path => held.some(other => path === other || path.startsWith(`${other}/`) || other.startsWith(`${path}/`)));
      // report bounded per-operation saturation
      if (collision) throw new HostFilesError('busy', 'another file operation overlaps these paths', 429, true);
    }
    this.active.set(operationId, normalized);
    // release only this operation's registry entry
    return () => { this.active.delete(operationId); };
  }
}

class AsyncGate {
  private tail = Promise.resolve();

  // queue one exclusive asynchronous sequence
  async acquire(): Promise<() => void> {
    const predecessor = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>(resolve => { release = resolve; });
    await predecessor;
    let released = false;
    // release this exact queue position once
    return () => {
      // ignore duplicate cleanup paths
      if (released) return;
      released = true;
      release();
    };
  }
}

export class HostFilesService {
  private readonly tokens: HostFilesTokenService;
  private readonly favorites: HostFileFavorites;
  private readonly now: () => number;
  private readonly operations = new Map<string, PreparedOperation>();
  private readonly uploads = new Map<string, PreparedUpload>();
  private readonly downloads = new Map<string, PreparedDownload>();
  private readonly locks = new PathLockRegistry();
  private readonly favoriteMutations = new AsyncGate();

  // bind service state to one backend generation and signing key
  constructor(private readonly options: { backend: HostFilesBackend; tokenSecret: string; favorites?: HostFileFavorites; now?: () => number }) {
    this.now = options.now ?? Date.now;
    this.favorites = options.favorites ?? new BackendHostFileFavorites(options.backend);
    this.tokens = new HostFilesTokenService(options.tokenSecret, () => options.backend.generation(), this.now);
  }

  // expose the backend only for controlled route streaming and shutdown
  get backend(): HostFilesBackend { return this.options.backend; }

  // retain signed directory identity through host-side command scheduling
  async resolveDirectoryCapability(place: HostFilesPlace, session: HostFilesSession, token: string): Promise<{ canonicalHostPath: string; backendGeneration: string; expiresAt: number; identity: { dev: string; ino: string; kind: 'directory' }; current(): boolean }> {
    const selected = await this.directoryToken(place, session, token);
    return {
      canonicalHostPath: selected.path,
      backendGeneration: selected.backendGeneration,
      expiresAt: selected.expiresAt,
      identity: { dev: selected.identity.dev, ino: selected.identity.ino, kind: 'directory' },
      // reject backend replacement before the owned host process starts
      current: () => this.options.backend.generation() === selected.backendGeneration && this.now() <= selected.expiresAt
    };
  }

  // list one canonical host directory and issue fresh session capabilities
  async list(place: HostFilesPlace, session: HostFilesSession, path?: string, objectToken?: string): Promise<{ path: string; parent?: string; destinationDirectoryToken: string; directoryEntry: FileEntry; entries: FileEntry[]; inaccessibleEntries: number; truncated: boolean; limits: typeof hostFilesLimits }> {
    this.prune();
    const selected = objectToken === undefined ? undefined : await this.objectToken(place, session, objectToken);
    // prevent a scoped capability from authorizing an unrelated pathname
    if (selected !== undefined && path !== undefined && path !== selected.path) throw new HostFilesError('invalid_request', 'folder path does not match its selection', 400);
    // exchange only directories or explicit directory symlinks for destination authority
    if (selected !== undefined && selected.identity.kind !== 'directory' && selected.identity.kind !== 'symlink') throw new HostFilesError('unsupported_type', 'selection is not a folder', 422);
    const target = selected === undefined ? undefined : selected.identity.kind === 'symlink'
      ? await this.options.backend.request({ kind: 'inspect', path: selected.path, followSymlink: true })
      : { path: selected.path, ...selected.identity };
    // reject symlinks whose current target is not a directory
    if (target !== undefined && target.kind !== 'directory') throw new HostFilesError('unsupported_type', 'selection is not a folder', 422);
    const listed = await this.options.backend.request({ kind: 'list', path: target?.path ?? path ?? place.hostPath ?? place.home, maxEntries: hostFilesLimits.listEntries });
    // never issue replacement authority after resolving a selected folder
    if (target !== undefined && (target.path !== listed.path || !sameIdentity(target, listed.directory))) throw new HostFilesError('stale_object', 'selected folder changed; refresh and try again', 409);
    const records = await this.favorites.list(place.id);
    // issue object capabilities and consistent favorites for rows and the current directory
    const decorate = (stat: HostFileStat): FileEntry => {
      const token = this.tokens.issue({ purpose: 'object', sessionId: session.id, placeId: place.id, path: stat.path, identity: stat });
      const entry = entryOf(stat, token);
      const favorite = records.find(record => record.path === stat.path);
      // decorate only matching path favorites
      if (favorite !== undefined) entry.favorite = { id: favorite.id, state: sameFavoriteObject(favorite.identity, stat) ? favorite.identity.ctimeNs === stat.ctimeNs ? favorite.freshness === undefined ? 'available' : 'repair-pending' : 'modified' : 'replaced' };
      return entry;
    };
    const entries = listed.entries.map(decorate);
    const directory = await this.options.backend.request({ kind: 'inspect', path: listed.path });
    // bind background menus to the same exact directory as the destination capability
    if (!sameIdentity(listed.directory, directory)) throw new HostFilesError('stale_object', 'folder changed while listing; refresh and try again', 409);
    // preserve the clicked object across directory and symlink resolution races
    if (selected !== undefined && objectToken !== undefined) {
      await this.objectToken(place, session, objectToken);
      // prove an unchanged symlink still resolves to the exact listed target
      if (selected.identity.kind === 'symlink') {
        const resolved = await this.options.backend.request({ kind: 'inspect', path: selected.path, followSymlink: true });
        // reject retargeted or replaced destination directories
        if (resolved.path !== listed.path || !sameIdentity(resolved, listed.directory)) throw new HostFilesError('stale_object', 'selected folder changed; refresh and try again', 409);
        await this.objectToken(place, session, objectToken);
      }
    }
    const directoryEntry = decorate(directory);
    const destinationDirectoryToken = this.tokens.issue({ purpose: 'destination-directory', sessionId: session.id, placeId: place.id, path: listed.path, identity: listed.directory });
    return { path: listed.path, ...(listed.parent === undefined ? {} : { parent: listed.parent }), destinationDirectoryToken, directoryEntry, entries, inaccessibleEntries: listed.inaccessibleEntries, truncated: listed.truncated, limits: hostFilesLimits };
  }

  // open one bounded existing File-view preview outside any worktree boundary
  async preview(place: HostFilesPlace, session: HostFilesSession, objectToken: string): Promise<WorkspaceFilePreview> {
    const selected = await this.objectToken(place, session, objectToken);
    // reject visible special objects without opening them
    if (selected.identity.kind !== 'file' && selected.identity.kind !== 'symlink') throw new HostFilesError('unsupported_type', 'object type cannot be previewed', 422);
    const target = selected.identity.kind === 'symlink' ? await this.options.backend.request({ kind: 'inspect', path: selected.path, followSymlink: true }) : await this.options.backend.request({ kind: 'inspect', path: selected.path });
    // require an explicit symlink target to resolve to a regular file
    if (target.kind !== 'file') throw new HostFilesError('unsupported_type', 'object type cannot be previewed', 422);
    const size = Number(target.size);
    const length = Math.min(size, hostFilesLimits.previewBytes);
    const stream = await this.options.backend.read({ kind: 'read', path: target.path, identity: target, start: 0, length }, undefined);
    const bytes = await this.readBounded(stream, length);
    // preserve the true size while keeping the default text cap
    const preview = previewFileBytes(selected.path, bytes, undefined, size);
    return { ...preview, path: selected.path, size, truncated: preview.truncated || size > bytes.length };
  }

  // resolve one current regular file capability into its canonical host editor path
  async editorFile(place: HostFilesPlace, session: HostFilesSession, objectToken: string): Promise<string> {
    const selected = await this.objectToken(place, session, objectToken);
    // accept only regular files and symlinks whose targets can be proven regular
    if (selected.identity.kind !== 'file' && selected.identity.kind !== 'symlink') throw new HostFilesError('unsupported_type', 'object type cannot be opened in the editor', 422);
    // a direct file already carries one freshly revalidated canonical host path
    if (selected.identity.kind === 'file') return selected.path;
    const target = await this.options.backend.request({ kind: 'inspect', path: selected.path, followSymlink: true });
    // reject directory and special-object symlink targets
    if (target.kind !== 'file') throw new HostFilesError('unsupported_type', 'object type cannot be opened in the editor', 422);
    await this.objectToken(place, session, objectToken);
    const currentTarget = await this.options.backend.request({ kind: 'inspect', path: selected.path, followSymlink: true });
    // reject retargeted or replaced symlink destinations
    if (currentTarget.path !== target.path || !sameIdentity(currentTarget, target)) throw new HostFilesError('stale_object', 'selected object changed', 409);
    await this.objectToken(place, session, objectToken);
    return selected.path;
  }

  // list durable favorites with current availability and fresh tokens
  async listFavorites(place: HostFilesPlace, session: HostFilesSession): Promise<{ favorites: FavoriteView[] }> {
    const records = await this.favorites.list(place.id);
    const views: FavoriteView[] = [];
    // inspect every bounded stored favorite independently
    for (const favorite of records) {
      try {
        const current = await this.options.backend.request({ kind: 'inspect', path: favorite.path });
        const state = !sameFavoriteObject(favorite.identity, current) ? 'replaced' : favorite.freshness !== undefined ? 'repair-pending' : favorite.identity.ctimeNs === current.ctimeNs ? 'available' : 'modified';
        const token = this.tokens.issue({ purpose: 'object', sessionId: session.id, placeId: place.id, path: current.path, identity: current });
        views.push({ ...favorite, state, entry: entryOf(current, token) });
      } catch (error) {
        const failure = error as HostFilesError;
        // preserve missing and inaccessible records as unavailable
        if (failure.code === 'not_found' || failure.code === 'permission_denied') views.push({ ...favorite, state: 'unavailable' });
        else throw error;
      }
    }
    return { favorites: views };
  }

  // add one current object to this exact Place
  async addFavorite(place: HostFilesPlace, session: HostFilesSession, objectToken: string): Promise<{ favorite: FavoriteView }> {
    const release = await this.favoriteMutations.acquire();
    try {
      const selected = await this.objectToken(place, session, objectToken);
      const favorite = await this.favorites.add(place.id, selected.path, selected.identity);
      const current = await this.options.backend.request({ kind: 'inspect', path: selected.path });
      const token = this.tokens.issue({ purpose: 'object', sessionId: session.id, placeId: place.id, path: current.path, identity: current });
      return { favorite: { ...favorite, state: 'available', entry: entryOf(current, token) } };
    } finally { release(); }
  }

  // explicitly acknowledge the current object at one favorite path
  async acknowledgeFavorite(place: HostFilesPlace, session: HostFilesSession, favoriteId: string, objectToken: string): Promise<{ favorite: FavoriteView }> {
    const release = await this.favoriteMutations.acquire();
    try {
      const selected = await this.objectToken(place, session, objectToken);
      const favorite = await this.favorites.acknowledge(place.id, favoriteId, selected.path, selected.identity);
      const current = await this.options.backend.request({ kind: 'inspect', path: selected.path });
      const token = this.tokens.issue({ purpose: 'object', sessionId: session.id, placeId: place.id, path: current.path, identity: current });
      return { favorite: { ...favorite, state: 'available', entry: entryOf(current, token) } };
    } finally { release(); }
  }

  // remove one exact Place favorite
  async removeFavorite(place: HostFilesPlace, favoriteId: string): Promise<void> {
    const release = await this.favoriteMutations.acquire();
    try {
      const removed = await this.favorites.remove(place.id, favoriteId);
      // distinguish missing records from successful removal
      if (!removed) throw new HostFilesError('not_found', 'favorite not found', 404);
    } finally { release(); }
  }

  // prepare a fresh, server-owned manifest before any mutation
  async prepareOperation(place: HostFilesPlace, session: HostFilesSession, input: PrepareOperationInput): Promise<PrepareOperationResponse> {
    this.prune();
    const id = randomUUID();
    const conflicts: OperationConflict[] = [];
    const items: PreparedItem[] = [];
    let destination: HostFileTokenPayload | undefined;
    // resolve the required canonical destination directory
    if (input.kind !== 'delete') destination = await this.directoryToken(place, session, input.destinationDirectoryToken);
    // prepare one create target
    if (input.kind === 'create-file' || input.kind === 'create-folder') {
      // require one safe derived leaf
      if (!validHostFileName(input.name)) throw new HostFilesError('invalid_path', 'invalid file name', 400);
      items.push(await this.prepareDestination(join(destination!.path, input.name), input.name, conflicts));
    // prepare one same-parent rename
    } else if (input.kind === 'rename') {
      // require one safe derived leaf
      if (!validHostFileName(input.newName)) throw new HostFilesError('invalid_path', 'invalid file name', 400);
      const source = await this.objectToken(place, session, input.sourceToken);
      // bind Rename to the source's exact canonical parent
      if (dirname(source.path) !== destination!.path) throw new HostFilesError('invalid_path', 'rename destination must be the current parent', 400);
      const sourceManifest = await this.snapshot(source);
      items.push({ ...(await this.prepareDestination(join(destination!.path, input.newName), input.newName, conflicts)), source, sourceManifest });
    } else {
      const rawTokens = input.sourceTokens;
      // bound batch input before backend work
      if (rawTokens.length < 1 || rawTokens.length > hostFilesLimits.operationItems) throw new HostFilesError('limit_exceeded', 'invalid selection count', 413);
      const resolved: HostFileTokenPayload[] = [];
      // resolve all top-level inputs before storing a manifest
      for (const token of rawTokens) resolved.push(input.kind === 'copy' || input.kind === 'move' ? await this.crossPlaceSourceToken(session, token) : await this.objectToken(place, session, token));
      const selected = deduplicateSources(resolved);
      // reject colliding derived writes before preparing any destination conflicts
      if (input.kind === 'copy' || input.kind === 'move') requireUniqueDestinationPaths(selected.map(source => join(destination!.path, basename(source.path))));
      let totalEntries = 0;
      let totalBytes = 0;
      // freeze every recursive source before any mutation
      for (const source of selected) {
        const sourceManifest = await this.snapshot(source);
        totalEntries += sourceManifest.entries.length;
        totalBytes += sourceManifest.totalBytes;
        // bound the complete batch rather than each independent source
        if (totalEntries > hostFilesLimits.recursiveEntries || totalBytes > hostFilesLimits.recursiveBytes) throw new HostFilesError('limit_exceeded', 'operation selection exceeds recursive limits', 413);
        // delete has no destination-side manifest
        if (input.kind === 'delete') items.push({ source, sourceManifest });
        else {
          const target = join(destination!.path, basename(source.path));
          const nested = source.identity.kind === 'directory' ? relative(source.path, target) : '..';
          // reject copying a directory into itself
          if (nested === '' || nested !== '..' && !nested.startsWith(`..${sep}`)) throw new HostFilesError('invalid_path', 'destination cannot be inside source', 400);
          items.push({ ...(await this.prepareDestination(target, basename(source.path), conflicts)), source, sourceManifest });
        }
      }
    }
    const operation: OperationResult = { operationId: id, kind: input.kind, state: 'queued', phase: 'prepared', completedItems: 0, totalItems: items.length, bytesCompleted: 0, bytesTotal: items.reduce((total, item) => total + (item.sourceManifest?.totalBytes ?? 0), 0), results: [] };
    const prepared: PreparedOperation = { id, kind: input.kind, sessionId: session.id, placeId: place.id, ...(destination === undefined ? {} : { destination }), items, conflicts, createdAt: this.now(), expiresAt: this.now() + 15 * 60_000, operation };
    this.operations.set(id, prepared);
    this.logLifecycle(id, input.kind, place.id, 'queued', items.length, operation.bytesTotal, 0);
    return { operationId: id, kind: input.kind, totalItems: items.length, conflicts, ...(input.kind === 'delete' ? { confirmation: { permanent: true as const, names: items.map(item => basename(item.source!.path)), count: items.length } } : {}) };
  }

  // start one prepared operation after complete conflict and delete confirmation
  async executeOperation(place: HostFilesPlace, session: HostFilesSession, operationId: string, decisions: Record<string, CollisionDecision>, confirmed = false): Promise<OperationResult> {
    const prepared = this.preparedOperation(place, session, operationId);
    // prevent replay after execution starts
    if (prepared.operation.state !== 'queued') throw new HostFilesError('stale_object', 'operation already started', 409);
    // require explicit permanent deletion confirmation
    if (prepared.kind === 'delete' && !confirmed) throw new HostFilesError('invalid_request', 'permanent deletion must be confirmed', 400);
    // require exactly one allowed choice for every conflict
    for (const conflict of prepared.conflicts) {
      const decision = decisions[conflict.id];
      // reject missing or unknown decisions
      if (decision === undefined || !conflict.allowed.includes(decision)) throw new HostFilesError('conflict', 'every collision requires a decision', 409);
    }
    // reject injected decision ids
    if (Object.keys(decisions).some(id => !prepared.conflicts.some(conflict => conflict.id === id))) throw new HostFilesError('invalid_request', 'unknown conflict decision', 400);
    const paths = prepared.items.flatMap(item => [item.source?.path, item.destinationPath, item.keepBothPath]).filter((value): value is string => value !== undefined);
    const release = this.locks.acquire(prepared.id, paths);
    try {
      await this.prevalidateOperation(prepared, decisions);
      prepared.operation.state = 'running';
      prepared.operation.phase = 'executing';
      this.logLifecycle(prepared.id, prepared.kind, prepared.placeId, 'running', prepared.items.length, prepared.operation.bytesTotal, this.now() - prepared.createdAt);
      prepared.promise = this.runOperation(prepared, decisions).finally(release);
    } catch (error) {
      release();
      this.logLifecycle(prepared.id, prepared.kind, prepared.placeId, 'rejected', prepared.items.length, 0, this.now() - prepared.createdAt, (error as HostFilesError).code ?? 'partial_failure');
      throw error;
    }
    return structuredClone(prepared.operation);
  }

  // return one session-bound monotonic operation snapshot
  operation(place: HostFilesPlace, session: HostFilesSession, operationId: string): OperationResult {
    return structuredClone(this.preparedOperation(place, session, operationId).operation);
  }

  // prepare a bounded raw upload batch and its collision manifests
  async prepareUpload(place: HostFilesPlace, session: HostFilesSession, input: PrepareUploadInput): Promise<{ uploadId: string; conflicts: OperationConflict[] }> {
    this.prune();
    // enforce count and aggregate byte limits
    if (input.files.length < 1 || input.files.length > hostFilesLimits.uploadFiles || input.files.some(file => !validHostFileName(file.name) || !/^[A-Za-z0-9_-]{1,128}$/u.test(file.clientId) || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > hostFilesLimits.uploadFileBytes)) throw new HostFilesError('limit_exceeded', 'invalid upload batch', 413);
    const total = input.files.reduce((sum, file) => sum + file.size, 0);
    // reject an oversized aggregate before allocating state
    if (total > hostFilesLimits.uploadTotalBytes || new Set(input.files.map(file => file.clientId)).size !== input.files.length) throw new HostFilesError('limit_exceeded', 'invalid upload batch', 413);
    const destination = await this.directoryToken(place, session, input.destinationDirectoryToken);
    const destinationPaths = input.files.map(file => join(destination.path, file.name));
    requireUniqueDestinationPaths(destinationPaths);
    const conflicts: OperationConflict[] = [];
    const files: UploadFile[] = [];
    // derive every destination exclusively from the directory token and leaf
    for (const [index, inputFile] of input.files.entries()) {
      const prepared = await this.prepareDestination(destinationPaths[index]!, inputFile.name, conflicts);
      files.push({ clientId: inputFile.clientId, name: inputFile.name, size: inputFile.size, operationId: randomUUID(), destinationPath: prepared.destinationPath!, ...(prepared.destinationIdentity === undefined ? {} : { destinationIdentity: prepared.destinationIdentity }), ...(prepared.destinationManifest === undefined ? {} : { destinationManifest: prepared.destinationManifest }), ...(prepared.conflictId === undefined ? {} : { conflictId: prepared.conflictId, keepBothPath: prepared.keepBothPath }), state: 'prepared' });
    }
    const id = randomUUID();
    this.uploads.set(id, { id, sessionId: session.id, placeId: place.id, destination, parentIdentity: destination.identity, files, conflicts, expiresAt: this.now() + 15 * 60_000, mutation: Promise.resolve(), createdAt: this.now() });
    this.logLifecycle(id, 'upload', place.id, 'queued', files.length, total, 0);
    return { uploadId: id, conflicts };
  }

  // authorize one upload after fresh parent/conflict validation and hold its overlap locks
  async authorizeUpload(place: HostFilesPlace, session: HostFilesSession, uploadId: string, decisions: Record<string, CollisionDecision>): Promise<{ files: Array<{ clientId: string; token?: string; skipped?: true; destinationName: string }> }> {
    const upload = this.preparedUpload(place, session, uploadId);
    // prevent reauthorization
    if (upload.release !== undefined || upload.files.some(file => file.state !== 'prepared')) throw new HostFilesError('stale_object', 'upload already authorized', 409);
    // require all collision decisions
    for (const conflict of upload.conflicts) {
      const decision = decisions[conflict.id];
      // stop incomplete decision sets
      if (decision === undefined || !conflict.allowed.includes(decision)) throw new HostFilesError('conflict', 'every collision requires a decision', 409);
    }
    // reject decision ids from another operation
    if (Object.keys(decisions).some(id => !upload.conflicts.some(conflict => conflict.id === id))) throw new HostFilesError('invalid_request', 'unknown conflict decision', 400);
    const release = this.locks.acquire(upload.id, [upload.destination.path, ...upload.files.flatMap(file => [file.destinationPath, file.keepBothPath].filter((value): value is string => value !== undefined))]);
    upload.release = release;
    try {
      await this.revalidatePayload(upload.destination);
      // revalidate every prepared conflict before issuing a byte capability
      for (const file of upload.files) await this.revalidatePreparedDestination(file, file.conflictId === undefined ? undefined : decisions[file.conflictId]);
      const response: Array<{ clientId: string; token?: string; skipped?: true; destinationName: string }> = [];
      // issue one single-use token per non-skipped file
      for (const file of upload.files) {
        const decision = file.conflictId === undefined ? undefined : decisions[file.conflictId];
        file.decision = decision;
        // mark explicit skips terminal without accepting bytes
        if (decision === 'skip') { file.state = 'skipped'; file.result = { destinationPath: file.destinationPath, outcome: 'skipped' }; response.push({ clientId: file.clientId, skipped: true, destinationName: basename(file.destinationPath) }); continue; }
        const selectedPath = decision === 'keep-both' ? file.keepBothPath! : file.destinationPath;
        file.destinationPath = selectedPath;
        file.token = randomBytes(24).toString('base64url');
        file.state = 'authorized';
        response.push({ clientId: file.clientId, token: file.token, destinationName: basename(selectedPath) });
      }
      upload.expiryTimer = setTimeout(() => {
        // expire every unused raw-body capability and release overlap locks
        for (const file of upload.files) {
          // mark only bodies that never reached a terminal state
          if (file.state === 'authorized') { file.state = 'failed'; file.token = undefined; file.result = { destinationPath: file.destinationPath, outcome: 'failed', code: 'stale_object', message: 'upload authorization expired' }; }
        }
        // retain locks while an already-started body is still active
        if (upload.files.some(file => file.state === 'uploading')) return;
        upload.release?.();
        upload.release = undefined;
        this.logUploadTerminal(upload);
      }, Math.max(1, upload.expiresAt - this.now()));
      upload.expiryTimer.unref();
      this.logLifecycle(upload.id, 'upload', upload.placeId, 'running', upload.files.length, upload.files.reduce((total, file) => total + file.size, 0), this.now() - upload.createdAt);
      this.releaseUploadIfDone(upload);
      return { files: response };
    } catch (error) {
      release();
      upload.release = undefined;
      throw error;
    }
  }

  // stream one authorized browser body directly to the backend
  async upload(place: HostFilesPlace, session: HostFilesSession, uploadId: string, clientId: string, token: string, source: Readable): Promise<{ result: HostFilesItemResult }> {
    const upload = this.preparedUpload(place, session, uploadId);
    const file = upload.files.find(candidate => candidate.clientId === clientId);
    // require one exact unused upload capability
    if (file === undefined || file.state !== 'authorized' || file.token !== token) throw new HostFilesError('stale_object', 'upload authorization is invalid or expired', 409);
    file.token = undefined;
    file.state = 'uploading';
    let response: { result: HostFilesItemResult } | undefined;
    const operation = upload.mutation.then(async () => {
      try {
        const parent = await this.options.backend.request({ kind: 'inspect', path: upload.destination.path });
        // require the last backend-owned parent identity before this batch item
        if (!sameIdentity(parent, upload.parentIdentity)) throw new HostFilesError('stale_object', 'upload destination changed', 409);
        const replace = file.decision === 'replace';
        const written = await this.options.backend.write({ kind: 'write', operationId: file.operationId, path: file.destinationPath, size: file.size, destinationParentIdentity: parent, ...(replace && file.destinationIdentity !== undefined ? { destinationIdentity: file.destinationIdentity, ...(file.destinationManifest === undefined ? {} : { destinationManifest: file.destinationManifest }) } : {}), replace }, source);
        const refreshedParent = await this.options.backend.request({ kind: 'inspect', path: upload.destination.path });
        upload.parentIdentity = refreshedParent;
        file.state = 'completed';
        file.result = { destinationPath: written.path, outcome: 'uploaded' };
        response = { result: file.result };
      } catch (error) {
        const failure = error as HostFilesError;
        file.state = 'failed';
        file.result = { destinationPath: file.destinationPath, outcome: 'failed', code: failure.code ?? 'partial_failure', message: failure.message };
        throw error;
      } finally { this.releaseUploadIfDone(upload); }
    });
    upload.mutation = operation.then(() => undefined, () => undefined);
    await operation;
    // the serialized operation always assigns a response or throws
    if (response === undefined) throw new HostFilesError('partial_failure', 'upload did not settle', 500);
    return response;
  }

  // prepare one single-file or dependency-free ZIP download manifest
  async prepareDownload(place: HostFilesPlace, session: HostFilesSession, objectTokens: string[]): Promise<{ downloadId: string; filename: string; target: string }> {
    this.prune();
    // bound and resolve all selections before minting a ticket
    if (objectTokens.length < 1 || objectTokens.length > hostFilesLimits.operationItems) throw new HostFilesError('limit_exceeded', 'invalid download selection', 413);
    const resolved: HostFileTokenPayload[] = [];
    // resolve all object capabilities
    for (const token of objectTokens) resolved.push(await this.objectToken(place, session, token));
    const selected = deduplicateSources(resolved);
    const selections: HostFilesZipSelection[] = [];
    let totalEntries = 0;
    let totalBytes = 0;
    // snapshot every selected tree before the response headers
    for (const object of selected) {
      const manifest = await this.snapshot(object);
      // reject special objects before ticket issuance
      if (manifest.entries.some(entry => !['file', 'directory', 'symlink'].includes(entry.identity.kind))) throw new HostFilesError('unsupported_type', 'selection contains an object that cannot be downloaded', 422);
      totalEntries += manifest.entries.length;
      totalBytes += manifest.totalBytes;
      // enforce one aggregate bound across every selected root
      if (totalEntries > hostFilesLimits.recursiveEntries || totalBytes > hostFilesLimits.recursiveBytes) throw new HostFilesError('limit_exceeded', 'download selection exceeds recursive limits', 413);
      selections.push({ root: object.path, manifest });
    }
    const single = selected.length === 1 && selected[0]!.identity.kind === 'file' ? selected[0] : undefined;
    // reject invalid ZIP metadata before issuing a browser ticket
    if (single === undefined) preflightZipSelections(selections);
    const filename = single === undefined ? `${selected.length === 1 ? basename(selected[0]!.path) : 'files'}.zip` : basename(single.path);
    const id = randomUUID();
    this.downloads.set(id, { id, sessionId: session.id, placeId: place.id, filename, selections, ...(single === undefined ? {} : { single }), state: 'prepared', bytesCompleted: 0, expiresAt: this.now() + 30_000, opened: false, createdAt: this.now() });
    this.logLifecycle(id, 'download', place.id, 'queued', selections.reduce((count, selection) => count + selection.manifest.entries.length, 0), selections.reduce((total, selection) => total + selection.manifest.totalBytes, 0), 0);
    return { downloadId: id, filename, target: id };
  }

  // consume one prepared download after the route consumes its session ticket
  async openDownload(session: HostFilesSession, downloadId: string): Promise<DownloadOpen> {
    this.prune();
    const download = this.downloads.get(downloadId);
    // hide missing, cross-session, expired and replayed manifests alike
    if (download === undefined || download.sessionId !== session.id || download.expiresAt < this.now() || download.opened) throw new HostFilesError('not_found', 'download unavailable', 404);
    download.opened = true;
    let source: Readable;
    try {
      source = download.single === undefined
        ? createZipStream(this.options.backend, download.selections)
        : await this.options.backend.read({ kind: 'read', path: download.single.path, identity: download.single.identity });
      download.state = 'streaming';
      this.logLifecycle(download.id, 'download', download.placeId, 'running', download.selections.length, 0, this.now() - download.createdAt);
    } catch (error) {
      download.state = 'failed';
      download.error = (error as HostFilesError).code ?? 'partial_failure';
      this.logLifecycle(download.id, 'download', download.placeId, 'failed', download.selections.length, 0, this.now() - download.createdAt, download.error);
      throw error;
    }
    const stream = new Transform({
      // count bytes without flowing the readable side before its caller owns it
      transform(chunk: Buffer, _encoding, callback) {
        download.bytesCompleted += chunk.length;
        callback(null, chunk);
      },
    });
    // complete only after the caller consumes the readable side
    stream.once('end', () => { download.state = 'completed'; this.logLifecycle(download.id, 'download', download.placeId, 'completed', download.selections.length, download.bytesCompleted, this.now() - download.createdAt); });
    source.once('error', error => { download.state = 'failed'; download.error = (error as HostFilesError).code ?? 'partial_failure'; this.logLifecycle(download.id, 'download', download.placeId, 'failed', download.selections.length, download.bytesCompleted, this.now() - download.createdAt, download.error); stream.destroy(error); });
    source.pipe(stream);
    stream.once('close', () => {
      // stop backend work after a browser disconnect
      if (download.state === 'streaming') { download.state = 'failed'; download.error = 'partial_failure'; this.logLifecycle(download.id, 'download', download.placeId, 'failed', download.selections.length, download.bytesCompleted, this.now() - download.createdAt, download.error); source.destroy(); }
    });
    return { filename: download.filename, contentType: download.single === undefined ? 'application/zip' : 'application/octet-stream', stream };
  }

  // return one session-bound download status without a path
  downloadStatus(place: HostFilesPlace, session: HostFilesSession, downloadId: string): { state: PreparedDownload['state']; bytesCompleted: number; error?: string } {
    const download = this.downloads.get(downloadId);
    // hide another session or Place's status
    if (download === undefined || download.sessionId !== session.id || download.placeId !== place.id) throw new HostFilesError('not_found', 'download unavailable', 404);
    return { state: download.state, bytesCompleted: download.bytesCompleted, ...(download.error === undefined ? {} : { error: download.error }) };
  }

  // close the selected backend and release upload locks
  async close(): Promise<void> {
    // release every held upload lock
    for (const upload of this.uploads.values()) { clearTimeout(upload.expiryTimer); upload.release?.(); }
    await this.options.backend.close();
  }

  // freeze a bounded source or collision tree
  private async snapshot(selected: Pick<HostFileTokenPayload, 'path'|'identity'>): Promise<HostFilesTreeManifest> {
    const manifest = await this.options.backend.request({ kind: 'snapshot', path: selected.path, maxEntries: hostFilesLimits.recursiveEntries, maxBytes: hostFilesLimits.recursiveBytes });
    // require the backend snapshot root to retain the selected identity
    const root = manifest.entries.find(entry => entry.path === selected.path);
    if (root === undefined || !sameIdentity(root.identity, selected.identity)) throw new HostFilesError('stale_object', 'selected object changed', 409);
    return manifest;
  }

  // inspect one possible destination and freeze a collision manifest
  private async prepareDestination(path: string, sourceName: string, conflicts: OperationConflict[]): Promise<PreparedItem> {
    try {
      const current = await this.options.backend.request({ kind: 'inspect', path });
      const destinationManifest = await this.snapshot({ path, identity: current });
      const conflictId = randomUUID();
      let keepBothPath: string | undefined;
      // find one absent deterministic sibling
      for (let attempt = 1; attempt <= 10_000; attempt += 1) {
        const candidate = keepBothCandidate(path, attempt);
        const exists = await this.options.backend.request({ kind: 'inspect', path: candidate }).then(() => true, error => {
          // treat only a missing candidate as available
          if ((error as HostFilesError).code === 'not_found') return false;
          throw error;
        });
        // stop at the first absent sibling
        if (!exists) { keepBothPath = candidate; break; }
      }
      // preserve bounded keep-both search
      if (keepBothPath === undefined) throw new HostFilesError('limit_exceeded', 'no keep-both name is available', 413);
      conflicts.push({ id: conflictId, sourceName, destinationName: basename(path), allowed: ['replace', 'skip', 'keep-both'] });
      return { destinationPath: path, destinationIdentity: current, destinationManifest, conflictId, keepBothPath, name: sourceName };
    } catch (error) {
      // retain an expected absent destination
      if ((error as HostFilesError).code === 'not_found') return { destinationPath: path, name: sourceName };
      throw error;
    }
  }

  // revalidate and decode one current object token
  private async objectToken(place: HostFilesPlace, session: HostFilesSession, token: string): Promise<HostFileTokenPayload> {
    const selected = this.tokens.verify(token, { purpose: 'object', sessionId: session.id, placeId: place.id });
    // reject malformed, expired and wrong-purpose tokens uniformly
    if (selected === undefined) throw new HostFilesError('stale_object', 'file selection is invalid or expired', 409);
    await this.revalidatePayload(selected);
    return selected;
  }

  // decode a signed source token from any Place on this same server/session
  private async crossPlaceSourceToken(session: HostFilesSession, token: string): Promise<HostFileTokenPayload> {
    const selected = this.tokens.verify(token, { purpose: 'object', sessionId: session.id });
    // reject malformed, expired and cross-session source capabilities
    if (selected === undefined) throw new HostFilesError('stale_object', 'file selection is invalid or expired', 409);
    await this.revalidatePayload(selected);
    return selected;
  }

  // revalidate and decode one canonical directory token
  private async directoryToken(place: HostFilesPlace, session: HostFilesSession, token: string): Promise<HostFileTokenPayload> {
    const selected = this.tokens.verify(token, { purpose: 'destination-directory', sessionId: session.id, placeId: place.id });
    // reject malformed, expired and wrong-purpose tokens uniformly
    if (selected === undefined || selected.identity.kind !== 'directory') throw new HostFilesError('stale_object', 'destination folder is invalid or expired', 409);
    await this.revalidatePayload(selected);
    return selected;
  }

  // compare one token with a fresh backend lstat
  private async revalidatePayload(selected: Pick<HostFileTokenPayload, 'path'|'identity'>): Promise<HostFileStat> {
    const current = await this.options.backend.request({ kind: 'inspect', path: selected.path });
    // stop before mutation when any identity field changed
    if (!sameIdentity(selected.identity, current)) throw new HostFilesError('stale_object', 'selected object changed', 409);
    return current;
  }

  // load a bounded stream into the existing preview renderer
  private async readBounded(stream: Readable, expected: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let size = 0;
    // read no more than the already bounded request length
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      size += bytes.length;
      // reject a backend that exceeded its read bound
      if (size > expected) { stream.destroy(); throw new HostFilesError('limit_exceeded', 'preview exceeds limit', 413); }
      chunks.push(bytes);
    }
    return Buffer.concat(chunks, size);
  }

  // execute one prepared manifest and publish terminal per-item results
  private async runOperation(prepared: PreparedOperation, decisions: Record<string, CollisionDecision>): Promise<void> {
    const releaseFavorites = prepared.kind === 'move' || prepared.kind === 'rename' ? await this.favoriteMutations.acquire() : undefined;
    let activeItem: PreparedItem | undefined;
    try {
      // refresh every prepared identity after waiting behind another favorite mutation sequence
      if (releaseFavorites !== undefined) await this.prevalidateOperation(prepared, decisions);
      // execute top-level items sequentially so each parent ctime is refreshed
      for (const item of prepared.items) {
        activeItem = item;
        const result = await this.runItem(prepared, item, decisions);
        prepared.operation.results.push(...result.results);
        prepared.operation.bytesCompleted += result.bytesCompleted;
        prepared.operation.completedItems += 1;
      }
      const failed = prepared.operation.results.some(result => result.outcome === 'failed');
      prepared.operation.state = failed ? 'partial' : 'completed';
      prepared.operation.phase = 'complete';
      prepared.expiresAt = this.now() + 15 * 60_000;
      this.logLifecycle(prepared.id, prepared.kind, prepared.placeId, prepared.operation.state, prepared.items.length, prepared.operation.bytesCompleted, this.now() - prepared.createdAt, failed ? 'partial_failure' : undefined);
    } catch (error) {
      const failure = error as HostFilesError;
      const code = failure.code ?? 'partial_failure';
      prepared.operation.results.push({ sourcePath: activeItem?.source?.path, destinationPath: activeItem?.destinationPath, outcome: 'failed', code, message: failure.message });
      const mayHavePublished = code === 'partial_failure' || code === 'favorite_freshness_pending';
      prepared.operation.state = prepared.operation.completedItems > 0 || mayHavePublished ? 'partial' : 'failed';
      prepared.operation.phase = 'failed';
      prepared.expiresAt = this.now() + 15 * 60_000;
      this.logLifecycle(prepared.id, prepared.kind, prepared.placeId, prepared.operation.state, prepared.items.length, prepared.operation.bytesCompleted, this.now() - prepared.createdAt, code);
    } finally { releaseFavorites?.(); }
  }

  // revalidate every source, parent and conflict before the batch's first write
  private async prevalidateOperation(prepared: PreparedOperation, decisions: Record<string, CollisionDecision>): Promise<void> {
    // freeze the original destination parent before any item mutation
    if (prepared.destination !== undefined) await this.revalidatePayload(prepared.destination);
    // validate every prepared source and destination state
    for (const item of prepared.items) {
      // validate one recursive source manifest
      if (item.source !== undefined) {
        await this.revalidatePayload(item.source);
        const current = await this.options.backend.request({ kind: 'snapshot', path: item.source.path, maxEntries: hostFilesLimits.recursiveEntries, maxBytes: hostFilesLimits.recursiveBytes });
        // reject any changed descendant before the batch begins
        if (item.sourceManifest === undefined || !sameManifest(item.sourceManifest, current)) throw new HostFilesError('stale_object', 'selected tree changed', 409);
      }
      await this.revalidatePreparedDestination(item, item.conflictId === undefined ? undefined : decisions[item.conflictId]);
    }
  }

  // revalidate one prepared conflict or expected absence
  private async revalidatePreparedDestination(item: Pick<PreparedItem, 'destinationPath'|'destinationIdentity'|'destinationManifest'|'keepBothPath'>, decision?: CollisionDecision): Promise<void> {
    // delete items have no destination state
    if (item.destinationPath === undefined) return;
    // require expected absence when no collision was prepared
    if (item.destinationIdentity === undefined) {
      const exists = await this.options.backend.request({ kind: 'inspect', path: item.destinationPath }).then(() => true, error => {
        // accept only an absent destination
        if ((error as HostFilesError).code === 'not_found') return false;
        throw error;
      });
      if (exists) throw new HostFilesError('conflict', 'destination now exists', 409);
      return;
    }
    const current = await this.options.backend.request({ kind: 'snapshot', path: item.destinationPath, maxEntries: hostFilesLimits.recursiveEntries, maxBytes: hostFilesLimits.recursiveBytes });
    // require the complete prepared collision tree for every decision
    if (item.destinationManifest === undefined || !sameManifest(item.destinationManifest, current)) throw new HostFilesError('stale_object', 'destination conflict changed', 409);
    // additionally validate the keep-both candidate remains absent
    if (decision === 'keep-both') {
      const exists = await this.options.backend.request({ kind: 'inspect', path: item.keepBothPath! }).then(() => true, error => {
        // accept only an absent candidate
        if ((error as HostFilesError).code === 'not_found') return false;
        throw error;
      });
      if (exists) throw new HostFilesError('conflict', 'keep-both destination now exists', 409);
    }
  }

  // execute one item from the immutable prepared manifest
  private async runItem(prepared: PreparedOperation, item: PreparedItem, decisions: Record<string, CollisionDecision>): Promise<HostFilesMutationResult> {
    const decision = item.conflictId === undefined ? undefined : decisions[item.conflictId];
    // return one explicit skip without mutation
    if (decision === 'skip') return { bytesCompleted: 0, results: [{ sourcePath: item.source?.path, destinationPath: item.destinationPath, outcome: 'skipped' }] };
    // permanently remove one prepared source manifest
    if (prepared.kind === 'delete') return await this.options.backend.request({ kind: 'remove', operationId: prepared.id, items: [{ path: item.source!.path, identity: item.source!.identity, manifest: item.sourceManifest! }] });
    const parent = await this.options.backend.request({ kind: 'inspect', path: prepared.destination!.path });
    const destinationPath = decision === 'keep-both' ? item.keepBothPath! : item.destinationPath!;
    const replace = decision === 'replace';
    // create one exclusive file or directory
    if (prepared.kind === 'create-file' || prepared.kind === 'create-folder') return await this.options.backend.request({ kind: 'create', operationId: prepared.id, path: destinationPath, objectKind: prepared.kind === 'create-file' ? 'file' : 'directory', parentIdentity: parent, ...(replace && item.destinationIdentity !== undefined ? { destinationIdentity: item.destinationIdentity, destinationManifest: item.destinationManifest } : {}), replace });
    const source = item.source!;
    // use the phased special-object contract for same-parent rename only
    if (prepared.kind === 'rename' && !['file', 'directory', 'symlink'].includes(source.identity.kind)) return await this.runSpecialRename(prepared, item, destinationPath, parent, replace);
    // reject special-object cross-directory moves before publication
    if (!['file', 'directory', 'symlink'].includes(source.identity.kind)) throw new HostFilesError('unsupported_relocation', 'special objects can only be renamed in place', 422);
    const copied = await this.options.backend.request({ kind: 'copy', operationId: prepared.id, sourcePath: source.path, sourceIdentity: source.identity, sourceManifest: item.sourceManifest!, destinationPath, destinationParentIdentity: parent, ...(replace && item.destinationIdentity !== undefined ? { destinationIdentity: item.destinationIdentity, destinationManifest: item.destinationManifest } : {}), replace });
    // preserve the source for ordinary copy
    if (prepared.kind === 'copy') return copied;
    try {
      await this.rewriteMovedFavorites(source.path, destinationPath, item.sourceManifest!);
    } catch {
      throw new HostFilesError('partial_failure', 'destination published; source retained because favorites could not be updated', 409);
    }
    const removed = await this.options.backend.request({ kind: 'remove', operationId: prepared.id, items: [{ path: source.path, identity: source.identity, manifest: item.sourceManifest! }] });
    const failed = removed.results.some(result => result.outcome === 'failed');
    // report destination publication with any retained source accurately
    if (failed) return { ...copied, results: [{ sourcePath: source.path, destinationPath, outcome: 'failed', code: 'partial_failure', message: 'destination published; source partly retained' }] };
    return { ...copied, results: [{ sourcePath: source.path, destinationPath, outcome: prepared.kind === 'rename' ? 'renamed' : 'moved' }] };
  }

  // complete a journaled special-object rename around two favorite writes
  private async runSpecialRename(prepared: PreparedOperation, item: PreparedItem, destinationPath: string, parent: HostFileIdentity, replace: boolean): Promise<HostFilesMutationResult> {
    const source = item.source!;
    const matches = (await this.favorites.beneath(source.path)).filter(match => sameFavoriteObject(match.favorite.identity, source.identity));
    const linked = await this.options.backend.request({ kind: 'link-special', operationId: prepared.id, sourcePath: source.path, sourceIdentity: source.identity, destinationPath, destinationParentIdentity: parent, ...(replace && item.destinationIdentity !== undefined ? { destinationIdentity: item.destinationIdentity, destinationManifest: item.destinationManifest } : {}), replace });
    const phaseOne: FavoriteRewrite[] = matches.map(match => ({ placeId: match.placeId, favoriteId: match.favorite.id, path: destinationPath, identity: linked.destinationIdentity, freshness: { operationId: prepared.id, state: 'pending-final-ctime' } }));
    try { await this.favorites.rewrite(phaseOne); }
    catch (error) { await this.options.backend.request({ kind: 'abort-special', operationId: prepared.id }); throw error; }
    const unlinked = await this.options.backend.request({ kind: 'unlink-special', operationId: prepared.id, sourcePath: source.path, sourceIdentity: linked.sourceIdentity, destinationPath, destinationIdentity: linked.destinationIdentity });
    const phaseTwo = phaseOne.map(rewrite => ({ ...rewrite, identity: unlinked.destinationIdentity, freshness: undefined }));
    try { await this.favorites.rewrite(phaseTwo); }
    catch { throw new HostFilesError('favorite_freshness_pending', 'favorite freshness repair is pending', 409); }
    await this.options.backend.request({ kind: 'finalize-special', operationId: prepared.id });
    return { bytesCompleted: 0, results: [{ sourcePath: source.path, destinationPath, outcome: 'renamed' }], destinationIdentity: unlinked.destinationIdentity };
  }

  // atomically retarget every favorite within a moved subtree before source removal
  private async rewriteMovedFavorites(sourcePath: string, destinationPath: string, sourceManifest: HostFilesTreeManifest): Promise<void> {
    const frozen = new Map(sourceManifest.entries.map(entry => [entry.path, entry.identity]));
    const matches = (await this.favorites.beneath(sourcePath)).filter(match => {
      const identity = frozen.get(match.favorite.path);
      return identity !== undefined && sameFavoriteObject(match.favorite.identity, identity);
    });
    const rewrites: FavoriteRewrite[] = [];
    // resolve every new destination identity before one store write
    for (const match of matches) {
      const suffix = relative(sourcePath, match.favorite.path);
      const path = suffix === '' ? destinationPath : join(destinationPath, suffix);
      const current = await this.options.backend.request({ kind: 'inspect', path });
      rewrites.push({ placeId: match.placeId, favoriteId: match.favorite.id, path, identity: current });
    }
    await this.favorites.rewrite(rewrites);
  }

  // retrieve one fresh prepared operation in this session and Place
  private preparedOperation(place: HostFilesPlace, session: HostFilesSession, operationId: string): PreparedOperation {
    this.prune();
    const prepared = this.operations.get(operationId);
    // hide missing and cross-scope operations alike
    if (prepared === undefined || prepared.sessionId !== session.id || prepared.placeId !== place.id || prepared.expiresAt < this.now()) throw new HostFilesError('not_found', 'file operation not found', 404);
    return prepared;
  }

  // retrieve one fresh upload in this session and Place
  private preparedUpload(place: HostFilesPlace, session: HostFilesSession, uploadId: string): PreparedUpload {
    this.prune();
    const upload = this.uploads.get(uploadId);
    // hide missing and cross-scope uploads alike
    if (upload === undefined || upload.sessionId !== session.id || upload.placeId !== place.id || upload.expiresAt < this.now()) throw new HostFilesError('not_found', 'upload not found', 404);
    return upload;
  }

  // release one batch lock only after every file is terminal
  private releaseUploadIfDone(upload: PreparedUpload): void {
    // retain locks while any authorized body may still arrive
    if (upload.files.some(file => file.state === 'prepared' || file.state === 'authorized' || file.state === 'uploading')) return;
    upload.release?.();
    upload.release = undefined;
    clearTimeout(upload.expiryTimer);
    upload.expiryTimer = undefined;
    this.logUploadTerminal(upload);
  }

  // log one upload terminal state exactly once
  private logUploadTerminal(upload: PreparedUpload): void {
    // suppress repeated cleanup/status calls
    if (upload.loggedTerminal) return;
    upload.loggedTerminal = true;
    const failed = upload.files.some(file => file.state === 'failed');
    const completed = upload.files.filter(file => file.state === 'completed' || file.state === 'skipped').length;
    this.logLifecycle(upload.id, 'upload', upload.placeId, failed ? completed > 0 ? 'partial' : 'failed' : 'completed', upload.files.length, upload.files.filter(file => file.state === 'completed').reduce((total, file) => total + file.size, 0), this.now() - upload.createdAt, failed ? upload.files.find(file => file.result?.code !== undefined)?.result?.code ?? 'partial_failure' : undefined);
  }

  // emit one sanitized lifecycle transition without paths, tokens or session values
  private logLifecycle(operationId: string, kind: string, placeId: string, state: string, itemCount: number, byteCount: number, durationMs: number, errorCode?: string): void {
    console.info(`[host-files] ${JSON.stringify({ event: 'host_files_lifecycle', operationId, kind, place: placeLogId(placeId), backendGeneration: this.options.backend.generation(), itemCount, byteCount, durationMs, state, ...(errorCode === undefined ? {} : { errorCode }) })}`);
  }

  // expire bounded in-memory manifests and release held upload locks
  private prune(): void {
    const current = this.now();
    // retain terminal operations briefly for polling
    for (const [id, operation] of this.operations) if (operation.operation.state !== 'running' && operation.expiresAt < current) this.operations.delete(id);
    // release expired upload locks
    for (const [id, upload] of this.uploads) {
      // remove only expired batches
      if (upload.expiresAt >= current) continue;
      // retain active bodies and their overlap lock through terminal cleanup
      if (upload.files.some(file => file.state === 'uploading')) continue;
      // make unused capabilities terminal before releasing their lock
      for (const file of upload.files) {
        if (file.state === 'prepared' || file.state === 'authorized') { file.state = 'failed'; file.token = undefined; file.result = { destinationPath: file.destinationPath, outcome: 'failed', code: 'stale_object', message: 'upload authorization expired' }; }
      }
      clearTimeout(upload.expiryTimer);
      upload.release?.();
      this.logUploadTerminal(upload);
      this.uploads.delete(id);
    }
    // discard expired prepared downloads
    for (const [id, download] of this.downloads) if (download.expiresAt < current && download.state !== 'streaming') this.downloads.delete(id);
  }
}
