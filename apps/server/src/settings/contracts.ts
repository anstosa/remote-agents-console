// describe safe schema controls
export type SettingsSchema = { type: 'object' | 'array' | 'record' | 'string' | 'number' | 'boolean' | 'enum' | 'json' | 'union'; optional?: boolean; nullable?: boolean; protected?: boolean; apply?: SettingsApply; default?: unknown; label?: string; description?: string; properties?: Record<string, SettingsSchema>; items?: SettingsSchema; options?: string[]; variants?: SettingsSchema[] };
export type SettingsTarget = 'rac' | 'cloudflared';
export type SettingsApply = 'live' | 'saved-only' | 'rac-restart' | 'cloudflared-recreate' | 'source-migration';
export type SettingsFormat = 'json' | 'env' | 'compose' | 'cloudflared' | 'credentials' | 'wrapper' | 'svg' | 'installation';
export type ProtectedValue = { __racProtected: true; present: boolean; hasValue?: boolean };
export type SettingsFallback = { value: string; kind: 'literal' | 'derived' | 'compose' };
export type SettingsField = { key: string; value?: string; protected: boolean; present: boolean; hasValue?: boolean; apply: SettingsApply; description?: string; fallback?: SettingsFallback; origin?: string; overriddenBy?: string; winningSource?: string };
export type SettingsSource = { id: string; label: string; path?: string; format: SettingsFormat; exists: boolean; writable: boolean; protected: boolean; tracked: boolean; revisionId: string; apply: SettingsApply; content?: string; hasProtectedContent: boolean; value?: unknown; schema?: SettingsSchema; fields?: SettingsField[]; origin?: string; overriddenBy?: string; pathRevisions?: Record<string, string> };
export type SettingsOperation = { id: string; state: 'queued' | 'running' | 'complete' | 'failed'; phase?: string; error?: string };
export type SettingsStatus = { pending: boolean; targets: SettingsTarget[]; effective: 'known' | 'unknown'; restartAvailable: boolean; reason?: string; operation?: SettingsOperation; reconnectOrigin?: string; reloginRequired?: boolean; recoveryCommand?: string };
export type SettingsSnapshot = { version: 1; installationKind?: Installation['kind']; revisionId: string; sources: SettingsSource[]; status: SettingsStatus };
export type SettingsPatch = { op: 'set' | 'remove' | 'insert' | 'move'; path: string[]; value?: unknown; index?: number; from?: number; to?: number; revisionId?: string };
export type SettingsChange = { sourceId: string; revisionId: string; patches?: SettingsPatch[]; content?: string; remove?: boolean; migration?: { mode: 'copy' | 'adopt' | 'empty' } };
export type SettingsInput = { changes: SettingsChange[] };
export type SettingsIssue = { sourceId: string; path: string[]; code: string; message: string };
export type SettingsValidation = { valid: boolean; issues: SettingsIssue[]; warnings?: string[] };
export type InstallationSource = { path: string; serverPath?: string; kind: SettingsFormat; optional?: boolean; apply: Exclude<SettingsApply, 'source-migration'> };
export type Installation = { version: 1; installationId: string; generation: number; uid: number; gid: number; kind: 'compose' | 'systemd'; hostControlRoot: string; hostCheckout: string; serverCheckout: string; allowedRoots: string[]; sources: Record<string, InstallationSource>; compose?: { projectDirectory: string; projectName: string; files: string[]; envFiles: string[]; profiles: string[]; options?: { parallel?: number; compatibility?: boolean } }; native?: { unit: string; environmentFile: string; cloudflaredUnit?: string } };
export type RevealContext = { bootNonce: string; sessionBinding: string; revisionId: string; contentHash: string; existed: boolean };
export type HostRequest = { version: 1; id: string; kind: 'inspect' | 'read' | 'validate' | 'commit' | 'restart' | 'reveal' | 'reconcile' | 'recover'; generation: number; sources?: { id: string; contentHash: string; existed?: boolean; candidate?: string; remove?: boolean; migration?: { mode: 'copy' | 'adopt' | 'empty' } }[]; targets?: SettingsTarget[]; inspect?: { sourceId: string }; reveal?: RevealContext & { sourceId: string; publicKey: string; nonce: string; binding: string; expiresAt: number } };
export type RevealEnvelope = { version: 1; publicKey: string; salt: string; iv: string; tag: string; ciphertext: string; binding: string; expiresAt: number };
export type HostReceipt = { generation: number; hashes: Record<string, string>; targets: SettingsTarget[]; bootNonce?: string; completedAt: string; semanticHashes?: Record<string, string>; environmentFileHashes?: Record<string, string>; shadowedEnvironmentKeys?: string[] };
export type HostReply = { version: 1; id: string; state: SettingsOperation['state']; kind: HostRequest['kind']; phase?: string; error?: string; errorMetadata?: { sourceIds: string[] }; receipt?: HostReceipt; response?: RevealEnvelope; sourceMetadata?: { sourceId: string; contentHash: string; existed: boolean } };
// keep public failures bounded
export class SettingsError extends Error {
  // retain only safe diagnostics
  constructor(public readonly code: string, public readonly statusCode = 400, public readonly issues: SettingsIssue[] = []) { super(code); }
}
