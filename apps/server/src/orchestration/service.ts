import type { ValidatedConfig } from '../config/schema.js';
import type { DashboardPayload } from '../dashboard/updates.js';
import type { DiscoveryService } from '../discovery/service.js';
import { stackActions, type Agent, type Worktree } from '../domain/models.js';
import { agentAttentionState, agentPresentationAttentionState } from '../notifications.js';
import type { PromptHistoryService } from '../prompt-history/service.js';
import { promptScope, type PromptService } from '../prompts/service.js';
import { validPrompt } from '../prompts/validation.js';
import type { PullRequestSwitchService } from '../pull-requests/switch-service.js';
import type { StoredReviewTour } from '../review-tour/contracts.js';
import type { ReviewTourInput } from '../review-tour/contracts.js';
import type { NewTaskService } from '../new-task/service.js';
import type { WorktreeNoteService } from '../notes/service.js';
import type { Schedule } from '../schedule/types.js';
import type { WorkspaceFileService, WorkspaceFilePreview } from '../workspace-files/service.js';
import { configuredWorktreeForWorkspace, projectIdOf, worktreeById } from '../workspaces/resolver.js';
import { limitText, redactIntegrationText } from '../integrations/text.js';
import { processActions, type StackState, type WorktreeCommandService } from '../worktree-commands/service.js';
import { declaredProcesses } from '../domain/stack-processes.js';
import { GithubRequestError, type GithubRepository } from '../pull-requests/github.js';
import { originRepository } from '../watches/github.js';
import type { WatchRefusal, Watches } from '../watches/service.js';
import type {
  AgentStatusV1,
  AnswerQuestionInputV1,
  AttentionSummaryV1,
  FilePreviewV1,
  InstanceV1,
  LatestResponseV1,
  LogTailV1,
  MoveQueuedPromptInputV1,
  OrchestrationErrorCode,
  OrchestrationResult,
  PreviewFileInputV1,
  PromptHistoryV1,
  PullRequestStatusV1,
  QueuePromptInputV1,
  QueuedPromptsV1,
  RemoveQueuedPromptInputV1,
  ReviewStatusV1,
  RunStackActionInputV1,
  StackStateV1,
  StackStatusV1,
  SwitchPullRequestInputV1,
  StartReviewInputV1,
  UpdateQueuedPromptInputV1,
  WorkspaceSummaryV1,
  WorktreeStatusV1
} from './contracts.js';
import { orchestrationContractVersion } from './contracts.js';

// A stack's state as integrations read it: each process carries only the fields the contract
// names, so Process notices, and whatever else the console's own menu gains, stay out of it.
const integrationStack = (state: StackState): Omit<StackStateV1, 'actions'> => state.processes === undefined ? state : {
  ...state,
  processes: state.processes.map(({ name, state: processState, exitCode, operation }) => ({ name, state: processState, ...(exitCode === undefined ? {} : { exitCode }), ...(operation === undefined ? {} : { operation }) }))
};

const maxIdentifierLength = 240;
const maxFilePathLength = 512;
const defaultLogRows = 120;
const maxLogRows = 300;
const defaultPreviewBytes = 64 * 1024;
const maxPreviewBytes = 256 * 1024;
const maxTerminalBytes = 96 * 1024;
const maxIntegrationPromptBytes = 8 * 1024;
const promptIdPattern = /^[A-Za-z0-9_-]{12,64}$/u;
// a unified Inline-question id: the 22-char base64url hash the Adapter derives
const questionIdPattern = /^[A-Za-z0-9_-]{22}$/u;

type DiscoveryFacade = Pick<DiscoveryService, 'target' | 'worktreesNow'>;
type PromptFacade = Pick<PromptService, 'submitFrom' | 'inFlight' | 'listQueued' | 'updateQueued' | 'moveQueued' | 'removeQueued' | 'answerQuestion' | 'cancel' | 'close' | 'transportFor'>;
type HistoryFacade = Pick<PromptHistoryService, 'list'>;
type WorktreeCommandFacade = Pick<WorktreeCommandService, 'actions' | 'state' | 'start' | 'log' | 'processLog'>;
type WorkspaceFileFacade = Pick<WorkspaceFileService, 'preview'>;
type PullRequestSwitchFacade = Pick<PullRequestSwitchService, 'available' | 'actionsUrl' | 'switch'>;
type NewTaskFacade = Pick<NewTaskService, 'available' | 'start'>;

export type OrchestrationDependencies = {
  config: ValidatedConfig;
  loadDashboard: () => Promise<DashboardPayload>;
  discovery: DiscoveryFacade;
  prompts: PromptFacade;
  promptHistory: HistoryFacade;
  worktreeCommands: WorktreeCommandFacade;
  workspaceFiles: WorkspaceFileFacade;
  pullRequests: PullRequestSwitchFacade;
  newTasks: NewTaskFacade;
  loadInstances?: () => Promise<InstanceV1[]>;
  launchWorktree: (worktreeId: string) => Promise<boolean>;
  launchScratch: () => Promise<boolean>;
  loadReview?: (worktreeId: string, branch: string) => Promise<StoredReviewTour | undefined>;
  startReview?: (agentId: string, input: ReviewTourInput, conductor?: string) => Promise<unknown>;
  /** The Conductor acting through these operations (ADR 0018), by its Agent id; none for the operator's integrations. */
  conductor?: string;
  /**
   * Spawn a Sandboxed Pi worker for the Conductor at a Place (ADR 0018): its id, or why not (the
   * model is not allowed, the Conductor has its cap of live workers, or it could not start).
   */
  spawnWorker?: (placeId: string, conductor: string, model?: string) => Promise<string | 'not-allowed' | 'at-capacity' | undefined>;
  /** The Notes of a Place (its notes key, the store, deletion and a Schedule aimed at the Conductor), and telling the web they changed. */
  notes?: NoteFacade;
  /** The Watches the Conductor sets (ADR 0019). */
  watches?: Pick<Watches, 'watchPullRequest' | 'watchProcess' | 'watchReviewRequests' | 'watchCommand' | 'list' | 'remove'>;
};
type NoteFacade = {
  key: (placeId: string) => Promise<string | undefined>;
  store: Pick<WorktreeNoteService, 'list' | 'resolve' | 'createWithText' | 'update' | 'rename' | 'setSchedule'>;
  remove: (key: string, noteId: string) => Promise<unknown>;
  conductorSchedule: (cron: string, enabled: boolean) => Schedule | string;
  changed: () => void;
};
/** Which Places a principal may act on, by the Worktree (or Place) id and its Project. */
export type PlaceScope = (place: { id: string; projectId: string }) => boolean;

