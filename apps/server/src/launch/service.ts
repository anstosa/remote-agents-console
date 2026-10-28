import { mkdir, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { resolveAgentProgram, type ValidatedConfig } from '../config/schema.js';
import { run, tmuxFormatLiteral, tmuxLiteralArg } from '../tmux/command.js';
import { TmuxAdapter } from '../tmux/adapter.js';
import { hostCommand, hostInteractiveShellPath, interactiveShellBootstrap, interactiveShellName, interactiveShellPath } from '../tmux/interactive-shell.js';
import { availableSessionName, worktreeSessionName } from '../tmux/session-name.js';
import { terminalColorFallbackArgv } from '../tmux/terminal-colors.js';
import { processPaneRole } from '../tmux/stack-sessions.js';
import { ProcSocketFinder, workspaceRoot, type SocketFinder } from '../discovery/service.js';
import { projectIdOf, worktreeHostRoot, worktreeMatchesWorkspace } from '../workspaces/resolver.js';
import { adapterCapabilities, adapterFor } from '../adapters/registry.js';
import { renderAdapterFiles, type RenderedAdapterFiles } from '../adapters/files.js';
import { agentKinds, type AgentKind, type LaunchInput, type LaunchMode, type ReplacedFlagValue } from '../adapters/types.js';
import { resolveLaunchProfile, type LaunchResolution, type LaunchScope } from './resolution.js';
import { WorktreeLaunchStore, scratchLaunchKey } from '../worktrees/store.js';
import type { Pane, SocketRef, Worktree } from '../domain/models.js';
import { updateAdvisorPendingLabel } from '../update-advisor.js';
import { isFullGitSha } from '../git/revision.js';
import { accountHome, configuredPlaces, placeHostRoot, scratchHome, scratchPlaceLabel, scratchProjectId, worktreePlace, type Place } from '../places/places.js';

export function expandCommand(command: string, worktree: Pick<Worktree, 'identity'>): string {
  const directory = `'${worktree.identity.replaceAll("'", "'\\''")}'`;
  const script = `'${command.replaceAll("'", "'\\''")}'`;
  return `cd -- ${directory} && eval ${script}`;
}

// shell-quote an argument only when it holds a character the shell would act on;
// the Adapter's plain flags (`resume`, `--last`) and validated ids stay legible.
const shellQuote = (value: string) => /^[A-Za-z0-9_@%+=:,./-]+$/u.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;

// Compose the inner shell command the console runs: the configured program
// string followed by the Adapter's mode arguments. Fresh launches append
// nothing, so the operator's `command` runs exactly as before.
export function composeCommand(program: string, args: string[]): string {
  return args.length === 0 ? program : `${program} ${args.map(shellQuote).join(' ')}`;
}

// Compose a configured Adapter launch: [program, …adapter args, …operator args]
// with the Adapter's environment overlaid by the operator's, rendered as a
// shell-quoted assignment prefix. The program, args, and env are all quoted, so
// nothing in them expands. A configured `setup` command is the one deliberately
// raw part — operator-trust shell (like a Project's stack commands) — run in the
// launched pane before the program, in the launch cwd. It is wrapped in its own
// `eval '<setup>'` so it is a single command whose exit status gates the program
// through `&&`: a non-zero setup stops the agent from ever starting, and a
// compound setup (`a || b`, `a; b`, a multi-line command) cannot re-associate the
// `&&` and silently launch or skip the program. `extraArgs` are one launch's own
// arguments (a Review run's read-only flags), placed last.
export function composeLaunch(program: string, adapterArgs: string[], operatorArgs: string[], adapterEnv: Record<string, string> = {}, operatorEnv: Record<string, string> = {}, setup?: string, extraArgs: string[] = []): string {
  const env = { ...adapterEnv, ...operatorEnv };
  const prefix = Object.entries(env).map(([name, value]) => `${name}=${shellQuote(value)}`).join(' ');
  const command = composeCommand(shellQuote(program), [...adapterArgs, ...operatorArgs, ...extraArgs]);
  const launch = prefix === '' ? command : `${prefix} ${command}`;
  return setup === undefined ? launch : `eval ${shellQuote(setup)} && ${launch}`;
}

// One Review run's launch (ADR 0010): its id, which marks the pane `@rac_review_run`, the
// label the Agent's tab reads as, the run's own arguments (placed last), the operator flags
// those replace or that would loosen the run's read-only policy, and the conversation it resumes
// through the Adapter's own resume launch, when it is not a new one.
export type ReviewRunLaunch = { runId: string; label: string; extraArgs: string[]; replacedFlags: ReadonlyMap<string, ReplacedFlagValue>; conversationId?: string };
// a Review run id: the random token the pane mark carries
const reviewRunIdPattern = /^[A-Za-z0-9_-]{8,64}$/u;

// Drop the replaced flags from the operator's arguments, each with its value (a following
// token that is not itself a flag, or an attached `--flag=value`/`-fvalue`), so a run's own flag
// never doubles an operator one: Codex refuses a repeated `--sandbox` or `--model`.
export function withoutFlags(args: string[], flags: ReadonlyMap<string, ReplacedFlagValue>): string[] {
  const kept: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    const attached = argument.startsWith('--') && argument.includes('=');
    // short value options also accept -fvalue and -f=value
    const attachedShort = /^-[^-].+/u.test(argument) && flags.get(argument.slice(0, 2)) === 'one';
    const value = flags.get(attached ? argument.slice(0, argument.indexOf('=')) : attachedShort ? argument.slice(0, 2) : argument);
    if (value === undefined) { kept.push(argument); continue; }
    // an attached value or a bare switch takes nothing more
    if (attached || attachedShort || value === 'none') continue;
    // consume the value token(s); a following flag is a separate argument
    while (index + 1 < args.length && !args[index + 1]!.startsWith('-')) { index += 1; if (value === 'one') break; }
  }
  return kept;
}

