import type { Readable, Writable } from 'node:stream';

export const hostFileKinds = ['file', 'directory', 'symlink', 'fifo', 'socket', 'block', 'character', 'other'] as const;
export type HostFileKind = typeof hostFileKinds[number];
export type HostFileTargetKind = 'file'|'directory'|'missing'|'inaccessible'|'other';
export type HostFileIdentity = {
  dev: string;
  ino: string;
  ctimeNs: string;
  mtimeNs: string;
  size: string;
  nlink: string;
  kind: HostFileKind;
};
export type HostFileStat = HostFileIdentity & {
  path: string;
  name: string;
  uid: number;
  owner: string;
  permissions: string;
  mode: number;
  modifiedAt: string;
  sizeBytes: number;
  symlinkTargetKind?: HostFileTargetKind;
};
export type HostFilesListResult = {
  path: string;
  parent?: string;
  directory: HostFileIdentity;
  entries: HostFileStat[];
  truncated: boolean;
  // count child metadata denials without granting those objects capabilities
  inaccessibleEntries: number;
};
export type HostFilesTreeEntry = { path: string; identity: HostFileIdentity; linkTarget?: string };
export type HostFilesTreeManifest = { root: string; entries: HostFilesTreeEntry[]; totalBytes: number };

export type HostFilesItemOutcome = 'created'|'copied'|'moved'|'deleted'|'renamed'|'uploaded'|'skipped'|'failed';
export type HostFilesItemResult = {
  sourcePath?: string;
  destinationPath?: string;
  outcome: HostFilesItemOutcome;
  code?: HostFilesErrorCode;
  message?: string;
};
export type HostFilesMutationResult = { results: HostFilesItemResult[]; bytesCompleted: number; sourceIdentity?: HostFileIdentity; destinationIdentity?: HostFileIdentity };

export type HostFilesInspectCommand = { kind: 'inspect'; path: string; followSymlink?: boolean };
export type HostFilesListCommand = { kind: 'list'; path: string; maxEntries: number };
export type HostFilesSnapshotCommand = { kind: 'snapshot'; path: string; maxEntries: number; maxBytes: number };
export type HostFilesCreateCommand = { kind: 'create'; operationId: string; path: string; objectKind: 'file'|'directory'; parentIdentity: HostFileIdentity; destinationIdentity?: HostFileIdentity; destinationManifest?: HostFilesTreeManifest; replace: boolean };
export type HostFilesCopyCommand = { kind: 'copy'; operationId: string; sourcePath: string; sourceIdentity: HostFileIdentity; sourceManifest: HostFilesTreeManifest; destinationPath: string; destinationParentIdentity: HostFileIdentity; destinationIdentity?: HostFileIdentity; destinationManifest?: HostFilesTreeManifest; replace: boolean };
export type HostFilesMoveCommand = { kind: 'move'; operationId: string; sourcePath: string; sourceIdentity: HostFileIdentity; sourceManifest: HostFilesTreeManifest; destinationPath: string; destinationParentIdentity: HostFileIdentity; destinationIdentity?: HostFileIdentity; destinationManifest?: HostFilesTreeManifest; replace: boolean };
export type HostFilesRemoveCommand = { kind: 'remove'; operationId: string; items: Array<{ path: string; identity: HostFileIdentity; manifest: HostFilesTreeManifest }> };
export type HostFilesLinkSpecialCommand = { kind: 'link-special'; operationId: string; sourcePath: string; sourceIdentity: HostFileIdentity; destinationPath: string; destinationParentIdentity: HostFileIdentity; destinationIdentity?: HostFileIdentity; destinationManifest?: HostFilesTreeManifest; replace: boolean };
export type HostFilesUnlinkSpecialCommand = { kind: 'unlink-special'; operationId: string; sourcePath: string; sourceIdentity: HostFileIdentity; destinationPath: string; destinationIdentity: HostFileIdentity };
export type HostFilesFinalizeSpecialCommand = { kind: 'finalize-special'; operationId: string };
export type HostFilesAbortSpecialCommand = { kind: 'abort-special'; operationId: string };
export type HostFilesSpecialLinkResult = { operationId: string; sourceIdentity: HostFileIdentity; destinationIdentity: HostFileIdentity; backup?: { path: string; identity: HostFileIdentity } };
export type HostFilesSpecialUnlinkResult = { operationId: string; destinationIdentity: HostFileIdentity };
export type HostFilesFavoriteRewrite = { placeId: string; favoriteId: string; path: string; identity: HostFileIdentity; freshness?: FavoriteRecord['freshness'] };
export type HostFilesFavoriteMatch = { placeId: string; favorite: FavoriteRecord };
export type HostFilesFavoritesListCommand = { kind: 'favorites-list'; placeId: string };
export type HostFilesFavoritesAddCommand = { kind: 'favorites-add'; placeId: string; path: string; identity: HostFileIdentity };
export type HostFilesFavoritesAcknowledgeCommand = { kind: 'favorites-acknowledge'; placeId: string; favoriteId: string; path: string; identity: HostFileIdentity };
export type HostFilesFavoritesRemoveCommand = { kind: 'favorites-remove'; placeId: string; favoriteId: string };
export type HostFilesFavoritesBeneathCommand = { kind: 'favorites-beneath'; path: string };
export type HostFilesFavoritesRewriteCommand = { kind: 'favorites-rewrite'; rewrites: HostFilesFavoriteRewrite[] };
export type HostFilesCommand = HostFilesInspectCommand|HostFilesListCommand|HostFilesSnapshotCommand|HostFilesCreateCommand|HostFilesCopyCommand|HostFilesMoveCommand|HostFilesRemoveCommand|HostFilesLinkSpecialCommand|HostFilesUnlinkSpecialCommand|HostFilesFinalizeSpecialCommand|HostFilesAbortSpecialCommand|HostFilesFavoritesListCommand|HostFilesFavoritesAddCommand|HostFilesFavoritesAcknowledgeCommand|HostFilesFavoritesRemoveCommand|HostFilesFavoritesBeneathCommand|HostFilesFavoritesRewriteCommand;