const safeHiddenPaths = new Set(['.dockerignore', '.editorconfig', '.gitattributes', '.github', '.gitignore']);
const sensitiveFileNames = new Set(['.npmrc', '.netrc', '.pypirc', 'auth.json', 'credentials', 'credentials.json', 'id_ed25519', 'id_rsa', 'integration-auth.json', 'integration-state.json', 'secrets.json']);
const sensitiveExtensions = new Set(['.cer', '.crt', '.jks', '.key', '.keystore', '.p12', '.pem', '.pfx']);

// build one successful v1 result
function success<T>(value: T): OrchestrationResult<T> {
  return { ok: true, version: orchestrationContractVersion, value };
}

// build one typed v1 failure
function failure<T>(code: OrchestrationErrorCode, message: string, retryable = false): OrchestrationResult<T> {
  return { ok: false, version: orchestrationContractVersion, error: { code, message, retryable } };
}

// validate bounded external identifiers
function validIdentifier(value: string): boolean {
  return value.length > 0 && value.length <= maxIdentifierLength && !value.includes('\0');
}

// reject prompt payloads that can enter PromptService shell mode
function validIntegrationPrompt(value: string): boolean {
  // nor pass for one of the console's own labelled prompts (a report, an event, a Run)
  return validPrompt(value) && Buffer.byteLength(value) <= maxIntegrationPromptBytes && !/^\s*!/u.test(value) && !/^\[RAC (?:report|event|run)\]/u.test(value);
}

// reject hidden and credential-bearing integration paths
function safeIntegrationPath(value: string): boolean {
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//u, '');
  const segments = normalized.split('/').filter(Boolean);
  // reject traversal and absolute paths before the workspace service
  if (normalized.startsWith('/') || segments.includes('..')) return false;
  // reject unsafe hidden files and directories
  if (segments.some(segment => segment.startsWith('.') && !safeHiddenPaths.has(segment))) return false;
  const basename = segments.at(-1)?.toLocaleLowerCase() ?? '';
  // reject known credential stores and key material
  if (sensitiveFileNames.has(basename) || [...sensitiveExtensions].some(extension => basename.endsWith(extension))) return false;
  // reject deployment-specific private configuration
  if (/^remote-agent-console\.(?!example\.json$).+\.json$/u.test(basename)) return false;
  return true;
}

// copy a file preview through the caller's byte boundary
function limitPreview(preview: WorkspaceFilePreview, maxBytes: number): FilePreviewV1 {
  // omit complete raster bytes when they exceed this caller's smaller boundary
  if (preview.binary && preview.image !== undefined && preview.size > maxBytes) return { path: preview.path, size: preview.size, binary: true, truncated: true };
  // return binary metadata without content
  if (preview.binary || preview.content === undefined) return preview;
  const limited = limitText(redactIntegrationText(preview.content), maxBytes);
  return { ...preview, content: limited.text, truncated: preview.truncated || limited.truncated };
}

// derive one stable agent label
function agentLabel(agent: Agent): string {
  return agent.displayLabel ?? agent.title ?? agent.id;
}

// project one agent into the stable integration contract
function agentStatus(agent: DashboardPayload['agents'][number]): AgentStatusV1 {
  return {
    id: agent.id,
    title: agent.title,
    label: agentLabel(agent),
    ...(agent.projectId === undefined ? {} : { projectId: agent.projectId }),
    ...(agent.worktreeId === undefined ? {} : { worktreeId: agent.worktreeId }),
    ...(agent.branch === undefined ? {} : { branch: agent.branch }),
    ...(agent.gitStatus === undefined ? {} : { gitStatus: agent.gitStatus }),
    ...(agent.gitPrStatus === undefined ? {} : { gitPrStatus: agent.gitPrStatus }),
    ...(agent.gitUpstream === undefined ? {} : { gitUpstream: agent.gitUpstream }),
    ...(agent.pullRequest === undefined ? {} : { pullRequest: agent.pullRequest }),
    ...(agent.projectUrl === undefined ? {} : { projectUrl: agent.projectUrl, projectProxied: agent.projectProxied ?? true }),
    ...(agent.question === undefined ? {} : { question: { id: agent.question.id, text: agent.question.text, choices: [...agent.question.choices] } }),
    attention: agentAttentionState(agent),
    unread: agent.unread
  };
}

// compose existing orchestration services behind typed operations
export class OrchestrationService {
  constructor(private readonly dependencies: OrchestrationDependencies) {}

  /**
   * The same operations over only the Places `admits` (a principal's scope), acting as `conductor`
   * when given: Worktrees and Agents elsewhere are not listed, and `hasAgent` does not find such an
   * Agent, which the gateway checks before any Agent-keyed call.
   */
  scoped(admits: PlaceScope, conductor?: string): OrchestrationService {
    const { discovery, loadDashboard } = this.dependencies;
    const inScope = (agent: Pick<Agent, 'worktreeId' | 'placeId' | 'projectId'>) => admits({ id: agent.worktreeId ?? agent.placeId ?? '', projectId: agent.projectId ?? projectIdOf(agent.placeId ?? '') });
    return new OrchestrationService({
      ...this.dependencies,
      discovery: { target: (id, force) => discovery.target(id, force), worktreesNow: () => discovery.worktreesNow().filter(admits) },
      loadDashboard: async () => { const dashboard = await loadDashboard(); return { ...dashboard, agents: dashboard.agents.filter(inScope) }; },
      ...(conductor === undefined ? {} : { conductor })
    });
  }

  /** Whether an Agent is current and within these operations' scope. */
  async hasAgent(agentId: string): Promise<boolean> {
    return (await this.dependencies.loadDashboard()).agents.some(agent => agent.id === agentId);
  }

  // normalize unexpected dependency failures
  private async operation<T>(work: () => Promise<OrchestrationResult<T>>): Promise<OrchestrationResult<T>> {
    try {
      return await work();
    } catch {
      return failure('operation_failed', 'The orchestration operation failed.', true);
    }
  }

  // resolve one discovered worktree by its wire id
  private worktree(id: string): Worktree | undefined {
    return worktreeById(this.dependencies.discovery.worktreesNow(), id);
  }