// what a Console shell needs of its Place: membership, where it starts and whose HOME it exports
export type ConsoleShellPlace = Pick<Place, 'id' | 'kind' | 'projectId' | 'home' | 'hostPath'>;

// one worktree launch request: which conversation (if any) and whether to confine it
type LaunchRequest = { mode: LaunchMode; conversationId?: string; sandboxed: boolean };

// one tmux session on its socket: the session a launch or a Console shell at a Place joins
export type TmuxSession = { socket: SocketRef; session: string };

// where a launch runs: the folder tmux opens it in (the host-visible one under the bridge) and
// the HOME its shell exports (`$HOME` leaves a local shell's own)
type LaunchSite = { cwd: string; home: string };

export function expandHomeCommand(command: string, home: string): string {
  return expandCommand(command, { identity: home });
}

export const scratchLabel = scratchPlaceLabel;

// The session a directory-Project or Scratch Place's launches and Console shells start in, named
// for its folder. tmux turns `.` into `_` in a session name, so the name is written that way up
// front and the free-name check compares what tmux will actually list.
const placeSessionName = (place: Pick<Place, 'home' | 'hostPath'>): string => worktreeSessionName(placeHostRoot(place)).replaceAll('.', '_');
// allow approved host repairs without running hooks or blocking on their trust dialog
const updateAdvisorArgs = ['--dangerously-bypass-approvals-and-sandbox', '--no-alt-screen', '--disable', 'hooks'];
// preserve account options while keeping the advisor's policy and fixed checkout
const updateAdvisorReplacedFlags = new Map<string, ReplacedFlagValue>([
  ['-s', 'one'], ['--sandbox', 'one'], ['-a', 'one'], ['--ask-for-approval', 'one'],
  ['--dangerously-bypass-approvals-and-sandbox', 'none'], ['--yolo', 'none'],
  ['--full-auto', 'none'], ['--approve-for-me', 'none'], ['--no-alt-screen', 'none'],
  ['-C', 'one'], ['--cd', 'one'], ['--worktree', 'none']
]);

export class LaunchService {
  private pending = new Set<string>();
  // the configured Scratch folder's realpath, resolved once
  private scratchHomeValue?: Promise<string>;
  private readonly tmux = process.env.RAC_TMUX_BIN ?? '/usr/bin/tmux'; private readonly hostSocket = process.env.RAC_HOST_TMUX_DIR === undefined ? undefined : join(process.env.RAC_HOST_TMUX_DIR, 'default');
  private readonly localShell = interactiveShellPath();
  private readonly localShellName = interactiveShellName(this.localShell);
  private readonly hostShell = hostInteractiveShellPath();
  private readonly hostShellName = interactiveShellName(this.hostShell);
  // the login shell basename a Console shell reports when idle, for the busy check on End
  private get shellName(): string { return this.hostSocket === undefined ? this.localShellName : this.hostShellName; }
  // `root` (where launch descriptors are written for the local runner path) is a test seam.
  // `openTerminals` returns the `fingerprint\0paneId` keys of panes a browser currently has
  // open as a Terminal (a live pane-socket subscriber); Remove's blind kill skips them.
  // `placeAgentSession` finds the session of a live Agent at a Place, which a Place launch joins.
  constructor(private readonly config: ValidatedConfig, private readonly finder: SocketFinder = new ProcSocketFinder(), private readonly panes: TmuxAdapter = new TmuxAdapter(), private readonly paneRoot: (path: string) => Promise<string> = workspaceRoot, private readonly worktreeStore: WorktreeLaunchStore = new WorktreeLaunchStore(), private readonly discoveredWorktrees: () => Worktree[] = () => [], private readonly openTerminals: () => ReadonlySet<string> = () => new Set(), private readonly placeAgentSession: (placeId: string) => Promise<TmuxSession | undefined> = async () => undefined, private readonly root = `/tmp/remote-agent-console-${process.getuid?.() ?? 0}`) {}

  // a pane the operator currently has open as a Terminal (a live pane-socket subscriber)
  private paneHasOpenTerminal(pane: Pane): boolean {
    return this.openTerminals().has(`${pane.socket.fingerprint}\0${pane.paneId}`);
  }

  // one discovered Worktree by its wire id `<projectId>:<realpath>`
  private worktreeById(worktreeId: string): Worktree | undefined {
    return this.discoveredWorktrees().find(candidate => candidate.id === worktreeId);
  }

  // the Codex binary in the environment where the update advisor actually runs
  codexProgram(): string | undefined {
    const hostProgram = process.env.RAC_HOST_CODEX_BIN?.trim();
    // host tmux cannot execute a container-only RAC_CODEX_BIN path
    if (this.hostSocket !== undefined) return hostProgram || this.config.adapters.codex?.program;
    return resolveAgentProgram(this.config, 'codex');
  }

  private adapterFilesPromise: Promise<RenderedAdapterFiles> | undefined;
  // This kind's rendered console-owned files for `LaunchInput.files`, or `undefined`
  // when the kind declares none (Codex) — which keeps the
  // launch hot path off the filesystem. Only a *successful* render is memoized; a
  // transient failure is logged, degrades this launch to no files (it omits
  // `--settings`) rather than failing, and clears the memo so the next launch retries.
  private async adapterFiles(kind: AgentKind): Promise<Record<string, string> | undefined> {
    if (adapterFor(kind)?.files === undefined) return undefined;
    this.adapterFilesPromise ??= renderAdapterFiles().catch(error => {
      this.adapterFilesPromise = undefined;
      console.error('[launch] adapter files not rendered:', error instanceof Error ? error.message : 'unknown error');
      return {} as RenderedAdapterFiles;
    });
    return (await this.adapterFilesPromise)[kind];
  }

  // the launchable kinds in registry (resolution) order for the current configuration
  private launchableKinds(): AgentKind[] {
    return agentKinds.filter(kind => (this.config.adapters[kind]?.launchable ?? false) && adapterFor(kind) !== undefined);
  }