export type HostFilesCommandResult<T extends HostFilesCommand> =
  T extends HostFilesInspectCommand ? HostFileStat :
  T extends HostFilesListCommand ? HostFilesListResult :
  T extends HostFilesSnapshotCommand ? HostFilesTreeManifest :
  T extends HostFilesCreateCommand ? HostFilesMutationResult :
  T extends HostFilesCopyCommand ? HostFilesMutationResult :
  T extends HostFilesMoveCommand ? HostFilesMutationResult :
  T extends HostFilesRemoveCommand ? HostFilesMutationResult :
  T extends HostFilesLinkSpecialCommand ? HostFilesSpecialLinkResult :
  T extends HostFilesUnlinkSpecialCommand ? HostFilesSpecialUnlinkResult :
  T extends HostFilesFinalizeSpecialCommand ? HostFilesMutationResult :
  T extends HostFilesAbortSpecialCommand ? HostFilesMutationResult :
  T extends HostFilesFavoritesListCommand ? FavoriteRecord[] :
  T extends HostFilesFavoritesAddCommand ? FavoriteRecord :
  T extends HostFilesFavoritesAcknowledgeCommand ? FavoriteRecord :
  T extends HostFilesFavoritesRemoveCommand ? boolean :
  T extends HostFilesFavoritesBeneathCommand ? HostFilesFavoriteMatch[] :
  T extends HostFilesFavoritesRewriteCommand ? { ok: true } : never;

export type HostFilesReadCommand = { kind: 'read'; path: string; identity?: HostFileIdentity; start?: number; length?: number };
export type HostFilesWriteCommand = { kind: 'write'; operationId: string; path: string; size: number; destinationParentIdentity: HostFileIdentity; destinationIdentity?: HostFileIdentity; destinationManifest?: HostFilesTreeManifest; replace: boolean };
export type HostFilesWriteResult = { path: string; bytesWritten: number; identity: HostFileIdentity };