  // resolve one live Agent's prompt-history scope and the workspace it runs in
  private async promptScope(agentId: string): Promise<{ scope: string; agent: Agent; workspace: string } | undefined> {
    const target = await (await this.dependencies.prompts.transportFor(agentId)).target(agentId);
    // require a current target
    if (target === undefined) return undefined;
    const worktree = configuredWorktreeForWorkspace(this.dependencies.discovery.worktreesNow(), target.agent.home);
    return {
      scope: promptScope(agentId),
      agent: target.agent,
      workspace: worktree?.identity ?? target.agent.home
    };
  }

  // merge active agents and idle dashboard rows for every discovered Worktree, in tab order
  private worktreeStatuses(dashboard: DashboardPayload): WorktreeStatusV1[] {
    const views = new Map(dashboard.projects.flatMap(project => project.worktrees).map(view => [view.id, view] as const));
    return this.dependencies.discovery.worktreesNow().map((worktree) => {
      const agents = dashboard.agents
        .filter(agent => agent.worktreeId === worktree.id)
        .sort((left, right) => left.id.localeCompare(right.id));
      const view = views.get(worktree.id);
      const primary = agents[0] ?? view;
      const review = dashboard.reviews.find(candidate => candidate.worktreeId === worktree.id && (primary?.branch === undefined || candidate.branch === primary.branch));
      const stack = agents[0]?.stack ?? view?.stack;
      return {
        id: worktree.id,
        label: worktree.label,
        available: view?.available ?? worktree.available,
        pinned: view?.pinned ?? worktree.pinned,
        active: agents.length > 0,
        order: view?.order ?? 0,
        agentIds: agents.map(agent => agent.id),
        ...(worktree.projectUrl === undefined ? {} : { projectUrl: worktree.projectUrl, projectProxied: worktree.projectPort !== undefined }),
        ...(primary?.branch === undefined ? {} : { branch: primary.branch }),
        ...(primary?.gitStatus === undefined ? {} : { gitStatus: primary.gitStatus }),
        ...(primary?.gitPrStatus === undefined ? {} : { gitPrStatus: primary.gitPrStatus }),
        ...(primary?.gitUpstream === undefined ? {} : { gitUpstream: primary.gitUpstream }),
        ...(primary?.pullRequest === undefined ? {} : { pullRequest: primary.pullRequest }),
        ...(stack === undefined ? {} : { stack: { actions: this.dependencies.worktreeCommands.actions(worktree), ...integrationStack(stack) } }),
        ...(review === undefined ? {} : { review })
      };
    });
  }

  // list configured local and remote instances
  async listInstances(): Promise<OrchestrationResult<InstanceV1[]>> {
    // prefer identities published by live peers
    if (this.dependencies.loadInstances !== undefined) return success(await this.dependencies.loadInstances());
    return success([
      {
        id: this.dependencies.config.publicOrigin.origin,
        name: this.dependencies.config.name,
        url: this.dependencies.config.publicOrigin.origin,
        local: true,
        ...(this.dependencies.config.icon === undefined ? {} : { icon: this.dependencies.config.icon })
      },
      ...this.dependencies.config.remoteServers.map(server => ({
        id: server.url.origin,
        name: server.url.hostname,
        url: server.url.origin,
        local: false
      }))
    ]);
  }

  // list configured worktrees with active and inactive state merged
  async listWorktrees(): Promise<OrchestrationResult<WorktreeStatusV1[]>> {
    return await this.operation(async () => success(this.worktreeStatuses(await this.dependencies.loadDashboard())));
  }

  // list enriched agents in deterministic order
  async listAgents(): Promise<OrchestrationResult<AgentStatusV1[]>> {
    return await this.operation(async () => {
      const dashboard = await this.dependencies.loadDashboard();
      // order agents by their Worktree's tab order, Scratch agents last
      const order = new Map(dashboard.projects.flatMap(project => project.worktrees).map(view => [view.id, view.order] as const));
      const orderOf = (agent: AgentStatusV1) => agent.worktreeId === undefined ? Number.MAX_SAFE_INTEGER : order.get(agent.worktreeId) ?? Number.MAX_SAFE_INTEGER;
      const agents = dashboard.agents
        .map(agentStatus)
        .sort((left, right) => orderOf(left) - orderOf(right) || left.id.localeCompare(right.id));
      return success(agents);
    });
  }

  // return one configured worktree status
  async worktreeStatus(worktreeId: string): Promise<OrchestrationResult<WorktreeStatusV1>> {
    // reject malformed identifiers
    if (!validIdentifier(worktreeId)) return failure('invalid_request', 'Invalid worktree identifier.');
    return await this.operation(async () => {
      // distinguish unknown configuration from an inactive worktree
      if (this.worktree(worktreeId) === undefined) return failure('not_found', 'Worktree not found.');
      const status = this.worktreeStatuses(await this.dependencies.loadDashboard()).find(candidate => candidate.id === worktreeId);
      return status === undefined ? failure('not_found', 'Worktree not found.') : success(status);
    });
  }

  // return one current enriched agent status
  async agentStatus(agentId: string): Promise<OrchestrationResult<AgentStatusV1>> {
    // reject malformed identifiers
    if (!validIdentifier(agentId)) return failure('invalid_request', 'Invalid agent identifier.');
    return await this.operation(async () => {
      const agent = (await this.dependencies.loadDashboard()).agents.find(candidate => candidate.id === agentId);
      return agent === undefined
        ? failure('not_found', 'Agent not found.')
        : success(agentStatus(agent));
    });
  }

  // return the newest completed response with durable-history fallback
  async latestResponse(agentId: string): Promise<OrchestrationResult<LatestResponseV1>> {
    // reject malformed identifiers
    if (!validIdentifier(agentId)) return failure('invalid_request', 'Invalid agent identifier.');
    return await this.operation(async () => {
      const transport = await this.dependencies.prompts.transportFor(agentId);
      // require a live target
      if (await transport.target(agentId) === undefined) return failure('not_found', 'Agent not found.');
      const shown = await transport.latestAnswer(agentId).catch(() => undefined);
      // prefer the answer the Agent shows, coherent with its latest prompt
      if (shown !== undefined) {
        const limited = limitText(redactIntegrationText(shown), maxTerminalBytes);
        return success({ text: limited.text, source: 'terminal', truncated: limited.truncated });
      }
      const scope = await this.promptScope(agentId);
      const history = scope === undefined ? undefined : await this.dependencies.promptHistory.list(scope.scope);
      const answer = history?.find(entry => entry.answer !== undefined)?.answer;
      // use the latest durable completed answer after capture loss or restart
      if (answer !== undefined) {
        const limited = limitText(redactIntegrationText(answer), maxTerminalBytes);
        return success({ text: limited.text, source: 'history', truncated: limited.truncated });
      }
      return failure('not_found', 'No completed response is available.');
    });
  }