  // expose the effective server default, falling back when its configured kind is unavailable
  defaultAgent(): AgentKind | undefined {
    const launchable = this.launchableKinds();
    return this.config.defaultAgent !== undefined && launchable.includes(this.config.defaultAgent) ? this.config.defaultAgent : launchable[0];
  }

  // accept settings choices only for kinds this server can launch now
  isLaunchableKind(kind: AgentKind): boolean {
    return this.launchableKinds().includes(kind);
  }

  // resolve which kind a launch uses: an explicit request must be launchable; otherwise
  // the same precedence the dashboard displays, so the launched kind never diverges from
  // the one the Launch button named (an unreadable store falls back to the first launchable)
  async resolveLaunchKind(scopeKey: string, requested?: AgentKind): Promise<AgentKind | undefined> {
    const kinds = this.launchableKinds();
    if (kinds.length === 0) return undefined;
    if (requested !== undefined) return kinds.includes(requested) ? requested : undefined;
    // a single launchable kind is always the answer; skip the store read on the hot path
    if (kinds.length === 1) return kinds[0];
    const remembered = await this.worktreeStore.launchProfiles().catch(() => ({} as Record<string, AgentKind | undefined>));
    return resolveLaunchProfile(kinds, this.rememberedChain(scopeKey, remembered), adapterCapabilities(this.config.adapters), this.defaultAgent()).kind;
  }

  // the remembered-kind precedence for one scope: a Worktree's own last-used kind, then
  // its Project's (which seeds a fresh Worktree), then registry order; Scratch stands alone,
  // and a Scratch Place (`scratch:<root>`) falls back to the Scratch group, both in the scratch scope
  private rememberedChain(key: string, remembered: Record<string, AgentKind | undefined>): Array<{ origin: LaunchScope; kind?: AgentKind }> {
    if (key === scratchLaunchKey) return [{ origin: 'scratch', kind: remembered[key] }];
    const projectId = projectIdOf(key);
    if (projectId === scratchProjectId) return [{ origin: 'scratch', kind: remembered[key] }, { origin: 'scratch', kind: remembered[scratchLaunchKey] }];
    // a bare `<projectId>` key resolves in the project scope; a worktree key falls back to it
    if (projectId === key) return [{ origin: 'project', kind: remembered[key] }];
    return [{ origin: 'worktree', kind: remembered[key] }, { origin: 'project', kind: remembered[projectId] }];
  }

  // The Launch profile resolution the dashboard publishes for each scope so the web
  // renders the Launch menu without re-deriving it. Reads the whole launch-profile
  // store once; `scratchLaunchKey` resolves in the scratch scope, every other key in
  // the worktree scope (chunk 3 adds the project scope). Missing scopes are omitted.
  async launchResolutions(scopeKeys: Iterable<string>): Promise<Map<string, LaunchResolution>> {
    const launchable = this.launchableKinds();
    const capabilities = adapterCapabilities(this.config.adapters);
    const remembered = await this.worktreeStore.launchProfiles().catch(() => ({} as Record<string, AgentKind | undefined>));
    const resolutions = new Map<string, LaunchResolution>();
    for (const key of new Set(scopeKeys)) resolutions.set(key, resolveLaunchProfile(launchable, this.rememberedChain(key, remembered), capabilities, this.defaultAgent()));
    return resolutions;
  }

  // Compose the inner shell command for a launch of `kind`: [program, …adapter args,
  // …operator args] from the kind's configured entry, then a Review run's own arguments
  // with the operator flags they replace dropped. A kind with no entry cannot launch.
  private composeKindLaunch(kind: AgentKind, input: LaunchInput, review?: ReviewRunLaunch): string | undefined {
    const adapter = adapterFor(kind);
    const configured = this.config.adapters[kind];
    if (adapter === undefined || configured === undefined) return undefined;
    const spec = adapter.launch(input);
    const operatorArgs = review === undefined ? configured.args : withoutFlags(configured.args, review.replacedFlags);
    return composeLaunch(configured.program, spec.args, operatorArgs, spec.env, configured.env, configured.setup, review?.extraArgs);
  }