export interface HostFilesBackend {
  // expose the capability generation that binds every issued token
  generation(): string;
  // execute one bounded metadata or mutation command
  request<T extends HostFilesCommand>(command: T, signal?: AbortSignal): Promise<HostFilesCommandResult<T>>;
  // stream one regular file without buffering it in the control protocol
  read(command: HostFilesReadCommand, signal?: AbortSignal): Promise<Readable>;
  // stream one upload into an exclusively published regular file
  write(command: HostFilesWriteCommand, source: Readable, signal?: AbortSignal): Promise<HostFilesWriteResult>;
  // release backend resources and abort active work
  close(): Promise<void>;
}

export const hostFilesCommandKinds = ['inspect', 'list', 'snapshot', 'create', 'copy', 'move', 'remove', 'link-special', 'unlink-special', 'finalize-special', 'abort-special', 'favorites-list', 'favorites-add', 'favorites-acknowledge', 'favorites-remove', 'favorites-beneath', 'favorites-rewrite'] as const;

// validate one opaque operation id before broker dispatch
function isOperationId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{16,128}$/u.test(value);
}

// validate one bounded Place key without prototype-bearing aliases
function isHostFilesPlaceId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 4096 && !/[\0\n\r]/u.test(value)
    && value !== '__proto__' && value !== 'prototype' && value !== 'constructor';
}

// validate one backend-owned favorite rewrite
function isHostFilesFavoriteRewrite(value: unknown): value is HostFilesFavoriteRewrite {
  // require one complete rewrite record
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const rewrite = value as Record<string, unknown>;
  const freshness = rewrite.freshness;
  const validFreshness = freshness === undefined || freshness !== null && typeof freshness === 'object' && !Array.isArray(freshness)
    && isOperationId((freshness as Record<string, unknown>).operationId) && (freshness as Record<string, unknown>).state === 'pending-final-ctime';
  return isHostFilesPlaceId(rewrite.placeId) && isOperationId(rewrite.favoriteId) && isHostFilesPath(rewrite.path)
    && isHostFileIdentity(rewrite.identity) && validFreshness;
}

// validate one bounded frozen recursive manifest
export function isHostFilesTreeManifest(value: unknown): value is HostFilesTreeManifest {
  // require one manifest envelope
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const manifest = value as Record<string, unknown>;
  // require bounded aggregate fields
  if (!isHostFilesPath(manifest.root) || !Number.isSafeInteger(manifest.totalBytes) || Number(manifest.totalBytes) < 0 || !Array.isArray(manifest.entries) || manifest.entries.length < 1 || manifest.entries.length > 10_000) return false;
  return manifest.entries.every(entry => entry !== null && typeof entry === 'object'
    && isHostFilesPath((entry as { path?: unknown }).path)
    && ((entry as { linkTarget?: unknown }).linkTarget === undefined || typeof (entry as { linkTarget?: unknown }).linkTarget === 'string' && !(entry as { linkTarget: string }).linkTarget.includes('\0'))
    && isHostFileIdentity((entry as { identity?: unknown }).identity));
}

// validate one serialized filesystem identity
export function isHostFileIdentity(value: unknown): value is HostFileIdentity {
  // require one object with bounded decimal fields
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const identity = value as Record<string, unknown>;
  const decimal = (field: unknown) => typeof field === 'string' && /^\d{1,40}$/u.test(field);
  return decimal(identity.dev) && decimal(identity.ino) && decimal(identity.ctimeNs) && decimal(identity.mtimeNs)
    && decimal(identity.size) && decimal(identity.nlink) && (hostFileKinds as readonly unknown[]).includes(identity.kind);
}

// validate one bounded absolute host path at the protocol boundary
export function isHostFilesPath(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('/') && value.length <= 4096 && !value.includes('\0');
}