  // capture a bounded recent terminal window
  async logTail(agentId: string, rows = defaultLogRows): Promise<OrchestrationResult<LogTailV1>> {
    // enforce the tmux viewport contract
    if (!validIdentifier(agentId) || !Number.isInteger(rows) || rows < 2 || rows > maxLogRows) return failure('invalid_request', 'Invalid log request.');
    return await this.operation(async () => {
      const transport = await this.dependencies.prompts.transportFor(agentId);
      // require a current Agent
      if (await transport.target(agentId) === undefined) return failure('not_found', 'Agent not found.');
      const captured = await transport.recentLines(agentId, rows);
      // distinguish capture failure from missing agents
      if (captured === undefined) return failure('unavailable', 'Agent log is unavailable.', true);
      const limited = limitText(redactIntegrationText(captured.text), maxTerminalBytes);
      return success({ text: limited.text, rows, older: captured.older, truncated: limited.truncated });
    });
  }

  // list bounded durable prompt history
  async promptHistory(agentId: string): Promise<OrchestrationResult<PromptHistoryV1>> {
    // reject malformed identifiers
    if (!validIdentifier(agentId)) return failure('invalid_request', 'Invalid agent identifier.');
    return await this.operation(async () => {
      const scope = await this.promptScope(agentId);
      // require a current agent target
      if (scope === undefined) return failure('not_found', 'Agent not found.');
      const prompts = await this.dependencies.promptHistory.list(scope.scope);
      return prompts === undefined ? failure('invalid_request', 'Invalid prompt history scope.') : success({ prompts: prompts.map(prompt => ({ ...prompt, text: redactIntegrationText(prompt.text), ...(prompt.answer === undefined ? {} : { answer: redactIntegrationText(prompt.answer) }) })) });
    });
  }

  // list queued prompts for one current agent
  async queuedPrompts(agentId: string): Promise<OrchestrationResult<QueuedPromptsV1>> {
    // reject malformed identifiers
    if (!validIdentifier(agentId)) return failure('invalid_request', 'Invalid agent identifier.');
    return await this.operation(async () => {
      const prompts = await this.dependencies.prompts.listQueued(agentId);
      // the Conductor sees only the prompts it queued
      const shown = prompts?.filter(prompt => this.dependencies.conductor === undefined || prompt.from === this.dependencies.conductor);
      return shown === undefined ? failure('not_found', 'Agent or prompt queue not found.') : success({ prompts: shown.map(prompt => ({ ...prompt, text: redactIntegrationText(prompt.text) })) });
    });
  }

  // whether the acting principal may change a queued prompt: the Conductor only its own
  private async mayChange(agentId: string, promptId: string): Promise<boolean> {
    const conductor = this.dependencies.conductor;
    return conductor === undefined || (await this.dependencies.prompts.listQueued(agentId))?.some(prompt => prompt.id === promptId && prompt.from === conductor) === true;
  }

  // preview one configured or active workspace file
  async previewFile(input: PreviewFileInputV1): Promise<OrchestrationResult<FilePreviewV1>> {
    const hasAgent = input.agentId !== undefined;
    const hasWorktree = input.worktreeId !== undefined;
    const maxBytes = input.maxBytes ?? defaultPreviewBytes;
    // require exactly one target and bounded inputs
    if (hasAgent === hasWorktree || !input.path || input.path.length > maxFilePathLength || input.path.includes('\0') || !safeIntegrationPath(input.path) || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > maxPreviewBytes) return failure('invalid_request', 'Invalid file preview request.');
    return await this.operation(async () => {
      let workspace: string | undefined;
      // resolve configured worktrees directly
      if (input.worktreeId !== undefined) workspace = this.worktree(input.worktreeId)?.identity;
      // resolve agents without trusting caller paths
      if (input.agentId !== undefined) workspace = (await this.promptScope(input.agentId))?.workspace;
      // require one known target
      if (workspace === undefined) return failure('not_found', 'Workspace not found.');
      const preview = await this.dependencies.workspaceFiles.preview(workspace, input.path);
      // recheck the canonical path after symlink resolution
      if (preview === undefined || !safeIntegrationPath(preview.path)) return failure('not_found', 'File not found.');
      return success(limitPreview(preview, maxBytes));
    });
  }

  // report pull request and switching state
  async pullRequestStatus(agentId: string): Promise<OrchestrationResult<PullRequestStatusV1>> {
    // reject malformed identifiers
    if (!validIdentifier(agentId)) return failure('invalid_request', 'Invalid agent identifier.');
    return await this.operation(async () => {
      const agent = (await this.dependencies.loadDashboard()).agents.find(candidate => candidate.id === agentId);
      // require an enriched current agent
      if (agent === undefined) return failure('not_found', 'Agent not found.');
      const switching = agent.worktreeId === undefined ? undefined : await this.dependencies.pullRequests.available(agent.worktreeId);
      const actionsUrl = await this.dependencies.pullRequests.actionsUrl(agentId).catch(() => undefined);
      // require at least one observable pull request surface
      if (switching === undefined && agent.pullRequest === undefined && agent.gitPrStatus === undefined && actionsUrl === undefined) return failure('unavailable', 'Pull request status is unavailable.');
      return success({
        ...(switching === undefined ? {} : { switching }),
        ...(agent.pullRequest === undefined ? {} : { current: agent.pullRequest }),
        ...(agent.gitPrStatus === undefined ? {} : { comparison: agent.gitPrStatus }),
        ...(actionsUrl === undefined ? {} : { actionsUrl })
      });
    });
  }

  // report current-branch review metadata
  async reviewStatus(worktreeId: string): Promise<OrchestrationResult<ReviewStatusV1>> {
    // reject malformed identifiers
    if (!validIdentifier(worktreeId)) return failure('invalid_request', 'Invalid worktree identifier.');
    return await this.operation(async () => {
      const status = this.worktreeStatuses(await this.dependencies.loadDashboard()).find(candidate => candidate.id === worktreeId);
      // require a configured worktree
      if (status === undefined) return failure('not_found', 'Worktree not found.');
      const review = status.branch === undefined || this.dependencies.loadReview === undefined
        ? undefined
        : await this.dependencies.loadReview(worktreeId, status.branch);
      return success({ ...(status.review === undefined ? {} : { summary: status.review }), ...(review === undefined ? {} : { review }) });
    });
  }