  // the inner command for a worktree launch
  private async worktreeCommand(worktree: Worktree, kind: AgentKind, input: LaunchRequest): Promise<string | undefined> {
    const files = await this.adapterFiles(kind);
    return this.composeKindLaunch(kind, { mode: input.mode, ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }), cwd: worktree.identity, sandboxed: input.sandboxed, ...(files === undefined ? {} : { files }) });
  }

  // the inner command for a scratch launch
  private async scratchCommand(kind: AgentKind, cwd: string): Promise<string | undefined> {
    const files = await this.adapterFiles(kind);
    return this.composeKindLaunch(kind, { mode: 'fresh', cwd, sandboxed: false, ...(files === undefined ? {} : { files }) });
  }

  // resolve the authenticated account home independently from the launch directory
  agentHome(projectId?: string): string {
    return accountHome(this.config.projects, projectId);
  }

  // every configured Place over the current Worktree snapshot
  private async places(): Promise<Place[]> {
    this.scratchHomeValue ??= scratchHome(this.config.scratchDirectory, this.config.projects);
    return configuredPlaces(this.discoveredWorktrees(), this.config.projects, await this.scratchHomeValue);
  }

  // the configured Scratch folder's Place, which a Scratch launch joins
  async scratchPlace(): Promise<Place> {
    const place = (await this.places()).find(candidate => candidate.kind === 'scratch');
    // configuredPlaces always lists the configured Scratch folder
    if (place === undefined) throw new Error('no configured Scratch Place');
    return place;
  }

  // the Place of an available directory Project, which its in-place launch joins
  async directoryPlace(projectId: string): Promise<Place | undefined> {
    return (await this.places()).find(candidate => candidate.kind === 'directory' && candidate.projectId === projectId);
  }

  // an idle login shell Remove may close: never a transient stack-command pane, a pane with
  // a console role, or a pane the operator has open as a Terminal
  private idleLandingShell(pane: Pane): boolean {
    if (pane.sessionName?.startsWith('rac-stack-')) return false;
    // a Review run's pane stays its run's, even once its Agent has exited to the shell
    if (pane.reviewRun !== undefined) return false;
    if (pane.role !== undefined || this.paneHasOpenTerminal(pane)) return false;
    return pane.command === this.hostShellName;
  }

  // every pane on every socket, the sockets listed concurrently, in discovery order
  private async listedPanes(): Promise<Array<{ socket: SocketRef; pane: Pane }>> {
    const sockets = await this.finder.find();
    const listed = await Promise.all(sockets.map(async socket => ({ socket, panes: await this.panes.listPanes(socket) })));
    return listed.flatMap(({ socket, panes }) => panes.map(pane => ({ socket, pane })));
  }

  // the session a launch or a Console shell at a Place joins: its live Agent's, else the one
  // holding its Console shells, else the one holding its Stack process, else any pane in the
  // marked Workspace, so a launch never replaces or modifies an existing Place session
  private async placeSession(place: Pick<Place, 'id'>): Promise<TmuxSession | undefined> {
    const agent = await this.placeAgentSession(place.id);
    if (agent !== undefined) return agent;
    const panes = await this.placePanes(place);
    const member = panes.find(pane => pane.role === 'shell') ?? panes.find(pane => pane.role === processPaneRole) ?? panes[0];
    return member === undefined ? undefined : { socket: member.socket, session: member.sessionId };
  }

  // kill every idle interactive shell sitting exactly in this Worktree in its Workspace session —
  // remove's first step, so a removed checkout leaves no dangling shell pane behind. A running
  // agent does not report the shell command, so its pane is never touched.
  async killWorktreeShells(worktree: Worktree): Promise<void> {
    for (const { socket, pane } of await this.listedPanes()) {
      if (pane.placeMark !== worktree.id) continue;
      // leave a Console shell and any pane open as a Terminal alone; the operator ends those
      // deliberately (Remove is separately refused while a Console shell exists)
      if (!this.idleLandingShell(pane)) continue;
      if (!await this.paneRootIsWorktree(worktree, pane.path)) continue;
      await this.panes.close(socket, pane.paneId).catch(() => false);
    }
  }

  // the Console shells the operator created at this Place: panes marked `@rac_role=shell` in
  // its Workspace session, wherever their shells have `cd`'d. Drives the panes API (rename,
  // end), the Remove gate, and the launch "join the shells' session" rule.
  async placeConsoleShells(place: Pick<Place, 'id'>): Promise<Pane[]> {
    return (await this.placePanes(place)).filter(pane => pane.role === 'shell');
  }

  // Every pane the console may stream for a Place: every pane of the tmux sessions marked as its
  // Workspace (`@rac_place`), its live Agent's window, its Console shells, an idle landing shell,
  // and nothing from any other session, even a pane sat in the Place's folder. Membership for
  // the Place pane socket and the source of the panes-API listing. The console's own
  // `rac-stack-*` sessions are never marked, so their transient command runs never count.
  async placePanes(place: Pick<Place, 'id'>): Promise<Pane[]> {
    const sockets = await this.finder.find();
    return (await Promise.all(sockets.map(socket => this.panes.listPanes(socket)))).flat().filter(pane => pane.placeMark === place.id);
  }

  // whether a Console shell is busy (its foreground command is not the login shell), so the
  // panes API can ask the operator to confirm ending it
  consoleShellBusy(pane: Pane): boolean {
    return pane.command !== this.shellName;
  }

  // is a shell's git toplevel exactly this worktree (a subdirectory counts, a nested checkout does not)?
  private async paneRootIsWorktree(worktree: Worktree, paneCwd: string): Promise<boolean> {
    // a shell already at the worktree root needs no git resolution
    if (worktreeMatchesWorkspace(worktree, paneCwd)) return true;
    return worktreeMatchesWorkspace(worktree, await this.paneRoot(paneCwd));
  }
  // label a pane (or a session's active pane) so its tab reads as its Place or modal flow
  private async labelPane(socketPath: string | undefined, target: string, label: string): Promise<boolean> {
    const socket = socketPath === undefined ? [] : ['-S', socketPath];
    return (await run(this.tmux, [...socket, 'set-option', '-p', '-t', target, '@rac_display_label', tmuxLiteralArg(label)])).code === 0;
  }
  // launch one ordinary scratch agent of the resolved (or requested) kind at the Scratch Place:
  // the configured Scratch directory when set, else the account home
  async launchHome(kind?: AgentKind): Promise<boolean> {
    return await this.launchRemembering(await this.scratchPlace(), scratchLaunchKey, kind);
  }

  // launch one agent directly in a non-git `directory` Project — the same in-place spawn
  // Scratch uses (no Worktree), joining the Project's Place and labeled with the Project so
  // its tab reads as the Project; discovery keeps its notes and console-named conversations
  // under the Scratch persistence key for the directory. Only an available `directory` Project
  // launches this way: a `repository` Project launches through its Worktrees, and an
  // unavailable one has nothing to launch into. Remembers the kind under the Project scope.
  async launchProjectDirectory(projectId: string, kind?: AgentKind): Promise<boolean> {
    const place = await this.directoryPlace(projectId);
    return place !== undefined && await this.launchRemembering(place, projectId, kind);
  }

  // launch a fresh agent at any Place through its own launch: a Worktree's, a directory
  // Project's, the Scratch folder's, or in place in an ad-hoc Scratch folder, remembering the kind
  // under that folder's own scope. Only Open folder launches in an ad-hoc folder.
  async launchAt(place: Place, kind?: AgentKind): Promise<boolean> {
    if (place.kind === 'worktree') return await this.launch(place.id, kind);
    if (place.kind === 'directory') return await this.launchProjectDirectory(place.projectId, kind);
    return place.adhoc === true ? await this.launchRemembering(place, place.id, kind) : await this.launchHome(kind);
  }

  // launch in place at a directory-Project or Scratch Place with the resolved (or requested) kind,
  // remembering it under `scope`; a storage failure never fails a live launch
  private async launchRemembering(place: Place, scope: string, kind?: AgentKind): Promise<boolean> {
    const resolved = await this.resolveLaunchKind(scope, kind);
    // refuse an unconfigured or unlaunchable kind
    if (resolved === undefined) return false;
    const launched = await this.launchInPlace(place, resolved);
    if (launched) await this.worktreeStore.rememberLaunchProfile(scope, resolved).catch(() => {});
    return launched;
  }

  // launch one dedicated advisor in a fixed server-owned checkout
  async launchUpdateAdvisor(repository: string, targetSha: string): Promise<boolean> {
    // reject malformed internal paths
    if (!repository.startsWith('/') || repository.includes('\0') || !isFullGitSha(targetSha)) return false;
    const program = this.codexProgram();
    // report unavailable when no Codex binary is configured
    if (program === undefined) return false;
    // share normal codex account settings even with a host executable override
    const configured = this.config.adapters.codex;
    const operatorArgs = withoutFlags(configured?.args ?? [], updateAdvisorReplacedFlags);
    // setup remains tied to its configured executable
    const command = composeLaunch(program, [], operatorArgs, {}, configured?.env, program === configured?.program ? configured.setup : undefined, updateAdvisorArgs);
    const label = updateAdvisorPendingLabel(targetSha);
    // the advisor is a modal flow, never part of a Place: its own uniquely named session every time
    const key = `advisor:${repository}:${label}`;
    if (this.pending.has(key)) return false;
    this.pending.add(key);
    try {
      const id = randomBytes(18).toString('base64url');
      const session = `rac-${id.slice(0, 12)}`;
      const pane = await this.openLaunchPane({ cwd: repository, home: this.agentHome() }, command, id, session, repository);
      // nothing was created to roll back
      if (pane === undefined) return false;
      // protect the pane until its label is complete
      return await this.finishCreatedPane(this.hostSocket, pane, repository, async () => await this.labelPane(this.hostSocket, pane, label));
    } finally { this.pending.delete(key); }
  }

  // launch into a directory-Project or Scratch Place without modifying an idle shell's input
  private async launchInPlace(place: Place, kind: AgentKind): Promise<boolean> {
    if (this.pending.has(place.id)) { console.warn(`[launch] ${place.home}: a launch is already in progress`); return false; }
    this.pending.add(place.id);
    try {
      // under the Docker bridge the host-visible path is what the host tmux can cd into; HOME is
      // the default account home for every directory-Project and Scratch launch
      const site: LaunchSite = { cwd: placeHostRoot(place), home: this.agentHome() };
      const command = await this.scratchCommand(kind, site.cwd);
      if (command === undefined) { console.warn(`[launch] ${place.home}: agent kind ${kind} produced no launch command`); return false; }
      const id = randomBytes(18).toString('base64url');
      const joined = await this.placeSession(place);
      if (joined !== undefined) {
        const pane = await this.launchInSessionWindow(site, command, id, false, joined, place.home);
        // the window failed or already rolled back
        if (pane === undefined) return false;
        // protect the pane until its label is complete
        return await this.finishCreatedPane(joined.socket.path, pane, place.home, async () => await this.labelPane(joined.socket.path, pane, place.label));
      }
      const session = await this.availableSessionName(placeSessionName(place));
      const pane = await this.openLaunchPane(site, command, id, session, place.home);
      if (pane === undefined) return false;
      // protect the pane until all place metadata is complete
      return await this.finishCreatedPane(this.hostSocket, pane, place.home, async () => await this.markSessionPlace(this.hostSocket, pane, place.id) && await this.labelPane(this.hostSocket, pane, place.label) && await this.markConsoleManaged(this.hostSocket, pane));
    } finally {
      this.pending.delete(place.id);
    }
  }

  // Open a detached pane running the composed launch at the site — the host bootstrap on the
  // bridge socket, else the local runner, which keeps the command out of the process table — as a
  // window of the joined session, else as a new session of that name.
  private async openLaunchPane(site: LaunchSite, command: string, id: string, at: TmuxSession | string, logName: string): Promise<string | undefined> {
    if (this.hostSocket !== undefined) return await this.openPane(at, site.cwd, this.hostShellArgv(expandHomeCommand(command, site.cwd), site.home), logName);
    const { descriptor, runner } = await this.writeLaunchDescriptor(id, command, site);
    const pane = await this.openPane(at, undefined, terminalColorFallbackArgv(this.tmux, [process.execPath, runner, descriptor]), logName);
    // clean failed launch descriptors
    if (pane === undefined) await unlink(descriptor).catch(() => {});
    return pane;
  }

  // Open a detached pane running `argv` as a new window of a joined session, else as a new session
  // of that name on the launch socket, and return its pane id, which later options target: a bare
  // session name can resolve to a window of the same name in another session.
  private async openPane(at: TmuxSession | string, cwd: string | undefined, argv: readonly string[], logName: string): Promise<string | undefined> {
    const create = typeof at === 'string'
      ? [...(this.hostSocket === undefined ? [] : ['-S', this.hostSocket]), 'new-session', '-d', '-s', tmuxFormatLiteral(at)]
      : ['-S', at.socket.path, 'new-window', '-d', '-t', at.session];
    const created = await run(this.tmux, [...create, ...(cwd === undefined ? [] : ['-c', tmuxFormatLiteral(cwd)]), '-P', '-F', '#{pane_id}', '--', ...argv]);
    if (created.code !== 0) {
      console.error(`[launch] ${logName}: tmux ${typeof at === 'string' ? `new-session '${at}'` : `new-window in '${at.session}'`} failed (code ${created.code})${created.stderr.trim() === '' ? '' : `: ${created.stderr.trim()}`}`);
      return undefined;
    }
    return created.stdout.trim();
  }

  // the bridge login shell exec'ing `command` through the interactive bootstrap with the account's
  // HOME and PATH, or with no command the interactive shell itself under that HOME; colors are
  // established before the shell or the command starts
  private hostShellArgv(command: string, home: string): string[] {
    return terminalColorFallbackArgv('tmux', [this.hostShell, '-lc', interactiveShellBootstrap(command === '' ? '' : hostCommand(command, home), home, this.hostShell)]);
  }

  // where a worktree launch runs: its host root with its Project's account home on the bridge,
  // else the checkout with the local shell's own HOME
  private worktreeSite(worktree: Worktree): LaunchSite {
    return this.hostSocket === undefined ? { cwd: worktree.identity, home: '$HOME' } : { cwd: worktreeHostRoot(worktree), home: this.agentHome(worktree.projectId) };
  }

  // launch a fresh agent in a worktree, resolving the kind (or using the requested one)
  async launch(worktreeId: string, kind?: AgentKind): Promise<boolean> {
    return await this.launchWorktree(worktreeId, { mode: 'fresh', ...(kind === undefined ? {} : { kind }) });
  }

  // launch a Review run's Agent (ADR 0010): a `kind` pane in the Worktree's Workspace, fresh or
  // resuming the run's conversation (an id its Adapter accepts), always a new window, with the
  // run's read-only arguments composed in. The pane is marked
  // `@rac_review_run=<runId>` (so other launch flows and completion notifications
  // leave it alone) and labelled with the run. It joins the Place's session, else any session
  // marked as its Workspace, else starts one under a free name, never displacing another
  // session. The kind is not remembered as the Worktree's last-used one. Another launch in
  // flight at the Worktree is waited out rather than refused: a tour and its Code review
  // may launch together.
  async launchReviewRun(worktreeId: string, kind: AgentKind, review: ReviewRunLaunch): Promise<boolean> {
    const worktree = this.worktreeById(worktreeId);
    const resumable = review.conversationId === undefined || adapterFor(kind)?.conversations?.validId(review.conversationId) === true;
    if (worktree === undefined || !this.isLaunchableKind(kind) || !reviewRunIdPattern.test(review.runId) || !resumable) { console.warn(`[launch] review run: cannot launch ${kind} in ${worktreeId}`); return false; }
    if (!await this.waitForLaunchSlot(worktreeId)) { console.warn(`[launch] ${worktree.identity}: a review run waited too long for another launch`); return false; }
    this.pending.add(worktreeId);
    try {
      const files = await this.adapterFiles(kind);
      const mode = review.conversationId === undefined ? { mode: 'fresh' as const } : { mode: 'resume' as const, conversationId: review.conversationId };
      const command = this.composeKindLaunch(kind, { ...mode, cwd: worktree.identity, sandboxed: false, ...(files === undefined ? {} : { files }) }, review);
      if (command === undefined) return false;
      const id = randomBytes(18).toString('base64url');
      const site = this.worktreeSite(worktree);
      const joined = await this.placeSession(worktree);
      // tmux turns `.` into `_` in a session name, so the free-name check compares what it lists
      const socketPath = joined === undefined ? this.hostSocket : joined.socket.path;
      const pane = await this.openLaunchPane(site, command, id, joined ?? await this.availableSessionName(worktreeSessionName(worktreeHostRoot(worktree)).replaceAll('.', '_')), worktree.identity);
      if (pane === undefined) return false;
      // reject any pane missing required review metadata
      return await this.finishCreatedPane(socketPath, pane, worktree.identity, async () => await this.markReviewRun(socketPath, pane, review) && (joined !== undefined || await this.markSessionPlace(socketPath, pane, worktree.id)) && await this.markConsoleManaged(socketPath, pane));
    } finally {
      this.pending.delete(worktreeId);
    }
  }

  // wait for another launch at this scope to finish, up to the launch-ready window
  private async waitForLaunchSlot(scope: string): Promise<boolean> {
    for (let attempt = 0; attempt < 240 && this.pending.has(scope); attempt += 1) await new Promise(resolve => setTimeout(resolve, 250));
    return !this.pending.has(scope);
  }

  // mark a Review run's pane with its run id and label it with the run
  private async markReviewRun(socketPath: string | undefined, pane: string, review: ReviewRunLaunch): Promise<boolean> {
    const socket = socketPath === undefined ? [] : ['-S', socketPath];
    return (await run(this.tmux, [...socket, 'set-option', '-p', '-t', pane, '@rac_review_run', review.runId])).code === 0 && await this.labelPane(socketPath, pane, review.label);
  }

  // resume the previous conversation (Codex: `codex resume --last`), no shell alias
  async resume(worktreeId: string, kind?: AgentKind): Promise<boolean> {
    return await this.launchWorktree(worktreeId, { mode: 'continue', ...(kind === undefined ? {} : { kind }) });
  }

  // resume one exact listed conversation by its id, through its Adapter kind
  async resumeConversation(worktreeId: string, threadId: string, kind?: AgentKind): Promise<boolean> {
    // validate the id through the resuming Adapter rather than a hard-coded UUID pattern, so a
    // kind whose ids are not UUIDs still resumes; a validated id also keeps the host command
    // free of shell input, whether the id is quoted or substituted
    const resumeKind = kind ?? await this.resolveLaunchKind(worktreeId);
    if (resumeKind === undefined || adapterFor(resumeKind)?.conversations?.validId(threadId) !== true) return false;
    return await this.launchWorktree(worktreeId, { mode: 'resume', conversationId: threadId, kind: resumeKind });
  }

  // expose exact-resume support before destructive lifecycle work: a known Worktree
  // resumes through any launchable Adapter
  canResumeConversation(worktreeId: string): boolean {
    return this.worktreeById(worktreeId) !== undefined && this.launchableKinds().length > 0;
  }

  // start one worktree in the requested mode, composing its command from the Adapter
  private async launchWorktree(worktreeId: string, input: { mode: LaunchMode; conversationId?: string; sandboxed?: boolean; kind?: AgentKind }): Promise<boolean> {
    const worktree = this.worktreeById(worktreeId);
    // Every refusal below logs its reason. The web only ever sees a bare "couldn't
    // start", so without this the operator has nothing to diagnose from — the cause
    // never leaves this method (see the sibling logs in dispatchWorktreeLaunch).
    if (worktree === undefined) { console.warn(`[launch] no worktree matches id ${worktreeId}`); return false; }
    // serialize each worktree launch
    if (this.pending.has(worktreeId)) { console.warn(`[launch] ${worktree.identity}: a launch is already in progress`); return false; }
    this.pending.add(worktreeId);
    try {
      const kind = await this.resolveLaunchKind(worktreeId, input.kind);
      // refuse an unconfigured or unlaunchable kind
      if (kind === undefined) { console.warn(`[launch] ${worktree.identity}: no launchable agent kind (check adapters.*.launchable and the agent binary)`); return false; }
      const id = randomBytes(18).toString('base64url');
      const sandboxed = input.sandboxed === true;
      const command = await this.worktreeCommand(worktree, kind, { mode: input.mode, ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }), sandboxed });
      // a worktree with no launch command (and no override) cannot start
      if (command === undefined) { console.warn(`[launch] ${worktree.identity}: agent kind ${kind} produced no launch command`); return false; }
      const launched = await this.dispatchWorktreeLaunch(worktree, command, id, sandboxed);
      // record the kind so it resolves first next time — for this Worktree and for its
      // Project (which seeds a fresh Worktree); storage failure never fails a live launch
      if (launched) {
        await this.worktreeStore.rememberLaunchProfile(worktreeId, kind).catch(() => {});
        await this.worktreeStore.rememberLaunchProfile(worktree.projectId, kind).catch(() => {});
      }
      return launched;
    } finally {
      this.pending.delete(worktreeId);
    }
  }

  // dispatch a composed worktree launch without modifying an idle shell's input
  private async dispatchWorktreeLaunch(worktree: Worktree, command: string, id: string, sandboxed: boolean): Promise<boolean> {
    const site = this.worktreeSite(worktree);
    // join the marked Place session without modifying any existing pane
    const joined = await this.placeSession(worktree);
    if (joined !== undefined) return await this.launchInSessionWindow(site, command, id, sandboxed, joined, worktree.identity) !== undefined;
    const session = worktreeSessionName(worktreeHostRoot(worktree));
    // suffix past an unmarked name collision instead of displacing an unproven session
    const name = await this.availableSessionName(session);
    const pane = await this.openLaunchPane(site, command, id, name, worktree.identity);
    // nothing was created to roll back
    if (pane === undefined) return false;
    // protect the pane until all worktree metadata is complete
    return await this.finishCreatedPane(this.hostSocket, pane, worktree.identity, async () => await this.markSessionPlace(this.hostSocket, pane, worktree.id) && await this.markConsoleManaged(this.hostSocket, pane) && await this.markSandboxed(this.hostSocket, pane, sandboxed));
  }

  // launch the agent in a new detached window of an existing session (the session holding the
  // place's console shells or live agent), mirroring the fresh-session dispatch but with
  // `new-window` — the same host bootstrap / local runner split. returns the new pane, marked
  // console-managed (and sandboxed when asked), or undefined; `logName` names the place in logs.
  private async launchInSessionWindow(site: LaunchSite, command: string, id: string, sandboxed: boolean, joined: TmuxSession, logName: string): Promise<string | undefined> {
    const pane = await this.openLaunchPane(site, command, id, joined, logName);
    // nothing was created to roll back
    if (pane === undefined) return undefined;
    // protect the pane until all window metadata is complete
    return await this.finishCreatedPane(joined.socket.path, pane, logName, async () => await this.markConsoleManaged(joined.socket.path, pane) && await this.markSandboxed(joined.socket.path, pane, sandboxed)) ? pane : undefined;
  }

  // keep only a fresh pane with all required metadata
  private async finishCreatedPane(socketPath: string | undefined, pane: string, logName: string, configure: () => Promise<boolean>): Promise<boolean> {
    let configured = false;
    // treat metadata transport errors as incomplete launches
    try {
      configured = await configure();
    } catch {
      console.error(`[launch] ${logName}: pane metadata command failed for ${pane}`);
    }
    // close the exact pane created by this launch
    if (!configured) {
      console.error(`[launch] ${logName}: could not configure new pane ${pane}; closing it`);
      await run(this.tmux, [...(socketPath === undefined ? [] : ['-S', socketPath]), 'kill-pane', '-t', pane]).catch(() => undefined);
    }
    return configured;
  }

  // Write the local-runner launch descriptor (the composed command wrapped in the interactive
  // bootstrap, run out of the process table) and return the descriptor path plus the runner
  // entrypoint. Shared by every local launch: a fresh session or a window in an existing one.
  private async writeLaunchDescriptor(id: string, command: string, site: LaunchSite): Promise<{ descriptor: string; runner: string }> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const descriptor = join(this.root, `${id}.json`);
    const payload = { program: this.localShell, args: ['-lc', interactiveShellBootstrap(expandHomeCommand(command, site.cwd), site.home, this.localShell)], cwd: site.cwd };
    const handle = await open(descriptor, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(payload));
    await handle.close();
    return { descriptor, runner: new URL('./runner.js', import.meta.url).pathname };
  }

  // start the Worktree's own idle interactive shell — a login shell in the checkout, no
  // agent command — so a freshly added Worktree gets a tab and a Workspace session even
  // when the operator declines to launch an agent. Its
  // session name is `basename(worktree dir)` like a launch, but gains `-2`/`-3` suffixes
  // when a different Worktree already holds that name (two Projects can share a checkout
  // basename), so it never displaces another. It is a Console shell's login shell without the
  // Console shell role, marked through its new pane id (a dotted session name is no tmux target).
  async startWorktreeShell(worktree: Worktree): Promise<boolean> {
    const name = await this.availableSessionName(worktreeSessionName(worktreeHostRoot(worktree)));
    const { cwd, argv } = this.consoleShellCommand(worktreePlace(worktree), '');
    const pane = await this.openPane(name, cwd, argv, worktree.identity);
    return pane !== undefined
      && await this.markSessionPlace(this.hostSocket, pane, worktree.id)
      && await this.markConsoleManaged(this.hostSocket, pane);
  }

  // a session name free on the relevant socket: the base name, else `-2`/`-3`/… — so a
  // new Worktree's idle shell never collides with a same-basename Worktree of another
  // Project. Falls back to a random suffix after a run of taken names.
  private async availableSessionName(base: string): Promise<string> {
    return await availableSessionName(this.tmux, this.hostSocket === undefined ? [] : ['-S', this.hostSocket], base);
  }

  // the login-shell command and cwd for a Console shell at a Place: a native login shell in the
  // Place home, or the host bootstrap in its host root on the host socket (same shape as
  // `startWorktreeShell`), with the HOME the Place's own Agent launch exports. Never sandboxed —
  // it is the operator's own shell, not the Agent's. A `command` (the configured editor) is exec'd
  // through the interactive bootstrap, so the pane ends with it.
  private consoleShellCommand(place: ConsoleShellPlace, command: string): { cwd: string; argv: string[] } {
    // color setup precedes even operator login-shell startup files
    if (this.hostSocket === undefined) return { cwd: place.home, argv: terminalColorFallbackArgv(this.tmux, command === '' ? [this.localShell, '-l'] : [this.localShell, '-lc', interactiveShellBootstrap(command, '$HOME', this.localShell)]) };
    // a Worktree launch exports its Project's account home; directory and Scratch launches the default one
    const home = this.agentHome(place.kind === 'worktree' ? place.projectId : undefined);
    return { cwd: placeHostRoot(place), argv: this.hostShellArgv(command, home) };
  }

  // Open a Console shell at the Place and return the new pane id, or undefined on failure.
  // Placement (spec): a detached window in the session of the Place's live Agent (the caller
  // resolves it from discovery), else the session already holding the Place's Console shells,
  // else a fresh console session named for the Place — so agent and shells stay in one session.
  // `keyBinding` (`table chord`) tags the pane of a key binding's Terminal, so `reuse` finds it.
  async createConsoleShell(place: ConsoleShellPlace, name: string, command = '', keyBinding?: string): Promise<string | undefined> {
    const { cwd, argv } = this.consoleShellCommand(place, command);
    const joined = await this.placeSession(place);
    const pane = joined !== undefined
      ? await this.panes.createConsoleShellWindow(joined.socket, joined.session, cwd, argv, name)
      : await this.createConsoleShellSession(place, cwd, argv, name);
    // a command's pane closes when it exits, even under an operator's `remain-on-exit on`
    if (pane !== undefined && command !== '') {
      const socketPath = joined === undefined ? this.hostSocket : joined.socket.path;
      await run(this.tmux, [...(socketPath === undefined ? [] : ['-S', socketPath]), 'set-option', '-p', '-t', pane, 'remain-on-exit', 'off']);
      if (keyBinding !== undefined) await run(this.tmux, [...(socketPath === undefined ? [] : ['-S', socketPath]), 'set-option', '-p', '-t', pane, '@rac_key_binding', tmuxLiteralArg(keyBinding)]);
    }
    return pane;
  }

  // create the Place's first Console shell as a fresh console session named for the Place
  // (the no-live-Agent path); a later Launch adds its window to this session
  private async createConsoleShellSession(place: ConsoleShellPlace, cwd: string, argv: string[], name: string): Promise<string | undefined> {
    const pane = await this.openPane(await this.availableSessionName(placeSessionName(place)), cwd, argv, place.home);
    if (pane === undefined) return undefined;
    // the Place mark first: a session with a Console shell and no mark is one a claim would mark;
    // closing its only pane tears down an unmarked session rather than leak it
    return await this.finishCreatedPane(this.hostSocket, pane, place.home, async () => await this.markSessionPlace(this.hostSocket, pane, place.id) && await this.markPaneConsoleShell(this.hostSocket, pane, name)) ? pane : undefined;
  }

  // mark a freshly created session's pane as a Console shell (the fresh-session path already
  // knows its socket, so it sets the options directly rather than through a SocketRef)
  private async markPaneConsoleShell(socketPath: string | undefined, pane: string, name: string): Promise<boolean> {
    const socket = socketPath === undefined ? [] : ['-S', socketPath];
    if ((await run(this.tmux, [...socket, 'set-option', '-p', '-t', pane, '@rac_role', 'shell'])).code !== 0) return false;
    return (await run(this.tmux, [...socket, 'set-option', '-p', '-t', pane, '@rac_pane_name', name])).code === 0;
  }

  // mark a session the console created as the Workspace of this Place (`@rac_place`), so every
  // pane opened in it belongs there; `target` is one of its pane ids
  private async markSessionPlace(socketPath: string | undefined, target: string, placeId: string): Promise<boolean> {
    const socket = socketPath === undefined ? [] : ['-S', socketPath];
    return (await run(this.tmux, [...socket, 'set-option', '-t', target, '@rac_place', tmuxLiteralArg(placeId)])).code === 0;
  }

  // mark panes the console deliberately owns, so retained OMX workers remain launchable
  private async markConsoleManaged(socketPath: string | undefined, target: string): Promise<boolean> {
    const socket = socketPath === undefined ? [] : ['-S', socketPath];
    return (await run(this.tmux, [...socket, 'set-option', '-p', '-t', target, '@rac_console_managed', '1'])).code === 0;
  }

  // record a Sandboxed launch on the pane so `Agent.sandboxed` reflects it; a
  // dead pane's option is cleared by discovery. Chunk 1 never launches sandboxed
  // (chunk 4 realises the sandbox), so in practice this is a no-op until then.
  private async markSandboxed(socketPath: string | undefined, target: string, sandboxed: boolean): Promise<boolean> {
    if (!sandboxed) return true;
    const socket = socketPath === undefined ? [] : ['-S', socketPath];
    return (await run(this.tmux, [...socket, 'set-option', '-p', '-t', target, '@rac_sandboxed', '1'])).code === 0;
  }
}