// validate one JSON-safe backend command without importing an HTTP validator
export function isHostFilesCommand(value: unknown): value is HostFilesCommand {
  // require one plain command envelope
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const command = value as Record<string, unknown>;
  // validate metadata commands
  if (command.kind === 'inspect') return isHostFilesPath(command.path) && (command.followSymlink === undefined || typeof command.followSymlink === 'boolean');
  // validate bounded listing commands
  if (command.kind === 'list') return isHostFilesPath(command.path) && Number.isInteger(command.maxEntries) && Number(command.maxEntries) >= 1 && Number(command.maxEntries) <= 10_000;
  // validate bounded tree snapshots
  if (command.kind === 'snapshot') return isHostFilesPath(command.path) && Number.isInteger(command.maxEntries) && Number(command.maxEntries) >= 1 && Number(command.maxEntries) <= 10_000
    && Number.isSafeInteger(command.maxBytes) && Number(command.maxBytes) >= 0;
  // validate exclusive create commands
  if (command.kind === 'create') return isOperationId(command.operationId) && isHostFilesPath(command.path) && (command.objectKind === 'file' || command.objectKind === 'directory') && isHostFileIdentity(command.parentIdentity)
    && (command.destinationIdentity === undefined || isHostFileIdentity(command.destinationIdentity)) && (command.destinationManifest === undefined || isHostFilesTreeManifest(command.destinationManifest)) && typeof command.replace === 'boolean';
  // validate recursive transfer commands
  if (command.kind === 'copy' || command.kind === 'move') return isOperationId(command.operationId) && isHostFilesPath(command.sourcePath) && isHostFileIdentity(command.sourceIdentity) && isHostFilesTreeManifest(command.sourceManifest)
    && isHostFilesPath(command.destinationPath) && isHostFileIdentity(command.destinationParentIdentity)
    && (command.destinationIdentity === undefined || isHostFileIdentity(command.destinationIdentity)) && (command.destinationManifest === undefined || isHostFilesTreeManifest(command.destinationManifest)) && typeof command.replace === 'boolean';
  // validate bounded recursive removal commands
  if (command.kind === 'remove') return isOperationId(command.operationId) && Array.isArray(command.items) && command.items.length >= 1 && command.items.length <= 1_000
    && command.items.every(item => item !== null && typeof item === 'object' && isHostFilesPath((item as { path?: unknown }).path)
      && isHostFileIdentity((item as { identity?: unknown }).identity) && isHostFilesTreeManifest((item as { manifest?: unknown }).manifest));
  // validate phased special-object publication
  if (command.kind === 'link-special') return isOperationId(command.operationId) && isHostFilesPath(command.sourcePath) && isHostFileIdentity(command.sourceIdentity)
    && isHostFilesPath(command.destinationPath) && isHostFileIdentity(command.destinationParentIdentity)
    && (command.destinationIdentity === undefined || isHostFileIdentity(command.destinationIdentity)) && (command.destinationManifest === undefined || isHostFilesTreeManifest(command.destinationManifest)) && typeof command.replace === 'boolean';
  // validate phased special-object source removal
  if (command.kind === 'unlink-special') return isOperationId(command.operationId) && isHostFilesPath(command.sourcePath) && isHostFileIdentity(command.sourceIdentity)
    && isHostFilesPath(command.destinationPath) && isHostFileIdentity(command.destinationIdentity);
  // validate special-operation cleanup requests
  if (command.kind === 'finalize-special' || command.kind === 'abort-special') return isOperationId(command.operationId);
  // validate backend-owned favorite reads
  if (command.kind === 'favorites-list') return isHostFilesPlaceId(command.placeId);
  // validate backend-owned favorite creation
  if (command.kind === 'favorites-add') return isHostFilesPlaceId(command.placeId) && isHostFilesPath(command.path) && isHostFileIdentity(command.identity);
  // validate explicit favorite replacement acknowledgement
  if (command.kind === 'favorites-acknowledge') return isHostFilesPlaceId(command.placeId) && isOperationId(command.favoriteId)
    && isHostFilesPath(command.path) && isHostFileIdentity(command.identity);
  // validate backend-owned favorite removal
  if (command.kind === 'favorites-remove') return isHostFilesPlaceId(command.placeId) && isOperationId(command.favoriteId);
  // validate bounded subtree favorite lookup
  if (command.kind === 'favorites-beneath') return isHostFilesPath(command.path);
  // validate one atomic bounded favorite rewrite set
  if (command.kind === 'favorites-rewrite') return Array.isArray(command.rewrites) && command.rewrites.length <= 20_000 && command.rewrites.every(isHostFilesFavoriteRewrite);
  return false;
}

