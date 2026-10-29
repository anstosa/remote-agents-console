import { access, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import type { Project, StackCommands, WorktreeOverride } from '../domain/models.js';
import { declaredProcesses, dependencyCycle } from '../domain/stack-processes.js';
import { gitCommonDir, listWorktrees } from '../git/worktrees.js';
import { adapterFor } from '../adapters/registry.js';
import { codexProgramName, omxProgramName } from '../adapters/program-names.js';
import { hostVisibleRepoRoot } from '../adapters/files.js';
import { agentKinds, type AdapterConfigs, type AdapterLaunchConfig, type AgentKind, type SandboxSettings } from '../adapters/types.js';
import { instanceIconNames, type InstanceIcon } from '../instance-icon.js';
import { isIP } from 'node:net';
import { defaultDavoContext, defaultDavoName } from '../integrations/realtime/settings.js';
import { conductorScopes, type IntegrationScope } from '../integrations/auth/types.js';
import { resolveReviewConfig, reviewConfigSchema, type ResolvedReviewConfig } from '../review-runs/config.js';
import { agentModel } from '../launch/agent-choice.js';
import { piEfforts } from '../transports/pi.js';
import { parseKeysConfig, type KeysConfig } from './keys.js';
import { applicationButtonsSchema, countButtonDefinitions, projectButtonsSchema, type ButtonSlots } from './buttons.js';
import { googleCalendarConfigSchema, type GoogleCalendarConfig } from '../google-calendar/contracts.js';

const loopback = new Set(['127.0.0.1', '::1']);
// wildcard binds expose every interface; require an explicit address instead
const wildcard = new Set(['0.0.0.0', '::']);
const command = z.string().min(1).max(32_000).refine((v) => !v.includes('\0'), 'NUL is forbidden');
// `status` is a probe and `setup` is a creation-time hook (run once when the console adds
// a Worktree), so neither is an operator-invokable stack action — see `stackActions`.
// A Stack process is a named foreground command (`dev: pnpm dev`) the console runs as a
// window of its Worktree's Workspace session; its name tags and names that window, so it
// stays a short tmux-safe token. A Worktree may declare several, run as one stack: a
// process is its command, or `{ command, dependsOn }` naming the processes of the same map
// its Start starts first. The map's order is the display order, and the start order where
// `dependsOn` leaves a tie. The processes derive the start/stop/restart actions and the
// running state, so they exclude the daemon-style commands that would configure a second
// way to run the stack.
const processName = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/u, 'process names are letters, digits, `_` and `-`');
const maxStackProcesses = 20;
const stackProcess = z.union([command, z.object({ command, dependsOn: z.array(processName).max(maxStackProcesses).optional() }).strict()]);
const stackProcesses = z.record(processName, stackProcess).refine(processes => Object.keys(processes).length >= 1, 'processes must declare a process').refine(processes => Object.keys(processes).length <= maxStackProcesses, `processes holds at most ${maxStackProcesses} processes`).superRefine((processes, context) => {
  // a `dependsOn` names another declared process; a cycle is only looked for once each does
  const declared = declaredProcesses({ processes });
  let allDeclared = true;
  for (const { name, dependsOn } of declared) {
    dependsOn.forEach((dependency, index) => {
      if (dependency !== name && Object.hasOwn(processes, dependency)) return;
      allDeclared = false;
      context.addIssue({ code: z.ZodIssueCode.custom, path: [name, 'dependsOn', index], message: dependency === name ? `\`${name}\` cannot depend on itself` : `\`${name}\` depends on \`${dependency}\`, which is not declared` });
    });
  }
  if (!allDeclared) return;
  const cycle = dependencyCycle(declared);
  if (cycle !== undefined) context.addIssue({ code: z.ZodIssueCode.custom, path: [cycle[0]!, 'dependsOn'], message: `processes depend on each other in a cycle: ${cycle.map(name => `\`${name}\``).join(' → ')}` });
});
const processDerivedCommands = ['start', 'stop', 'restart', 'status'] as const;
const stackCommands = z.object({ start: command.optional(), stop: command.optional(), build: command.optional(), restart: command.optional(), migrate: command.optional(), status: command.optional(), setup: command.optional(), processes: stackProcesses.optional() }).strict().superRefine((commands, context) => {
  if (commands.processes === undefined) return;
  for (const name of processDerivedCommands) {
    if (commands[name] !== undefined) context.addIssue({ code: z.ZodIssueCode.custom, path: [name], message: `\`${name}\` cannot be configured beside \`processes\`, which derives it` });
  }
});
// share preview validation across defaults and checkout overrides
const previewPort = z.number().int().min(1).max(65535);
const previewHostname = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/);
const previewExternalUrl = z.string();
// overrides select discovered checkouts rather than declaring new ones
const worktreeOverride = z.object({
  path: z.string().min(1).max(4096).refine(value => !value.includes('\0'), 'NUL is forbidden'),
  commands: stackCommands.optional(),
  externalUrl: previewExternalUrl.nullable().optional(),
  port: previewPort.nullable().optional(),
  hostname: previewHostname.nullable().optional()
}).strict();
const pushAction = z.object({ label: z.string().trim().min(1).max(80), prompt: command }).strict();
const defaultPushAction = { label: 'Commit/Push', prompt: 'review, commit, and push' } as const;
// accept branch names rather than options or revision expressions
const defaultBranch = z.string().min(1).max(255).refine(value => value !== 'HEAD' && (!value.startsWith('refs/') || value.startsWith('refs/heads/') || value.startsWith('refs/remotes/')) && !value.startsWith('-') && !value.includes('..') && !value.includes('@{') && !/[\s\u0000-\u001f\u007f~^:?*\[\\]/u.test(value) && value !== '@' && value.split('/').every(part => part !== '' && !part.startsWith('.') && !part.endsWith('.') && !part.endsWith('.lock')), 'invalid default branch');
const serverName = z.string().trim().min(1).max(80).refine(value => !value.includes('\0'), 'NUL is forbidden');
// One configured agent CLI. `program` is an absolute, real executable (not a
// version-manager shim that needs a shell); `args` and `env` are the operator's
// additions the console appends/merges. Values are never shell-expanded (the
// console shell-quotes them), so placeholders are literal; env is not for secrets.
const adapterProgram = z.string().min(1).max(4096).startsWith('/', 'adapter program must be an absolute path').refine(value => !value.includes('\0'), 'NUL is forbidden');
const adapterArgument = z.string().max(4096).refine(value => !value.includes('\0'), 'NUL is forbidden');
// the Conductor runs Pi, which must be enabled, on an Allowed model, in a directory Project; by
// default it gets every scope but `admin:dangerous`
function conductorConfig({ project, scopes, ...conductor }: z.output<typeof conductorSchema>, projects: readonly Project[], adapters: AdapterConfigs): ConductorConfig {
  const adapter = adapters[conductor.kind];
  if (adapter?.launchable !== true) throw new Error(`conductor: adapters.${conductor.kind} must be configured and launchable${adapter?.unavailableReason === undefined ? '' : ` (${adapter.unavailableReason})`}`);
  if (!(adapter.allowedModels ?? []).some(entry => entry.model === conductor.model)) throw new Error(`conductor: ${conductor.model} is not an Allowed model (adapters.${conductor.kind}.allowedModels)`);
  if (!projects.some(candidate => candidate.id === project && candidate.mode === 'directory' && candidate.available)) throw new Error(`conductor: ${project} must name a directory Project`);
  return { ...conductor, projectId: project, scopes: scopes ?? conductorScopes.filter(scope => scope !== 'admin:dangerous') };
}
const adapterEnvName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u, 'invalid environment variable name');
// reject whitespace-only update commands without normalizing meaningful bytes
const adapterUpdateCommand = command.refine(value => value.trim().length > 0, 'update command cannot be blank');
// version inspection and update commands are one all-or-nothing trusted shell contract
const adapterUpdates = z.object({ current: adapterUpdateCommand, latest: adapterUpdateCommand, run: adapterUpdateCommand }).strict();
// `setup`/`teardown` are operator-trust lifecycle commands (shell-interpreted, like a
// Project's stack commands): `setup` runs in the launched pane before the program and
// aborts the launch on failure; `teardown` runs best-effort after the console stops an
// agent of this kind, in the stopped agent's home.
const adapterEntry = z.object({ program: adapterProgram, args: z.array(adapterArgument).max(64).optional(), env: z.record(adapterEnvName, adapterArgument).optional(), setup: command.optional(), teardown: command.optional(), updates: adapterUpdates.optional() }).strict();
// Pi's Allowed models: exact `provider/id` entries in the operator's order (the first is the
// default), each with an optional default Effort; the only models a Pi Agent may run on
const allowedModels = z.array(z.object({ model: agentModel.refine(value => /^[^/[\]]+\/[^[\]]+$/u.test(value), 'an Allowed model is an exact `provider/id`, never a pattern'), effort: z.enum(piEfforts).optional() }).strict()).max(50)
  .refine(entries => new Set(entries.map(entry => entry.model)).size === entries.length, 'each Allowed model is listed once');