  // report configured stack state and latest operation output
  async stackStatus(worktreeId: string): Promise<OrchestrationResult<StackStatusV1>> {
    // reject malformed identifiers
    if (!validIdentifier(worktreeId)) return failure('invalid_request', 'Invalid worktree identifier.');
    return await this.operation(async () => {
      const worktree = this.worktree(worktreeId);
      // require a configured worktree
      if (worktree === undefined) return failure('not_found', 'Worktree not found.');
      const [state, log] = await Promise.all([
        this.dependencies.worktreeCommands.state(worktree),
        this.dependencies.worktreeCommands.log(worktreeId)
      ]);
      return success({ actions: this.dependencies.worktreeCommands.actions(worktree), ...integrationStack(state), ...(log === undefined ? {} : { log: { ...log, output: redactIntegrationText(log.output) } }) });
    });
  }

  // read one declared Stack process's log tail
  async processLog(worktreeId: string, name: string): Promise<OrchestrationResult<{ name: string; path: string; output: string }>> {
    if (!validIdentifier(worktreeId) || !validIdentifier(name)) return failure('invalid_request', 'Invalid process log request.');
    return await this.operation(async () => {
      const worktree = this.worktree(worktreeId);
      const log = worktree === undefined ? undefined : await this.dependencies.worktreeCommands.processLog(worktree.id, name);
      return log === undefined ? failure('not_found', 'Stack process not found.') : success({ ...log, output: redactIntegrationText(log.output) });
    });
  }