// validate one stream-read command
export function isHostFilesReadCommand(value: unknown): value is HostFilesReadCommand {
  // require one read envelope
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const command = value as Record<string, unknown>;
  return command.kind === 'read' && isHostFilesPath(command.path)
    && (command.start === undefined || Number.isSafeInteger(command.start) && Number(command.start) >= 0)
    && (command.length === undefined || Number.isSafeInteger(command.length) && Number(command.length) >= 0);
}

// validate one stream-write command
export function isHostFilesWriteCommand(value: unknown): value is HostFilesWriteCommand {
  // require one write envelope
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const command = value as Record<string, unknown>;
  return command.kind === 'write' && isOperationId(command.operationId) && isHostFilesPath(command.path) && Number.isSafeInteger(command.size) && Number(command.size) >= 0
    && isHostFileIdentity(command.destinationParentIdentity) && (command.destinationIdentity === undefined || isHostFileIdentity(command.destinationIdentity))
    && (command.destinationManifest === undefined || isHostFilesTreeManifest(command.destinationManifest)) && typeof command.replace === 'boolean';
}

export type HostFilesErrorCode =
  'invalid_path'|'permission_denied'|'not_found'|'stale_object'|'favorite_replaced'|'favorite_freshness_pending'|
  'conflict'|'unsupported_type'|'unsupported_cross_filesystem_rename'|'unsupported_relocation'|'limit_exceeded'|
  'busy'|'broker_busy'|'bridge_unavailable'|'partial_failure'|'invalid_request';

export class HostFilesError extends Error {
  // retain a stable public code and status without exposing raw filesystem messages
  constructor(public readonly code: HostFilesErrorCode, message: string, public readonly statusCode: number, public readonly retryable = false) {
    super(message);
    this.name = 'HostFilesError';
  }
}

export type FileEntry = {
  name: string;
  hostPath: string;
  kind: HostFileKind;
  symlinkTargetKind?: HostFileTargetKind;
  owner: { uid: number; label: string };
  permissions: string;
  mode: number;
  modifiedAt: string;
  size: number;
  objectToken: string;
  favorite?: { id: string; state: FavoriteState };
};
export type FavoriteState = 'available'|'modified'|'repair-pending'|'replaced'|'unavailable';
export type FavoriteRecord = {
  id: string;
  path: string;
  identity: HostFileIdentity;
  createdAt: string;
  updatedAt: string;
  freshness?: { operationId: string; state: 'pending-final-ctime' };
};
export type FavoriteView = FavoriteRecord & { state: FavoriteState; entry?: FileEntry };

export type CollisionDecision = 'replace'|'skip'|'keep-both';
export type OperationKind = 'create-file'|'create-folder'|'rename'|'copy'|'move'|'delete';
export type OperationState = 'queued'|'running'|'completed'|'partial'|'failed'|'canceled';
export type OperationConflict = { id: string; sourceName: string; destinationName: string; allowed: CollisionDecision[] };
export type OperationResult = {
  operationId: string;
  kind: OperationKind;
  state: OperationState;
  phase: string;
  completedItems: number;
  totalItems: number;
  bytesCompleted: number;
  bytesTotal: number;
  results: HostFilesItemResult[];
};

export type HostFilesPlace = { id: string; home: string; hostPath?: string };
export type HostFilesOwnerContext = { namespace: 'browser' | 'davo' | 'conductor'; principalOwnerKey: string; leaseKey?: string };
export type HostFilesSession = { id: string } | HostFilesOwnerContext;

// bind browser and developer callers through one canonical capability owner
export function hostFilesOwner(session: HostFilesSession): HostFilesOwnerContext {
  // preserve existing browser ownership without making developer principals fake sessions
  if ('id' in session) return { namespace: 'browser', principalOwnerKey: session.id };
  return session;
}

// compare stable authority, optionally requiring the exact active lease
export function sameHostFilesOwner(left: HostFilesOwnerContext, right: HostFilesOwnerContext, leaseBound = false): boolean {
  return left.namespace === right.namespace && left.principalOwnerKey === right.principalOwnerKey && (!leaseBound || left.namespace !== 'davo' || left.leaseKey !== undefined && left.leaseKey === right.leaseKey);
}

// describe one generic byte sink for direct engine adapters
export type HostFilesWritableFactory = (command: HostFilesWriteCommand, signal?: AbortSignal) => Promise<Writable>;