// What a Sandboxed Agent's commands may reach (ADR 0004), shared at the top level and per kind:
// domains in the sandbox runtime's grammar (`host`, `*.host`), absolute or `~/` paths, and the
// names of the extra environment variables commands get. Never a way to open Unix sockets.
const sandboxPath = z.string().min(1).max(4096).refine(value => (value.startsWith('/') || value === '~' || value.startsWith('~/')) && !value.includes('\0'), 'sandbox paths must be absolute or start with ~/');
const sandboxDomain = z.string().min(1).max(253).regex(/^[^\s/:@]+(?::\d{1,5})?$/u, 'a sandbox domain is a host name or pattern, not a URL');
const sandboxLists = z.object({ allowedDomains: z.array(sandboxDomain).max(256).optional(), deniedDomains: z.array(sandboxDomain).max(256).optional(), allowWrite: z.array(sandboxPath).max(256).optional(), denyWrite: z.array(sandboxPath).max(256).optional(), denyRead: z.array(sandboxPath).max(256).optional(), env: z.array(adapterEnvName).max(256).optional() }).strict();
// the console pins Pi and supplies its program (ADR 0017), so `adapters.pi` only enables the kind
const piEntry = adapterEntry.omit({ program: true, updates: true }).extend({ allowedModels: allowedModels.optional(), sandbox: sandboxLists.optional() }).strict('adapters.pi takes only args, env, setup, teardown, allowedModels and sandbox: Pi is pinned by the console as its own dependency, so it has no program or update commands');
// keyed by kind, one strict entry each; an omitted block is observe-only (nothing launches)
const adaptersSchema = z.object({ codex: adapterEntry.optional(), omx: adapterEntry.optional(), claude: adapterEntry.optional(), pi: piEntry.optional(), opencode: adapterEntry.optional() }).strict();
// constrain icons to supported aliases
const instanceIcon = z.enum(instanceIconNames);
const remoteServer = z.object({ url: z.string(), name: serverName.optional(), icon: instanceIcon.optional() }).strict();
const davoName = z.string().trim().min(1).max(80).refine(value => !value.includes('\0'), 'NUL is forbidden');
const davoContext = z.string().trim().max(16_000).refine(value => !value.includes('\0'), 'NUL is forbidden');
const davoSettingsSchema = z.object({ enabled: z.boolean(), name: davoName, context: davoContext }).strict();
// default every remote surface off
const integrationFeatures = z.object({
  enabled: z.boolean().default(false),
  mcp: z.object({ readEnabled: z.boolean().default(true), writeEnabled: z.boolean().default(false), dangerousEnabled: z.boolean().default(false) }).strict().default({}),
  realtime: z.object({ enabled: z.boolean().default(false), name: davoName.default(defaultDavoName), context: davoContext.default(defaultDavoContext), writeToolsEnabled: z.boolean().default(false) }).strict().default({}),
  // accept legacy input while runtime derives federation from configured remotes
  multiInstance: z.object({ enabled: z.boolean().default(false) }).strict().default({})
}).strict().default({});
// The Conductor (ADR 0018): one always-running Sandboxed Agent in a directory Project, with the
// console's MCP tools its scopes allow. Only Pi can host it so far.
const conductorSchema = z.object({
  kind: z.literal('pi'),
  project: z.string().min(1).max(80),
  model: agentModel,
  effort: z.enum(piEfforts).optional(),
  scopes: z.array(z.enum(conductorScopes)).max(conductorScopes.length).optional(),
  maxWorkers: z.number().int().min(1).max(16).default(4),
  maxSelfStartedTurnsPerHour: z.number().int().min(1).max(1_000).default(30),
  scriptDeadlineMinutes: z.number().int().min(1).max(120).default(10)
}).strict();
export const sourceSchema = z.object({
  listen: z.object({ host: z.string(), port: z.number().int().min(1).max(65535) }).strict().default({ host: '127.0.0.1', port: 8787 }),
  name: serverName.default('Remote Agents'),
  icon: instanceIcon.optional(),
  publicOrigin: z.string(),
  remoteServers: z.array(remoteServer).max(20).default([]),
  proxy: z.object({ trustedSourceIps: z.array(z.string()).default(['127.0.0.1', '::1']) }).strict().default({}),
  tmux: z.object({ pollIntervalMs: z.number().int().min(250).max(10000).default(500) }).strict().default({}),
  defaultAgent: z.enum(agentKinds).optional(),
  // where a Scratch (home) agent launches. An absolute path; defaults to the launch
  // account home (`$HOME`, or the host account home derived under the Docker bridge).
  // The account home the shell exports stays independent of it (launch/service.ts
  // agentHome), so this only moves the working directory, not HOME.
  scratchDirectory: z.string().min(1).max(4096).startsWith('/', 'scratchDirectory must be an absolute path').refine(value => !value.includes('\0'), 'NUL is forbidden').optional(),
  // the operator's editor, a shell command line (`/usr/bin/nvim`): when set, the Workspace
  // toolbar's Editor button opens a Console shell that runs it first
  editor: z.string().trim().min(1).max(4096).refine(value => !/[\0\r\n]/u.test(value), 'NUL and newlines are forbidden').optional(),
  // key tables over the built-in `root` and `prefix` (config/keys.ts validates them)
  keys: z.unknown().optional(),
  adapters: adaptersSchema.default({}),
  sandbox: sandboxLists.optional(),
  integrations: integrationFeatures,
  conductor: conductorSchema.optional(),
  googleCalendar: googleCalendarConfigSchema.default({}),
  // how the Review tour and the opt-in Code review run (ADR 0010); every field is optional
  review: reviewConfigSchema.optional(),
  buttons: applicationButtonsSchema,
  // a repository the console manages; its checkouts are discovered from git, never
  // declared. `path` is any checkout (a bare repository included); `hostPath` maps the
  // Main worktree's container path to the host under Docker; `worktreesDirectory` is
  // where Add creates new checkouts (default `../<basename>-worktrees`, resolved
  // against the Main worktree). `id` defaults to the derived id an implicit Project of the same
  // repository carries. Scratch-only first runs omit `projects`.
  projects: z.array(z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/).refine(value => value !== 'agent' && value !== 'scratch', 'project id `agent` and `scratch` are reserved').optional(), label: z.string().max(120).optional(), defaultBranch: defaultBranch.optional(), path: z.string().min(1), hostPath: z.string().startsWith('/').optional(), worktreeOrder: z.array(z.string().min(1).max(4096).refine(value => !value.includes('\0'), 'NUL is forbidden')).max(2000).optional(), worktreeOverrides: z.array(worktreeOverride).max(2000).optional(), worktreesDirectory: z.string().min(1).max(4096).refine(value => !value.includes('\0'), 'NUL is forbidden').optional(), externalUrl: previewExternalUrl.optional(), port: previewPort.optional(), hostname: previewHostname.optional(), commands: stackCommands.optional(), newTask: command.optional(), buttons: projectButtonsSchema.optional(), push: pushAction.optional() }).strict()).max(100).default([])
}).strict().superRefine((config, context) => {
  // include inherited presentations in the materialized dashboard safety bound
  if (countButtonDefinitions(config.buttons, config.projects.map(project => project.buttons)) > 4_096) context.addIssue({ code: z.ZodIssueCode.custom, path: ['buttons'], message: 'configuration expands to at most 4096 buttons' });
});
export type ConfigInput = z.input<typeof sourceSchema>;
export type RemoteServer = { url: URL; name?: string; icon?: InstanceIcon };
export type IntegrationConfig = z.output<typeof integrationFeatures>;
export type DavoSettings = z.output<typeof davoSettingsSchema>;
/** The Conductor as configured: its kind, directory Project, Allowed model and Effort, MCP scopes and limits. */
export type ConductorConfig = { kind: 'pi'; projectId: string; model: string; effort?: string; scopes: IntegrationScope[]; maxWorkers: number; maxSelfStartedTurnsPerHour: number; scriptDeadlineMinutes: number };
export type ValidatedConfig = { listen: { host: string; port: number }; name: string; icon?: InstanceIcon; publicOrigin: URL; remoteServers: RemoteServer[]; trustedProxyIps: Set<string>; pollIntervalMs: number; defaultAgent?: AgentKind; scratchDirectory?: string; editor?: string; keys?: KeysConfig; adapters: AdapterConfigs; integrations?: IntegrationConfig; conductor?: ConductorConfig; googleCalendar?: GoogleCalendarConfig; review: ResolvedReviewConfig; buttons?: ButtonSlots; projects: Project[] };
// how validation surfaces non-fatal facts: `warn` collects boot warnings (non-executable
// programs, a crossed OMX/Codex program); `checkExecutables` runs the boot X_OK probe
// and is skipped under the host bridge, where `program` is a host path the container
// cannot stat. Defaults: no-op warnings, probe on unless the host bridge is configured.
export type ValidateConfigOptions = { warn?: (message: string) => void; checkExecutables?: boolean };
// support legacy test fixtures
export const defaultIntegrationConfig: IntegrationConfig = integrationFeatures.parse(undefined);

