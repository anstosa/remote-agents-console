/** one configured Agent kind exposed by launch-option wire contracts. */
export type AgentKind = 'codex' | 'omx' | 'claude' | 'pi' | 'opencode';

/** the server-resolved launch target whose native options a picker needs. */
export type LaunchSelectionTarget =
  | { type: 'worktree'; id: string }
  | { type: 'project'; id: string }
  | { type: 'scratch' }
  | { type: 'folder'; path: string }
  | { type: 'agent'; id: string }
  | { type: 'new-worktree'; projectId: string; mode: string };

/** one explicit or inherited model choice for a manual launch. */
export type ModelSelection =
  | { mode: 'model'; id: string }
  | { mode: 'keep-current' }
  | { mode: 'native-default' };

/** one explicit or model-owned Effort choice for a manual launch. */
export type EffortSelection =
  | { mode: 'effort'; id: string }
  | { mode: 'model-default' };

/** semantic native execution controls, never RAC/MCP permissions. */
export type NativeLaunchSecurity = Record<string, string>;

/** a browser-authored semantic choice; the server remains authoritative. */
export type ManualLaunchChoice = {
  kind: AgentKind;
  model?: ModelSelection;
  effort?: EffortSelection;
  security?: NativeLaunchSecurity;
  optionsRevision?: string;
  /** same-version compatibility for the former Pi-only control. */
  sandboxed?: boolean;
};

/** one model advertised by the configured native launch context. */
export type LaunchCatalogModel = {
  id: string;
  name: string;
  provider?: string;
  efforts: string[];
  defaultEffort?: string;
};

/** the effective model policy and discovery state for one Agent kind. */
export type LaunchModelPolicy = {
  state: 'explicit' | 'native-default' | 'empty';
  allowed: Array<{ model: string; effort?: string; available?: boolean }>;
  defaultSelection: ModelSelection;
  /** the exact model preserved by an authoritative keep-current default. */
  currentModel?: string;
  /** the supported current session Effort preserved by keep-current. */
  currentEffort?: string;
  /** supported effective Effort defaults keyed by selectable model identity. */
  effortDefaults?: Record<string, string>;
  catalog: LaunchCatalogModel[];
  catalogStatus: 'ready' | 'unavailable' | 'unsupported';
  message?: string;
};

/** one semantic execution-security control and its supported choices. */
export type LaunchSecurityControl = {
  id: string;
  label: string;
  icon: 'reset' | 'file' | 'shield' | 'hand' | 'warning';
  options: Array<{ id: string; label: string; risk: 'normal' | 'warning' | 'danger'; detail: string }>;
};

/** one dependency constraint among native security choices. */
export type LaunchSecurityConstraint = {
  when: Record<string, string>;
  disables: string[];
  message: string;
};

/** native security capabilities for one configured Agent kind. */
export type LaunchSecurityManifest = {
  controls: LaunchSecurityControl[];
  defaults: NativeLaunchSecurity;
  constraints: LaunchSecurityConstraint[];
  status: 'ready' | 'partial' | 'unsupported';
  message?: string;
};

/** context-bound options for one configured Agent kind. */
export type LaunchKindManifest = {
  kind: AgentKind;
  optionsRevision: string;
  modelPolicy: LaunchModelPolicy;
  security: LaunchSecurityManifest;
};

/** all launch cards for one picker target. */
export type LaunchOptionsResponse = { kinds: LaunchKindManifest[] };

/** a validated immutable manual choice used after side-effect boundaries. */
export type PreparedLaunchChoice = {
  kind: AgentKind;
  model?: { model: string; effort?: string };
  keepCurrent?: true;
  nativeDefault?: true;
  security: NativeLaunchSecurity;
  optionsRevision: string;
};