  // summarize configured and scratch workspaces deterministically
  async workspaceSummary(): Promise<OrchestrationResult<WorkspaceSummaryV1>> {
    return await this.operation(async () => {
      const dashboard = await this.dependencies.loadDashboard();
      const statuses = this.worktreeStatuses(dashboard);
      // align workspace rollups with displayed question priority
      const worktrees = statuses.map(status => {
        const agents = dashboard.agents.filter(agent => status.agentIds.includes(agent.id));
        const attention = agents.some(agent => agentPresentationAttentionState(agent) === 'question')
          ? 'question' as const
          : agents.some(agent => agentPresentationAttentionState(agent) === 'working')
            ? 'working' as const
            : agents.length > 0 ? 'finished' as const : 'inactive' as const;
        return { id: status.id, label: status.label, active: status.active, agents: agents.length, attention, ...(status.branch === undefined ? {} : { branch: status.branch }), changes: status.gitStatus?.files ?? 0 };
      });
      const configuredIds = new Set(statuses.flatMap(status => status.agentIds));
      // apply the same presentation to unconfigured agents
      const scratchAgents = dashboard.agents
        .filter(agent => !configuredIds.has(agent.id))
        .map(agent => ({ id: agent.id, label: agentLabel(agent), attention: agentPresentationAttentionState(agent) }))
        .sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id));
      const lines = [
        ...worktrees.map(worktree => `${worktree.label}: ${worktree.attention}${worktree.branch === undefined ? '' : ` on ${worktree.branch}`} (${worktree.changes} changes)`),
        ...scratchAgents.map(agent => `${agent.label}: ${agent.attention} (scratch)`)
      ];
      return success({ text: lines.join('\n'), worktrees, scratchAgents });
    });
  }

  // summarize current attention in deterministic priority order
  async attentionSummary(): Promise<OrchestrationResult<AttentionSummaryV1>> {
    return await this.operation(async () => {
      const dashboard = await this.dependencies.loadDashboard();
      // summarize requests for attention rather than prompt readiness
      const agents = dashboard.agents.map(agent => ({ id: agent.id, label: agentLabel(agent), attention: agentPresentationAttentionState(agent), unread: agent.unread }));
      const priority = { question: 0, working: 1, finished: 2 } as const;
      agents.sort((left, right) => priority[left.attention] - priority[right.attention] || left.label.localeCompare(right.label) || left.id.localeCompare(right.id));
      const state = agents.some(agent => agent.attention === 'question')
        ? 'question' as const
        : agents.some(agent => agent.attention === 'working')
          ? 'working' as const
          : agents.some(agent => agent.unread) ? 'completed' as const : 'idle' as const;
      const requiringAttention = agents.filter(agent => agent.attention !== 'finished' || agent.unread);
      const text = requiringAttention.length === 0
        ? 'No agents require attention.'
        : requiringAttention.map(agent => `${agent.label}: ${agent.attention === 'finished' && agent.unread ? 'completed' : agent.attention}`).join('\n');
      return success({ state, text, agents });
    });
  }

  // submit or durably queue one prompt through PromptService
  // (the Conductor's prompt is its own, and its Turn is reported back to it)
  async queuePrompt(input: QueuePromptInputV1): Promise<OrchestrationResult<{ accepted: true; prompt_id: string }>> {
    // reject malformed prompt requests
    if (!validIdentifier(input.agentId) || !validIntegrationPrompt(input.prompt)) return failure('invalid_request', 'Invalid prompt.');
    const conductor = this.dependencies.conductor;
    if (input.agentId === conductor) return failure('invalid_request', 'The Conductor cannot queue prompts to itself.');
    return await this.operation(async () => {
      const promptId = await this.dependencies.prompts.submitFrom(input.agentId, input.prompt, conductor === undefined ? {} : { from: conductor });
      return promptId === undefined ? failure('not_found', 'Agent is unavailable.') : success({ accepted: true as const, prompt_id: promptId });
    });
  }

  // update one queued prompt
  async updateQueuedPrompt(input: UpdateQueuedPromptInputV1): Promise<OrchestrationResult<QueuedPromptsV1['prompts'][number]>> {
    // reject malformed queue updates
    if (!validIdentifier(input.agentId) || !promptIdPattern.test(input.promptId) || !validIntegrationPrompt(input.prompt)) return failure('invalid_request', 'Invalid queued prompt update.');
    return await this.operation(async () => {
      if (!await this.mayChange(input.agentId, input.promptId)) return failure('not_found', 'Queued prompt not found.');
      const prompt = await this.dependencies.prompts.updateQueued(input.agentId, input.promptId, input.prompt);
      return prompt === undefined ? failure('not_found', 'Queued prompt not found.') : success(prompt);
    });
  }

  // move one queued prompt
  async moveQueuedPrompt(input: MoveQueuedPromptInputV1): Promise<OrchestrationResult<QueuedPromptsV1>> {
    // reject malformed queue moves
    if (!validIdentifier(input.agentId) || !promptIdPattern.test(input.promptId) || (input.direction !== 'earlier' && input.direction !== 'later')) return failure('invalid_request', 'Invalid queued prompt move.');
    return await this.operation(async () => {
      const prompts = await this.dependencies.prompts.moveQueued(input.agentId, input.promptId, input.direction);
      return prompts === undefined ? failure('not_found', 'Queued prompt not found.') : success({ prompts });
    });
  }

  // remove one queued prompt
  async removeQueuedPrompt(input: RemoveQueuedPromptInputV1): Promise<OrchestrationResult<{ removed: true }>> {
    // reject malformed queue removals
    if (!validIdentifier(input.agentId) || !promptIdPattern.test(input.promptId)) return failure('invalid_request', 'Invalid queued prompt removal.');
    return await this.operation(async () => await this.mayChange(input.agentId, input.promptId) && await this.dependencies.prompts.removeQueued(input.agentId, input.promptId, this.dependencies.conductor !== undefined)
      ? success({ removed: true as const })
      : failure('not_found', 'Queued prompt not found.'));
  }

  // answer one still-current Inline question (structured OMX or parsed list)
  async answerQuestion(input: AnswerQuestionInputV1): Promise<OrchestrationResult<{ answered: true }>> {
    // enforce Inline-question bounds
    if (!validIdentifier(input.agentId) || !questionIdPattern.test(input.questionId) || !Number.isInteger(input.index) || input.index < 0 || input.index > 15) return failure('invalid_request', 'Invalid question answer.');
    return await this.operation(async () => await this.dependencies.prompts.answerQuestion(input.agentId, input.questionId, input.index)
      ? success({ answered: true as const })
      : failure('not_found', 'Question not found.'));
  }

  // cancel current agent work without releasing queued prompts
  async cancel(agentId: string): Promise<OrchestrationResult<{ cancelled: true }>> {
    // reject malformed identifiers
    if (!validIdentifier(agentId)) return failure('invalid_request', 'Invalid agent identifier.');
    return await this.operation(async () => {
      // the Conductor cancels only a Turn it dispatched
      const conductor = this.dependencies.conductor;
      if (conductor !== undefined && this.dependencies.prompts.inFlight(agentId)?.sender.from !== conductor) return failure('conflict', 'The agent is not on a Turn you dispatched.');
      const outcome = await this.dependencies.prompts.cancel(agentId);
      // 'ok' interrupted; 'not-working' refused a finished agent; 'unavailable' had no target
      if (outcome === 'ok') return success({ cancelled: true as const });
      if (outcome === 'not-working') return failure('conflict', 'The agent is not working; there is nothing to interrupt.');
      return failure('not_found', 'Agent not found.');
    });
  }

  // launch one configured worktree
  async launchWorktree(worktreeId: string): Promise<OrchestrationResult<{ launched: true }>> {
    // require configured launch authority
    if (!validIdentifier(worktreeId)) return failure('invalid_request', 'Invalid worktree identifier.');
    // require one known worktree
    if (this.worktree(worktreeId) === undefined) return failure('not_found', 'Worktree not found.');
    return await this.operation(async () => await this.dependencies.launchWorktree(worktreeId)
      ? success({ launched: true as const })
      : failure('conflict', 'Worktree could not be launched.', true));
  }

  // launch one scratch agent through the injected safe launcher
  async launchScratch(): Promise<OrchestrationResult<{ launched: true }>> {
    return await this.operation(async () => await this.dependencies.launchScratch()
      ? success({ launched: true as const })
      : failure('conflict', 'Scratch agent could not be launched.', true));
  }

  // close only idle agents in configured worktrees
  async deactivate(agentId: string): Promise<OrchestrationResult<{ deactivated: true }>> {
    // reject malformed identifiers
    if (!validIdentifier(agentId)) return failure('invalid_request', 'Invalid agent identifier.');
    return await this.operation(async () => {
      const target = await this.dependencies.discovery.target(agentId);
      // require a current target
      if (target === undefined) return failure('not_found', 'Agent not found.');
      const configured = configuredWorktreeForWorkspace(this.dependencies.discovery.worktreesNow(), target.agent.home);
      const enriched = (await this.dependencies.loadDashboard()).agents.find(candidate => candidate.id === agentId);
      // protect scratch, working, and questioning agents
      if (configured === undefined || agentAttentionState(target.agent) !== 'finished' || (enriched !== undefined && agentAttentionState(enriched) !== 'finished')) return failure('conflict', 'Only idle configured agents can be deactivated.');
      return await this.dependencies.prompts.close(agentId)
        ? success({ deactivated: true as const })
        : failure('not_found', 'Agent not found.');
    });
  }

  // start the configured clean-worktree new-task transition
  async startNewTask(agentId: string): Promise<OrchestrationResult<{ started: true }>> {
    // reject malformed identifiers
    if (!validIdentifier(agentId)) return failure('invalid_request', 'Invalid agent identifier.');
    return await this.operation(async () => {
      const availability = await this.dependencies.newTasks.available(agentId);
      // distinguish unsupported worktrees
      if (availability === undefined) return failure('unavailable', 'New task is not configured.');
      // preserve the service's clean-and-pushed guard
      if (!availability.enabled) return failure('conflict', availability.reason ?? 'The worktree is not ready for a new task.');
      return await this.dependencies.newTasks.start(agentId)
        ? success({ started: true as const })
        : failure('conflict', 'The new task could not be started.', true);
    });
  }

  // run one explicitly configured stack action, on the whole stack or on one Stack process
  async runStackAction(input: RunStackActionInputV1): Promise<OrchestrationResult<{ started: true }>> {
    // enforce the fixed action vocabulary
    if (!validIdentifier(input.worktreeId) || !stackActions.includes(input.action) || (input.process !== undefined && !validIdentifier(input.process))) return failure('invalid_request', 'Invalid stack action.');
    // the Conductor starts, stops and restarts; it never builds or migrates
    if (this.dependencies.conductor !== undefined && !processActions.includes(input.action)) return failure('invalid_request', 'You may only start, stop or restart a stack.');
    return await this.operation(async () => {
      const worktree = this.worktree(input.worktreeId);
      // require an action configured for this worktree
      if (worktree === undefined) return failure('not_found', 'Worktree not found.');
      // reject actions absent from configuration
      if (!this.dependencies.worktreeCommands.actions(worktree).includes(input.action)) return failure('unavailable', 'Stack action is not configured.');
      // one process takes only its own actions, and only when the Worktree declares it
      if (input.process !== undefined && (!processActions.includes(input.action) || !Object.hasOwn(worktree.commands?.processes ?? {}, input.process))) return failure('unavailable', 'Stack process is not configured.');
      const result = await this.dependencies.worktreeCommands.start(input.worktreeId, input.action, input.process);
      // expose exclusive operation conflicts distinctly
      if (result === 'busy') return failure('conflict', 'Another stack action is already running.', true);
      return result === 'started' ? success({ started: true as const }) : failure('operation_failed', 'Stack action could not be started.', true);
    });
  }

  // start one bounded guided review job
  async startReview(input: StartReviewInputV1): Promise<OrchestrationResult<unknown>> {
    // require the fixed review scope and explicit booleans
    if (!validIdentifier(input.agentId) || (input.scope !== 'working' && input.scope !== 'pr') || typeof input.includeTests !== 'boolean' || typeof input.includeDocs !== 'boolean') return failure('invalid_request', 'Invalid review request.');
    // keep review generation disabled when no job adapter is configured
    const startReview = this.dependencies.startReview;
    // require the injected review boundary
    if (startReview === undefined) return failure('unavailable', 'Review generation is unavailable.');
    return await this.operation(async () => success(await startReview(input.agentId, { scope: input.scope, includeTests: input.includeTests, includeDocs: input.includeDocs }, this.dependencies.conductor)));
  }

  // spawn a worker for the Conductor in one Worktree within its scope
  async spawnAgent(input: { worktreeId: string; model?: string }): Promise<OrchestrationResult<{ agent_id: string }>> {
    const { conductor, spawnWorker } = this.dependencies;
    if (!validIdentifier(input.worktreeId)) return failure('invalid_request', 'Invalid worktree identifier.');
    if (conductor === undefined || spawnWorker === undefined) return failure('unavailable', 'Only the Conductor spawns workers.');
    if (this.worktree(input.worktreeId) === undefined) return failure('not_found', 'Worktree not found.');
    return await this.operation(async () => {
      const spawned = await spawnWorker(input.worktreeId, conductor, input.model);
      if (spawned === 'not-allowed') return failure('invalid_request', 'That model is not one of the operator\'s Allowed models.');
      if (spawned === 'at-capacity') return failure('conflict', 'You already have your most live workers: close one first.');
      return spawned === undefined ? failure('operation_failed', 'The worker could not be started.', true) : success({ agent_id: spawned });
    });
  }

  // the Conductor and its Watches, or why these operations are not offered
  private watching(): { owner: string; watches: NonNullable<OrchestrationDependencies['watches']> } | OrchestrationResult<never> {
    const { conductor, watches } = this.dependencies;
    return conductor === undefined || watches === undefined ? failure('unavailable', 'Only the Conductor sets Watches.') : { owner: conductor, watches };
  }

  // a Watch set, or the reason it was not; GitHub's own failure is said as GitHub said it
  private async watched<T extends object>(work: () => Promise<T | WatchRefusal>): Promise<OrchestrationResult<T>> {
    return await this.operation(async () => {
      try {
        const result = await work();
        return 'refused' in result ? failure('conflict', result.refused) : success(result);
      } catch (error) {
        if (error instanceof GithubRequestError) return failure('unavailable', error.message, error.kind === 'transient');
        throw error;
      }
    });
  }

  // a Worktree in scope, or why there is none
  private scopedWorktree(worktreeId: string): Worktree | OrchestrationResult<never> {
    if (!validIdentifier(worktreeId)) return failure('invalid_request', 'Invalid worktree identifier.');
    return this.worktree(worktreeId) ?? failure('not_found', 'Worktree not found.');
  }

  // the GitHub repository a Worktree in scope pushes to, or why there is none
  private async repositoryAt(worktreeId: string): Promise<GithubRepository | OrchestrationResult<never>> {
    const worktree = this.scopedWorktree(worktreeId);
    if ('ok' in worktree) return worktree;
    return await originRepository(worktree.path) ?? failure('invalid_request', 'The worktree has no GitHub origin.');
  }

  async watchPullRequest(input: { worktreeId: string; number: number }): Promise<OrchestrationResult<unknown>> {
    const watching = this.watching();
    if ('ok' in watching) return watching;
    const repository = await this.repositoryAt(input.worktreeId);
    if ('ok' in repository) return repository;
    return await this.watched(() => watching.watches.watchPullRequest(watching.owner, repository, input.number));
  }

  async watchReviewRequests(worktreeId: string): Promise<OrchestrationResult<unknown>> {
    const watching = this.watching();
    if ('ok' in watching) return watching;
    const repository = await this.repositoryAt(worktreeId);
    if ('ok' in repository) return repository;
    return await this.watched(() => watching.watches.watchReviewRequests(watching.owner, repository));
  }

  async watchProcess(input: { worktreeId: string; process: string }): Promise<OrchestrationResult<unknown>> {
    const watching = this.watching();
    if ('ok' in watching) return watching;
    const worktree = this.scopedWorktree(input.worktreeId);
    if ('ok' in worktree) return worktree;
    if (!declaredProcesses(worktree.commands).some(process => process.name === input.process)) return failure('not_found', 'The worktree declares no such Stack process.');
    return await this.watched(() => watching.watches.watchProcess(watching.owner, worktree.id, input.process, worktree.label));
  }

  async watchCommand(input: { command: string; description: string }): Promise<OrchestrationResult<unknown>> {
    const watching = this.watching();
    if ('ok' in watching) return watching;
    return await this.watched(() => watching.watches.watchCommand(watching.owner, input.command, input.description));
  }

  async listWatches(): Promise<OrchestrationResult<unknown>> {
    const watching = this.watching();
    if ('ok' in watching) return watching;
    return await this.operation(async () => success({ watches: (await watching.watches.list(watching.owner)).map(({ id, kind, description, createdAt }) => ({ watch_id: id, kind, description, created_at: createdAt })) }));
  }

  async unwatch(watchId: string): Promise<OrchestrationResult<{ removed: true }>> {
    const watching = this.watching();
    if ('ok' in watching) return watching;
    if (!validIdentifier(watchId)) return failure('invalid_request', 'Invalid watch identifier.');
    return await this.operation(async () => await watching.watches.remove(watching.owner, watchId) ? success({ removed: true as const }) : failure('not_found', 'Watch not found.'));
  }

  // close one worker the Conductor spawned, never another Agent; its queue becomes Notes
  async closeAgent(agentId: string): Promise<OrchestrationResult<{ closed: true }>> {
    const conductor = this.dependencies.conductor;
    if (!validIdentifier(agentId)) return failure('invalid_request', 'Invalid agent identifier.');
    if (conductor === undefined) return failure('unavailable', 'Only the Conductor closes its workers.');
    return await this.operation(async () => {
      const agent = (await this.dependencies.loadDashboard()).agents.find(candidate => candidate.id === agentId);
      if (agent === undefined) return failure('not_found', 'Agent not found.');
      if (agent.structured?.spawnedBy !== conductor) return failure('conflict', 'You can close only workers you spawned.');
      return await this.dependencies.prompts.close(agentId) ? success({ closed: true as const }) : failure('not_found', 'Agent not found.');
    });
  }

  // a Note store and its key for a Worktree in scope
  private async notesAt(worktreeId: string): Promise<{ notes: NoteFacade; key: string } | undefined> {
    const notes = this.dependencies.notes;
    const key = notes === undefined || this.worktree(worktreeId) === undefined ? undefined : await notes.key(worktreeId);
    return notes === undefined || key === undefined ? undefined : { notes, key };
  }

  // list one Worktree's Notes, each saying whether it is the Conductor's
  async listNotes(worktreeId: string): Promise<OrchestrationResult<{ notes: Array<{ id: string; title?: string; text: string; mine: boolean; schedule?: { cron: string; enabled: boolean; conductor: boolean } }> }>> {
    if (!validIdentifier(worktreeId)) return failure('invalid_request', 'Invalid worktree identifier.');
    return await this.operation(async () => {
      const at = await this.notesAt(worktreeId);
      const notes = at === undefined ? undefined : await at.notes.store.list(at.key);
      if (notes === undefined) return failure('not_found', 'Worktree not found.');
      return success({ notes: notes.map(note => ({ id: note.id, ...(note.title === undefined ? {} : { title: note.title }), text: redactIntegrationText(note.text), mine: note.source === 'conductor', ...(note.schedule === undefined ? {} : { schedule: { cron: note.schedule.cron, enabled: note.schedule.enabled, conductor: 'conductor' in note.schedule.target } }) })) });
    });
  }

  // create a Note the Conductor owns until the operator saves it
  async createNote(input: { worktreeId: string; title: string; text: string }): Promise<OrchestrationResult<{ note_id: string }>> {
    if (this.dependencies.conductor === undefined) return failure('unavailable', 'Only the Conductor writes Notes.');
    if (!validIdentifier(input.worktreeId)) return failure('invalid_request', 'Invalid worktree identifier.');
    return await this.operation(async () => {
      const at = await this.notesAt(input.worktreeId);
      if (at === undefined) return failure('not_found', 'Worktree not found.');
      const note = await at.notes.store.createWithText(at.key, input.title, input.text, 'conductor');
      if (note === undefined) return failure('conflict', 'The Note could not be created: the notes limit is reached.');
      at.notes.changed();
      return success({ note_id: note.id });
    });
  }

  // run `change` on a Note the Conductor owns; one that is the operator's is refused
  private async ownNote<T>(worktreeId: string, noteId: string, change: (at: { notes: NoteFacade; key: string }) => Promise<OrchestrationResult<T>>): Promise<OrchestrationResult<T>> {
    if (this.dependencies.conductor === undefined) return failure('unavailable', 'Only the Conductor writes Notes.');
    if (!validIdentifier(worktreeId) || !validIdentifier(noteId)) return failure('invalid_request', 'Invalid note identifier.');
    return await this.operation(async () => {
      const at = await this.notesAt(worktreeId);
      const note = at === undefined ? undefined : await at.notes.store.resolve(at.key, noteId);
      if (at === undefined || note === undefined) return failure('not_found', 'Note not found.');
      if (note.note.source !== 'conductor') return failure('conflict', 'That Note is the operator\'s: you may change only Notes you wrote that the operator has not saved.');
      const result = await change(at);
      if (result.ok) at.notes.changed();
      return result;
    });
  }

  async updateNote(input: { worktreeId: string; noteId: string; title?: string; text?: string }): Promise<OrchestrationResult<{ updated: true }>> {
    return await this.ownNote(input.worktreeId, input.noteId, async ({ notes, key }) => {
      if (input.title !== undefined && await notes.store.rename(key, input.noteId, input.title, 'conductor') === undefined) return failure('conflict', 'The Note could not be renamed.');
      if (input.text !== undefined && await notes.store.update(key, input.noteId, input.text, 'conductor') === undefined) return failure('conflict', 'The Note could not be updated.');
      return success({ updated: true as const });
    });
  }

  async deleteNote(input: { worktreeId: string; noteId: string }): Promise<OrchestrationResult<{ deleted: true }>> {
    return await this.ownNote(input.worktreeId, input.noteId, async ({ notes, key }) => {
      const deleted = await notes.remove(key, input.noteId);
      return typeof deleted === 'object' && deleted !== null ? success({ deleted: true as const }) : failure('conflict', 'The Note could not be deleted (it is locked, or its Schedule is running).');
    });
  }

  // aim a Schedule on one of the Conductor's own Notes at the Conductor
  async scheduleNote(input: { worktreeId: string; noteId: string; cron: string; enabled: boolean }): Promise<OrchestrationResult<{ scheduled: true }>> {
    return await this.ownNote(input.worktreeId, input.noteId, async ({ notes, key }) => {
      const schedule = notes.conductorSchedule(input.cron, input.enabled);
      if (typeof schedule === 'string') return failure('invalid_request', schedule);
      return await notes.store.setSchedule(key, input.noteId, schedule, 'conductor') === undefined ? failure('conflict', 'The Schedule could not be set.') : success({ scheduled: true as const });
    });
  }

  // switch one clean worktree to an available pull request
  async switchPullRequest(input: SwitchPullRequestInputV1): Promise<OrchestrationResult<{ switched: true }>> {
    // enforce positive GitHub pull request numbers
    if (!validIdentifier(input.agentId) || !Number.isSafeInteger(input.number) || input.number < 1) return failure('invalid_request', 'Invalid pull request switch.');
    return await this.operation(async () => {
      const worktreeId = (await this.dependencies.loadDashboard()).agents.find(candidate => candidate.id === input.agentId)?.worktreeId;
      if (worktreeId === undefined) return failure('not_found', 'Agent worktree not found.');
      const result = await this.dependencies.pullRequests.switch(worktreeId, input.number);
      if (result === 'switched') return success({ switched: true as const });
      return failure('conflict', result === 'busy' ? 'The agent is busy; wait for it to finish before switching.' : result.error);
    });
  }
}