// derive federation from configured peers, never the legacy authored switch
export function integrationConfigForRemotes(config: IntegrationConfig | undefined, remoteServers: readonly RemoteServer[]): IntegrationConfig {
  return { ...(config ?? defaultIntegrationConfig), multiInstance: { enabled: remoteServers.length > 0 } };
}

// parse one exact voice setting update
export function parseDavoSettings(value: unknown): DavoSettings | undefined {
  const parsed = davoSettingsSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

// the environment overrides of the kinds direct out-of-band services spawn
const programOverrides = { codex: 'RAC_CODEX_BIN', claude: 'RAC_CLAUDE_BIN' } as const;

// the binary direct out-of-band services spawn for a kind (headless Review runs, Codex's
// container-local launches and account management): its environment override, else the
// configured adapters.<kind> program
export function resolveAgentProgram(config: Pick<ValidatedConfig, 'adapters'>, kind: keyof typeof programOverrides, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[programOverrides[kind]] ?? config.adapters[kind]?.program;
}

// the resolved `review` section, defaulted for fixtures that predate it
export function reviewConfig(config: Pick<ValidatedConfig, 'adapters'> & { review?: ResolvedReviewConfig }): ResolvedReviewConfig {
  return config.review ?? resolveReviewConfig(undefined, config.adapters);
}

// require one canonical browser origin
function canonicalOrigin(value: string, label = 'publicOrigin', allowLoopbackHttp = false): URL {
  let url: URL;
  // reject malformed absolute origins
  try { url = new URL(value); } catch { throw new Error(`${label} must be an absolute URL`); }
  const localHttpHosts = new Set(['127.0.0.1', '[::1]', 'localhost']);
  const allowedLocalHttp = allowLoopbackHttp && url.protocol === 'http:' && localHttpHosts.has(url.hostname);
  // require HTTPS except for a direct loopback browser
  if (url.protocol !== 'https:' && !allowedLocalHttp) throw new Error(`${label} must use HTTPS or loopback HTTP`);
  // reject credentials and non-origin URL parts
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) throw new Error(`${label} must be a canonical origin only`);
  return url;
}
function validateNewTask(template: string): void {
  if (/\{(?!taskId\})/.test(template)) throw new Error('unknown new task placeholder');
}
type ParsedProject = z.output<typeof sourceSchema>['projects'][number];
type ParsedPreview = { externalUrl?: string | null; hostname?: string | null; port?: number | null };
type ResolvedPreview = Pick<Project, 'projectUrl' | 'projectPort'>;
// resolve one inherited, direct, proxied, or disabled preview mode
function resolvePreview(raw: ParsedPreview, label: string, inherited: ResolvedPreview = {}): ResolvedPreview {
  const hasExternalUrl = raw.externalUrl !== undefined;
  const hasHostname = raw.hostname !== undefined;
  const hasPort = raw.port !== undefined;
  // reject mixed direct and proxied modes
  if (hasExternalUrl && (hasHostname || hasPort)) throw new Error(`${label} must define externalUrl or hostname and port, not both`);
  // resolve an explicit direct mode or disablement
  if (raw.externalUrl !== undefined) return raw.externalUrl === null ? {} : { projectUrl: canonicalOrigin(raw.externalUrl, `${label} externalUrl`).origin };
  // inherit the entire preview mode when no fields are present
  if (!hasHostname && !hasPort) return inherited;
  // reject partial proxied modes
  if (!hasHostname || !hasPort) throw new Error(`${label} must define both port and hostname`);
  // resolve an explicit proxied disablement
  if (raw.hostname === null && raw.port === null) return {};
  // reject mixed null and concrete proxy fields
  if (raw.hostname === null || raw.port === null) throw new Error(`${label} must define both port and hostname or set both to null`);
  return { projectUrl: `https://${raw.hostname}`, projectPort: raw.port };
}
// resolve complete settings once for exact checkout matching during discovery
async function resolveWorktreeOverrides(raw: ParsedProject, name: string, projectPreview: ResolvedPreview): Promise<WorktreeOverride[] | undefined> {
  // preserve configurations without checkout overrides
  if (raw.worktreeOverrides === undefined) return undefined;
  const overrides: WorktreeOverride[] = [];
  const paths = new Set<string>();
  // canonicalize each selector and preserve explicit disablement
  for (const override of raw.worktreeOverrides) {
    const absolute = resolve(raw.path, override.path);
    const path = await realpath(absolute).catch(() => absolute);
    // aliases must not create conflicting settings for one checkout
    if (paths.has(path)) throw new Error(`project ${name} has duplicate worktree override path ${path}`);
    paths.add(path);
    const commands = override.commands ?? raw.commands;
    const preview = resolvePreview(override, `project ${name} worktree override ${override.path}`, projectPreview);
    overrides.push({
      path,
      ...(commands === undefined ? {} : { commands }),
      ...preview
    });
  }
  return overrides;
}
// where Add creates new Worktrees: an absolute `worktreesDirectory` as given, a relative
// one against the Main worktree (the bare repository's parent when there is none), and
// the default a `<basename>-worktrees` sibling of the Main worktree (ADR 0003).
function resolveWorktreesDirectory(configured: string | undefined, mainWorktree: string | undefined, identity: string): string {
  const relativeBase = mainWorktree ?? dirname(identity);
  if (configured !== undefined) return isAbsolute(configured) ? resolve(configured) : resolve(relativeBase, configured);
  const anchor = mainWorktree ?? identity;
  return resolve(dirname(anchor), `${basename(anchor)}-worktrees`);
}
// The name a Project with no `id` or `label` goes by, read from its identity alone so adding or
// removing a checkout never changes it: `<repo>/.git` → `repo`, a bare `repo.git` → `repo`, a
// directory → its own name
function identityName(identity: string): string {
  const folder = basename(identity) === '.git' ? dirname(identity) : identity;
  return basename(folder).replace(/\.git$/, '') || folder;
}
// The id of a Project configured without one, and of an implicit Project: a slug of its name and
// 8 hex of its identity's hash. Both derive it the same way, so a config entry with no `id` added
// later for an implicit Project's repository keeps the id its Notes, pins and launch profile are
// keyed by.
export function derivedProjectId(identity: string): string {
  const slug = identityName(identity).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'project';
  return `${slug}-${createHash('sha256').update(identity).digest('hex').slice(0, 8)}`;
}
// resolve one configured Project. A git checkout canonicalises to its common git
// directory identity and resolves a Worktrees directory (`repository` mode). A path that
// exists but is not a git checkout loads as an available `directory` Project — an agent
// launches directly in it, like Scratch, with no Worktrees — keyed by its own realpath.
// Only a path that does not resolve at all loads unavailable with a reason, rather than
// failing the whole boot (ADR 0003); with no `id` to key it by, it does not load at all.
async function resolveProject(raw: ParsedProject): Promise<Project | undefined> {
  const errorLabel = raw.id ?? raw.path;
  if (raw.newTask !== undefined) validateNewTask(raw.newTask);
  const preview = resolvePreview(raw, `project ${errorLabel}`);
  const worktreeOverrides = await resolveWorktreeOverrides(raw, errorLabel, preview);
  // canonical checkout paths keep ordering independent of labels and branches
  const worktreeOrder = raw.worktreeOrder === undefined ? undefined : await Promise.all(raw.worktreeOrder.map(async path => {
    const absolute = resolve(raw.path, path);
    return await realpath(absolute).catch(() => absolute);
  }));
  // a blank host override inherits path only when launches run through the host bridge
  const hostPath = raw.hostPath ?? (process.env.RAC_HOST_TMUX_DIR === undefined ? undefined : raw.path);
  const optional = {
    ...(worktreeOverrides === undefined ? {} : { worktreeOverrides }),
    ...(worktreeOrder === undefined ? {} : { worktreeOrder }),
    ...(raw.commands === undefined ? {} : { commands: raw.commands satisfies StackCommands }),
    ...(raw.newTask === undefined ? {} : { newTask: raw.newTask }),
    ...(raw.defaultBranch === undefined ? {} : { defaultBranch: raw.defaultBranch }),
    ...(raw.buttons === undefined ? {} : { buttons: raw.buttons }),
    push: raw.push ?? defaultPushAction,
    ...(hostPath === undefined ? {} : { hostPath: resolve(hostPath) }),
    ...preview
  };
  const canonical = await realpath(raw.path).catch(() => undefined);
  // a path that does not resolve is unavailable: there is no directory to launch into
  if (canonical === undefined) {
    if (raw.id === undefined) return undefined;
    const base = resolve(raw.path);
    return { id: raw.id, label: raw.label ?? raw.id, path: base, identity: base, mode: 'repository', available: false, unavailableReason: `path ${raw.path} was not found`, worktreesDirectory: resolveWorktreesDirectory(raw.worktreesDirectory, undefined, base), ...optional };
  }
  const identity = await gitCommonDir(canonical);
  // a real directory that is not a git checkout is an available `directory` Project: an
  // agent launches directly in it (no Worktrees), so its identity is just its own path
  if (identity === undefined) {
    return { id: raw.id ?? derivedProjectId(canonical), label: raw.label ?? raw.id ?? identityName(canonical), path: canonical, identity: canonical, mode: 'directory', available: true, worktreesDirectory: resolveWorktreesDirectory(raw.worktreesDirectory, undefined, canonical), ...optional };
  }
  // git lists the Main worktree first; a bare repository has none
  const entries = await listWorktrees(canonical);
  const mainEntry = entries?.find(entry => !entry.bare);
  const mainWorktree = mainEntry === undefined ? undefined : await realpath(mainEntry.path).catch(() => mainEntry.path);
  return { id: raw.id ?? derivedProjectId(identity), label: raw.label ?? raw.id ?? identityName(identity), path: canonical, identity, mode: 'repository', available: true, worktreesDirectory: resolveWorktreesDirectory(raw.worktreesDirectory, mainWorktree, identity), ...optional };
}
// The implicit Project of an unconfigured git checkout: the Project a config entry naming only
// its path would load, marked implicit. Undefined when the folder is gone or not a git checkout.
export async function implicitProject(checkout: string): Promise<Project | undefined> {
  const project = await resolveProject({ path: checkout });
  return project?.mode === 'repository' ? { ...project, implicit: true } : undefined;
}
// the console now declares repositories as `projects[]`; a config that still carries the
// retired `worktrees[]` key is refused with a pointer to the migration rather than a bare
// "unrecognized key" from the strict schema.
function refuseLegacyWorktrees(input: unknown): void {
  if (input !== null && typeof input === 'object' && !Array.isArray(input) && 'worktrees' in (input as Record<string, unknown>)) {
    throw new Error('configuration declares the retired `worktrees[]` key; the console now declares `projects[]` (a repository whose Worktrees are discovered from git). The automatic config-and-data migration converts it — see the Projects migration in docs/setup.md');
  }
}
// let RAC_LISTEN_HOST / RAC_LISTEN_PORT in the environment override the file's listen block
export function applyListenOverrides(input: unknown, env: Record<string, string | undefined>): unknown {
  const host = env.RAC_LISTEN_HOST?.trim(); const port = env.RAC_LISTEN_PORT?.trim();
  if (!host && !port) return input;
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return input;
  const source = input as Record<string, unknown>;
  const current = typeof source.listen === 'object' && source.listen !== null ? source.listen as Record<string, unknown> : {};
  const listen: Record<string, unknown> = { host: current.host ?? '127.0.0.1', port: current.port ?? 8787 };
  if (host) listen.host = host;
  if (port) { if (!/^\d{1,5}$/.test(port)) throw new Error('RAC_LISTEN_PORT must be an integer'); listen.port = Number(port); }
  return { ...source, listen };
}
type ParsedAdapters = z.output<typeof adaptersSchema>;
// resolve each configured adapter program: normalise args/env, probe executability
// (unless bridged), and warn about operator arguments the Adapter reserves.
async function resolveAdapters(parsed: ParsedAdapters, checkExecutables: boolean, warn: (message: string) => void, sandbox?: z.output<typeof sandboxLists>): Promise<AdapterConfigs> {
  const configs: AdapterConfigs = {};
  if (parsed.pi !== undefined) configs.pi = piConfig(parsed.pi, warn, sandbox);
  for (const kind of agentKinds) {
    const entry = kind === 'pi' ? undefined : parsed[kind] as z.output<typeof adapterEntry> | undefined;
    if (entry === undefined) continue;
    const config: AdapterLaunchConfig = { program: entry.program, args: entry.args ?? [], env: entry.env ?? {}, launchable: true, ...(entry.setup === undefined ? {} : { setup: entry.setup }), ...(entry.teardown === undefined ? {} : { teardown: entry.teardown }), ...(entry.updates === undefined ? {} : { updates: entry.updates }) };
    // a missing program, a directory, or a non-executable file never refuses boot;
    // it disables that kind with a reason (a directory is +x, so require a real file)
    if (checkExecutables) {
      const executable = await stat(entry.program).then(info => info.isFile()).catch(() => false)
        && await access(entry.program, constants.X_OK).then(() => true).catch(() => false);
      if (!executable) {
        config.launchable = false;
        config.unavailableReason = `${entry.program} is not an executable file`;
        warn(`adapters.${kind}: ${config.unavailableReason}`);
      }
    }
    // an Adapter reserves the arguments it composes itself; a reserved operator
    // argument is dropped with a warning so it never doubles the composed launch.
    // A reserved flag takes its attached value with it (the following token, unless
    // that token is itself a flag), so a stray value never lands as a launch
    // positional. Codex reserves none.
    const reserved = adapterFor(kind)?.conflictingArgs;
    if (reserved !== undefined && reserved.length > 0) {
      const kept: string[] = [];
      const dropped: string[] = [];
      for (let index = 0; index < config.args.length; index += 1) {
        const argument = config.args[index]!;
        if (!reserved.includes(argument)) { kept.push(argument); continue; }
        dropped.push(argument);
        // consume the flag's attached value; a following flag is a separate argument
        const value = config.args[index + 1];
        if (value !== undefined && !value.startsWith('-')) index += 1;
      }
      if (dropped.length > 0) {
        config.args = kept;
        warn(`adapters.${kind}: ignoring reserved argument${dropped.length === 1 ? '' : 's'} ${dropped.join(', ')}`);
      }
    }
    // an Adapter that renders host-path files (Claude's hooks) needs a host-visible
    // checkout root; under the bridge without RAC_HOST_REPOSITORY the injected paths
    // would be wrong, so the kind cannot launch. Off the bridge the console's own
    // checkout always resolves, so this only ever fires under the bridge.
    if (config.launchable && adapterFor(kind)?.files !== undefined && hostVisibleRepoRoot() === undefined) {
      config.launchable = false;
      config.unavailableReason = 'the host bridge needs RAC_HOST_REPOSITORY set to the host checkout path';
      warn(`adapters.${kind}: ${config.unavailableReason}`);
    }
    configs[kind] = config;
  }
  warnCrossedPrograms(parsed, warn);
  return configs;
}
// Pi runs the console's own pinned copy under the console's own Node (the Pi Adapter names the
// CLI), which only a console driving the host's tmux directly can start: the host bridge's tmux
// runs on the host, where the container's copy is not
function piConfig(entry: NonNullable<ParsedAdapters['pi']>, warn: (message: string) => void, shared?: z.output<typeof sandboxLists>): AdapterLaunchConfig {
  const config: AdapterLaunchConfig = { program: process.execPath, args: entry.args ?? [], env: entry.env ?? {}, launchable: true, ...(entry.setup === undefined ? {} : { setup: entry.setup }), ...(entry.teardown === undefined ? {} : { teardown: entry.teardown }), ...(entry.allowedModels === undefined || entry.allowedModels.length === 0 ? {} : { allowedModels: entry.allowedModels }), sandbox: sandboxSettings(shared, entry.sandbox) };
  if (process.env.RAC_HOST_TMUX_DIR === undefined) return config;
  config.launchable = false;
  config.unavailableReason = 'Pi cannot launch under the host bridge: the console runs its pinned Pi itself';
  warn(`adapters.pi: ${config.unavailableReason}`);
  return config;
}
// a kind's sandbox settings: the shared lists, then the kind's own, each without repeats
function sandboxSettings(shared: z.output<typeof sandboxLists> = {}, own: z.output<typeof sandboxLists> = {}): SandboxSettings {
  const list = (key: Exclude<keyof SandboxSettings, 'repositories'>) => [...new Set([...shared[key] ?? [], ...own[key] ?? []])];
  return { allowedDomains: list('allowedDomains'), deniedDomains: list('deniedDomains'), allowWrite: list('allowWrite'), denyWrite: list('denyWrite'), denyRead: list('denyRead'), env: list('env') };
}
// OMX was once launched through `adapters.codex` (one kind recognised both). Now that
// OMX is its own kind (ADR 0005), a Codex entry whose program is OMX — or an OMX entry
// whose program is plain Codex — still launches, but is recognised, badged and torn
// down as the wrong kind; say so at boot rather than leaving the mismatch to the UI.
function warnCrossedPrograms(parsed: ParsedAdapters, warn: (message: string) => void): void {
  if (parsed.codex !== undefined && omxProgramName.test(basename(parsed.codex.program))) warn('adapters.codex.program looks like OMX; configure it under adapters.omx so it is recognised, badged and torn down as OMX');
  if (parsed.omx !== undefined && codexProgramName.test(basename(parsed.omx.program))) warn('adapters.omx.program looks like plain Codex; configure it under adapters.codex so it is recognised, badged and torn down as Codex');
}
// validate and canonicalize console configuration
export async function validateConfig(input: unknown, options: ValidateConfigOptions = {}): Promise<ValidatedConfig> {
  refuseLegacyWorktrees(input);
  const parsed = sourceSchema.parse(input);
  const warn = options.warn ?? (() => {});
  // the host bridge cannot stat host program paths from inside the container
  const checkExecutables = options.checkExecutables ?? process.env.RAC_HOST_TMUX_DIR === undefined;
  const adapters = await resolveAdapters(parsed.adapters, checkExecutables, warn, parsed.sandbox);
  const review = resolveReviewConfig(parsed.review, parsed.adapters);
  const keys = parsed.keys === undefined ? undefined : parseKeysConfig(parsed.keys);
  if (isIP(parsed.listen.host) === 0) throw new Error('listener host must be an IP address literal');
  if (wildcard.has(parsed.listen.host)) throw new Error('listener must bind to a specific address, not a wildcard');
  if (parsed.proxy.trustedSourceIps.some((ip) => !loopback.has(ip))) throw new Error('only loopback proxy sources are permitted');
  const publicOrigin = canonicalOrigin(parsed.publicOrigin, 'publicOrigin', true);
  // retain canonical remote origins and optional local identity overrides
  const remoteServers = parsed.remoteServers.map(server => ({ url: canonicalOrigin(server.url, 'remote server'), ...(server.name === undefined ? {} : { name: server.name }), ...(server.icon === undefined ? {} : { icon: server.icon }) }));
  const serverUrls = new Set([publicOrigin.origin]);
  // reject duplicate server switch targets
  for (const server of remoteServers) {
    if (serverUrls.has(server.url.origin)) throw new Error('remote server URLs must be unique');
    serverUrls.add(server.url.origin);
  }
  const projects: Project[] = []; const ids = new Set<string>(); const identities = new Set<string>();
  for (const raw of parsed.projects) {
    const project = await resolveProject(raw);
    // with no `id` to key its state by, a Project whose path is missing does not load
    if (project === undefined) { warn(`projects: ${raw.path} was not found, and a Project with no id needs its path to derive one`); continue; }
    if (ids.has(project.id)) throw new Error('duplicate project id'); ids.add(project.id);
    // a missing or non-git checkout loads unavailable with a boot warning, never a crash
    if (!project.available) warn(`projects.${project.id}: ${project.unavailableReason}`);
    // two Projects that resolve to the same repository split state between them; refuse it.
    // Only available Projects have a real identity — an unmounted one never collides
    else { if (identities.has(project.identity)) throw new Error('duplicate project identity'); identities.add(project.identity); }
    projects.push(project);
  }
  const conductor = parsed.conductor === undefined ? undefined : conductorConfig(parsed.conductor, projects, adapters);
  return { listen: { host: parsed.listen.host, port: parsed.listen.port }, name: parsed.name, ...(parsed.icon === undefined ? {} : { icon: parsed.icon }), publicOrigin, remoteServers, trustedProxyIps: new Set(parsed.proxy.trustedSourceIps), pollIntervalMs: parsed.tmux.pollIntervalMs, ...(parsed.defaultAgent === undefined ? {} : { defaultAgent: parsed.defaultAgent }), ...(parsed.scratchDirectory === undefined ? {} : { scratchDirectory: resolve(parsed.scratchDirectory) }), ...(parsed.editor === undefined ? {} : { editor: parsed.editor }), ...(keys === undefined ? {} : { keys }), adapters, integrations: integrationConfigForRemotes(parsed.integrations, remoteServers), ...(conductor === undefined ? {} : { conductor }), googleCalendar: parsed.googleCalendar, review, buttons: parsed.buttons, projects };
}
