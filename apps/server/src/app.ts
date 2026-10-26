import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import staticPlugin from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { ValidatedConfig } from './config/schema.js';
import { registerHealthRoute } from './settings/health-proof.js';
import { AuthService, type Session } from './auth/service.js';
import { ControlService } from './auth/control.js';
import { DeviceService } from './auth/devices.js';
import { TicketStore } from './auth/tickets.js';
import { DiscoveryService } from './discovery/service.js';
import { adapterFor } from './adapters/registry.js';
import { agentKinds, codexFamily, sameConversation, type Adapter, type AgentKind, type ConversationSummary, type InlineQuestion, type PaneSnapshot, type ResetSettling } from './adapters/types.js';
import { TmuxCommandRegistry } from './tmux/command-registry.js';
import { TmuxAdapter } from './tmux/adapter.js';
import { maxPromptAttachmentBytes, PromptService, promptScope, type PromptAttachment } from './prompts/service.js';
import { promptAttachmentBytes, promptAttachmentData, promptAttachmentName, validPrompt, validPromptAttachments } from './prompts/validation.js';
import { QueuedPromptService, type QueuedPrompt, type QueuedPromptOrigin } from './prompts/queue.js';
import { LaunchService, type TmuxSession } from './launch/service.js';
import { launchFresh, managedRunProgress, type FreshLaunchFailure, type ReadinessOutcome } from './launch/managed-run.js';
import { atPlace, createAgentWaiter, inWorktree, reviewRunAgent, launchPollAttempts, launchPollDelay as defaultLaunchPollDelay, launchPollIntervalMs, launchReadyTimeoutSeconds } from './launch/wait.js';
import { scratchLaunchKey, WorktreeLaunchStore } from './worktrees/store.js';
import { OpenedFolderStore, resolveFolderPath } from './places/opened-folders.js';
import { folderNoteKey, placeLaunchScope, placeNoteKey, worktreePlace, type Place } from './places/places.js';
import { safeEnv } from './tmux/command.js';
import { PushService } from './push-service.js';
import { processActions, WorktreeCommandService } from './worktree-commands/service.js';
import { PullRequestLookupError } from './pull-requests/service.js';
import { PullRequestSwitchService } from './pull-requests/switch-service.js';
import { NewTaskService } from './new-task/service.js';
import { WorktreeManagementService } from './worktrees/management.js';
import { agentAttentionState, AgentNotificationCoordinator, reviewNotification, scheduleNotification, type AgentNotificationContext } from './notifications.js';
import { agentTmuxSession, isReviewRun, stackActions, worktreeAgents, type Agent, type Pane, type SocketRef, type StackAction, type Worktree } from './domain/models.js';
import { CommandCatalogService } from './commands/service.js';
import { LatestViewportScheduler, PaneViewportCoordinator } from './logs/viewport-scheduler.js';
import { boundedViewport } from './logs/viewport.js';
import { PaneStreamRegistry, type PaneStreamProvider } from './tmux/control.js';
import { dashboardFingerprint, DashboardUpdates, type DashboardPayload } from './dashboard/updates.js';
import { WorktreeNoteService, type WorktreeNote } from './notes/service.js';
import { promptNoteContent } from './notes/from-prompt.js';
import { cronError, previewRuns, scheduleNextRun } from './schedule/cron.js';
import { Scheduler } from './schedule/scheduler.js';
import { type Schedule, type ScheduleLastRun, type ScheduleRunStatus, type ScheduleTarget, validScheduleTarget } from './schedule/types.js';
import { CleanupService } from './cleanup/service.js';
import { PromptHistoryService } from './prompt-history/service.js';
import { ProjectProxy } from './project-proxy.js';
import { TemporaryPreviewAccess, temporaryPreviewCookie } from './temporary-previews/access.js';
import { TemporaryPreviewProxy } from './temporary-previews/proxy.js';
import { TemporaryPreviewService } from './temporary-previews/service.js';
import { ConfiguredReviewTourGenerator } from './review-tour/generator.js';
import { HeadlessReviewRunner } from './review-runs/headless.js';
import { byReviewAgentKind, reviewRunsFor } from './review-runs/kinds.js';
import { ModeDispatchReviewRunner } from './review-runs/dispatch.js';
import { beginReplyTurn, latestReply } from './review-runs/final-reply.js';
import { InteractiveReviewRunner } from './review-runs/interactive.js';
import { mcpDisableArgs } from './review-runs/launch-args.js';
import { isReviewRunName, type ReviewRunner } from './review-runs/runner.js';
import { CodeReviewer } from './code-review/reviewer.js';
import { CodeReviewJobs } from './code-review/jobs.js';
import { parseCodeReviewAdd, parseReviewTourStart } from './code-review/contracts.js';
import { AskJobs } from './asks/jobs.js';
import { ASK_REQUEST_BODY_BYTES, parseAskRequest, parseChangeAskRequest } from './asks/contracts.js';
import { ChangeAsks, ChangeAskStore } from './asks/changes.js';
import { ReviewTourService } from './review-tour/service.js';
import { parsePullRequestReviewInput, PR_REVIEW_REQUEST_BODY_BYTES, PullRequestReviewError, PullRequestReviewService } from './review-tour/pr-review.js';
import { ReviewTourJobs, startedReviewJob } from './review-tour/jobs.js';
import { ReviewTourStore } from './review-tour/store.js';
import { INTERACTIVE_REVIEW_GENERATION_TIMEOUT_MS, parseReviewRequestId, parseReviewTourInput, REVIEW_GENERATION_TIMEOUT_MS, REVIEW_REQUEST_BODY_BYTES, ReviewTourError, type ReviewErrorCode, type ReviewTourInput, type StoredReviewTourSummary } from './review-tour/contracts.js';
import { configuredWorktreeForWorkspace, projectIdOf, worktreeById, worktreeHostRoot, worktreeMatchesWorkspace, worktreePathOf, worktreePrBase, worktreeWireId } from './workspaces/resolver.js';
import { previewFileBytes, WorkspaceFileService } from './workspace-files/service.js';
import { ComparisonService, type ComparisonScope } from './git/comparison-service.js';
import { mergeBaseChoices, saveMergeBase } from './git/comparison.js';
import { loadInstanceIconSvg, isInstanceIcon, type InstanceIcon } from './instance-icon.js';
import { instanceAttention, RemoteInstanceStatusPoller, validInstanceStatusRequest, type InstanceStatus } from './instance-status.js';
import { createHmac, randomBytes } from 'node:crypto';
import { integrationConfigForRemotes, parseDavoSettings, resolveAgentProgram, reviewConfig } from './config/schema.js';
import { OrchestrationService } from './orchestration/index.js';
import { IntegrationAuthService, registerIntegrationAuthServer, type IntegrationScope, type LocalIntegrationSubject } from './integrations/auth/index.js';
import { IntegrationPolicyService } from './integrations/policy/service.js';
import { IntegrationAuditService } from './integrations/audit/service.js';
import { IntegrationGateway, registerMcpServer } from './integrations/mcp/index.js';
import { RealtimeService } from './integrations/realtime/service.js';
import { federationForwarder, verifyFederationRequest } from './integrations/federation/index.js';
import { IntegrationControlService } from './integrations/control/index.js';
import { ServerAdminService } from './server-admin/service.js';
import { ApiKeySpendService } from './accounts/spend.js';
import { readClaudeAccount } from './accounts/claude.js';
import { CodexAccountService, normalizeAccountLabel, normalizeApiKey, safeAccountId, UnsupportedAccountOperationError, type AccountRateLimitWindow, type AccountSummary } from './accounts/index.js';
import { ConsoleNamedConversationService, type ConsoleNamedConversation } from './conversations/console-named-service.js';
import { isUpdateAdvisorForTarget, isUpdateAdvisorLabel, updateAdvisorLabel, updateAdvisorPendingLabel } from './update-advisor.js';
import { isFullGitSha } from './git/revision.js';
import { AgentUpdateService, type AgentUpdateServiceLike } from './agent-updates/service.js';
import { HostFilesService } from './host-files/service.js';
import { serverCheckout, serverCheckoutOnHost } from './workspaces/server-checkout.js';
import { createRuntimeHostFiles } from './host-files/runtime.js';
import { registerHostFilesRoutes } from './host-files/routes.js';
import { HostFilesError } from './host-files/contracts.js';
import { HostFilesTransportError } from './host-files/protocol.js';
import { browserKeysConfig, terminalBindingCommand, terminalProgramName } from './config/keys.js';
import { SettingsError } from './settings/contracts.js';
import { SettingsService } from './settings/service.js';
import { registerSettingsRoutes } from './settings/routes.js';
import { ConfiguredButtonCatalog } from './button-actions/catalog.js';
import { ButtonActionError, ButtonActionService, buttonActionInputSchema } from './button-actions/service.js';
import { HostCommandRunner } from './button-actions/host-command-runner.js';
import { defaultGoogleCalendarConfig, type CalendarLabels } from './google-calendar/contracts.js';
import { createGoogleCalendarService } from './google-calendar/runtime.js';
import type { GoogleCalendarService } from './google-calendar/service.js';
import { createGoogleCalendarLifecycle, type PromptCalendarLifecycle } from './google-calendar/lifecycle.js';
import { registerGoogleCalendarRoutes } from './google-calendar/routes.js';
import { calendarLabelsForAgent } from './google-calendar/labels.js';
import { renderNotFoundPage, renderPublicPolicyPage } from './public-pages.js';

export type Dependencies = { googleCalendar?: GoogleCalendarService; calendarLifecycle?: PromptCalendarLifecycle; buttonActions?: ButtonActionService; settings?: SettingsService; auth?: AuthService; control?: ControlService; devices?: DeviceService; discovery?: DiscoveryService; tmux?: TmuxAdapter; tickets?: TicketStore; launch?: LaunchService; launchPollDelay?: () => Promise<void>; conversationNamePollDelay?: () => Promise<void>; push?: PushService; notifications?: AgentNotificationCoordinator; prSwitch?: PullRequestSwitchService; newTask?: NewTaskService; promptHistory?: PromptHistoryService; queuedPrompts?: QueuedPromptService; prompts?: PromptService; notes?: WorktreeNoteService; consoleNamed?: ConsoleNamedConversationService; commandCatalog?: CommandCatalogService; cleanup?: CleanupService; dashboardUpdates?: DashboardUpdates<DashboardPayload>; reviewTours?: ReviewTourService; pullRequestReviews?: PullRequestReviewService; reviewStore?: ReviewTourStore; changeAskStore?: ChangeAskStore; reviewRunner?: ReviewRunner; workspaceFiles?: WorkspaceFileService; hostFiles?: HostFilesService; comparison?: ComparisonService; serverAdmin?: ServerAdminService; accounts?: CodexAccountService; claudeAccount?: () => Promise<AccountSummary>; accountSpend?: ApiKeySpendService; instanceStatusPoller?: Pick<RemoteInstanceStatusPoller, 'statuses'>; worktreeStore?: WorktreeLaunchStore; openedFolders?: OpenedFolderStore; worktreeManagement?: WorktreeManagementService; worktreeCommands?: WorktreeCommandService; agentUpdates?: AgentUpdateServiceLike; temporaryPreviews?: Pick<TemporaryPreviewService, 'resolve'>; scheduleBootAt?: Date; paneStream?: PaneStreamProvider };
// buildApp decorates the returned instance with the Schedule scheduler, so index.ts can start it and
// the HTTP-seam tests can drive its `tick(now)` over the same fakes the Run routes use.
declare module 'fastify' {
  interface FastifyInstance { scheduler: Scheduler }
}
// how long a pane must be quiet after output before its live frame is captured
const logQuietWindowMs = 250;
const body = (request: FastifyRequest): Record<string, unknown> => (request.body && typeof request.body === 'object' ? request.body as Record<string, unknown> : {});
// a path relative to a Place's folder that cannot climb out of it: no leading `/`, no `..`
// segment, and nothing a shell line or tmux could misread
const isPlaceRelativeFile = (value: unknown): value is string => typeof value === 'string' && value !== '' && value.length <= 4096 && !/[\0\r\n]/u.test(value) && !value.startsWith('/') && !value.split('/').includes('..');
// the configured editor's command line, opening one fixed relative or absolute `file` at `line`
// with the `+N file` convention vim, nvim, emacs, nano, micro and kakoune share
const editorCommand = (editor: string, file?: string, line?: number): string => {
  if (file === undefined) return editor;
  // `./` keeps a path that begins with `-` from reading as an option
  const path = `'${(file.startsWith('-') ? `./${file}` : file).replaceAll("'", "'\\''")}'`;
  return line === undefined ? `${editor} ${path}` : `${editor} +${line} ${path}`;
};
// the requested Comparison kind, or undefined when the body names neither Working nor All PR
const comparisonScope = (request: FastifyRequest, from: Record<string, unknown> = body(request)): ComparisonScope | undefined => {
  const { kind, commit } = from;
  if (kind === 'working' || kind === 'pr') return kind;
  return kind === 'commit' && typeof commit === 'string' ? { commit } : undefined;
};
// one Named conversation on the wire: the Adapter's summary tagged with its kind, plus the
// server-resolved Worktree, console-named flag, whether a Tour or Review run named it, and
// whether it is the current Conversation
type ConversationRow = ConversationSummary & { kind: AgentKind; worktreeId?: string; consoleNamed: boolean; reviewRun: boolean; current: boolean };
// parse an optional launch kind from a request body; a present-but-unknown value is rejected
const requestedKind = (request: FastifyRequest): { kind?: AgentKind; invalid?: true } => {
  const value = body(request).kind;
  if (value === undefined) return {};
  return (agentKinds as readonly string[]).includes(value as string) ? { kind: value as AgentKind } : { invalid: true };
};
// parse attachment records without imposing a file-count limit
const promptAttachments = (value: unknown): PromptAttachment[] | undefined => {
  // treat an omitted collection as empty
  if (value === undefined) return [];
  // require the attachment collection shape
  if (!Array.isArray(value)) return undefined;
  // parse every attachment record
  const attachments = value.map(candidate => candidate !== null && typeof candidate === 'object' && typeof (candidate as { name?: unknown }).name === 'string' && typeof (candidate as { data?: unknown }).data === 'string' ? candidate as PromptAttachment : undefined);
  // reject any malformed record
  return attachments.some(attachment => attachment === undefined) ? undefined : attachments as PromptAttachment[];
};
// allow one maximum attachment request plus json/base64 overhead
const noteAttachmentBodyLimit = Math.ceil(maxPromptAttachmentBytes * 1.4);
// how long Open folder looks for a first screen blocking its launch (Claude draws its trust
// prompt within about two seconds): ten seconds of the launch poll
const openFolderReadinessAttempts = 10_000 / launchPollIntervalMs;
// build the console server
export async function buildApp(config: ValidatedConfig, deps: Dependencies = {}): Promise<FastifyInstance> {
  // initialize optional calendar delivery without affecting core readiness
  const googleCalendar = deps.googleCalendar ?? await createGoogleCalendarService({
    config: config.googleCalendar ?? defaultGoogleCalendarConfig,
    publicOrigin: config.publicOrigin.origin,
    ...(process.env.RAC_GOOGLE_CALENDAR_AUTH_FILE === undefined ? {} : { authPath: process.env.RAC_GOOGLE_CALENDAR_AUTH_FILE }),
    ...(process.env.RAC_GOOGLE_CALENDAR_ACTIVITIES_FILE === undefined ? {} : { activitiesPath: process.env.RAC_GOOGLE_CALENDAR_ACTIVITIES_FILE })
  });
  // avoid touching lifecycle files on installations that have not enabled capture
  const calendarLifecycle = deps.calendarLifecycle ?? (config.googleCalendar?.enabled === true ? createGoogleCalendarLifecycle({
    sink: googleCalendar,
    // resolve only safe configured labels and closed adapter names
    labels: async (agentId): Promise<CalendarLabels> => {
      const agent = (await discovery.target(agentId))?.agent;
      return calendarLabelsForAgent(agent, discovery.worktreesNow(), discovery.projectsNow());
    }
  }) : undefined);

  // stage bridged scratch attachments in the existing shared checkout
  const attachmentStaging = process.env.RAC_HOST_TMUX_DIR === undefined ? undefined : {
    workspace: serverCheckout(),
    hostWorkspace: serverCheckoutOnHost(config.projects, process.env.RAC_HOST_REPOSITORY?.trim() || process.env.RAC_HOST_WORKSPACE)
  };
  const auth = deps.auth ?? new AuthService(process.env.RAC_PASSWORD_HASH ?? '', process.env.RAC_SESSION_SECRET ?? ''); const control = deps.control ?? new ControlService(); const devices = deps.devices ?? new DeviceService(); const tmux = deps.tmux ?? new TmuxAdapter(new TmuxCommandRegistry()); const worktreeStore = deps.worktreeStore ?? new WorktreeLaunchStore(); const openedFolders = deps.openedFolders ?? new OpenedFolderStore(); const discovery = deps.discovery ?? new DiscoveryService(undefined, tmux, undefined, undefined, config.adapters, config.projects, worktreeStore, undefined, config.scratchDirectory); const tickets = deps.tickets ?? new TicketStore(); const launch = deps.launch ?? new LaunchService(config, undefined, tmux, undefined, worktreeStore, () => discovery.worktreesNow(), () => paneStream.openPaneKeys(), async placeId => await placeAgentSession(placeId)); const promptHistory = deps.promptHistory ?? new PromptHistoryService(); const queuedPrompts = deps.queuedPrompts ?? new QueuedPromptService(); const prompts = deps.prompts ?? new PromptService(discovery, tmux, promptHistory, queuedPrompts, (scope: string, prompt: QueuedPrompt) => drainUndelivered(scope, prompt), undefined, kind => config.adapters[kind]?.teardown, attachmentStaging, calendarLifecycle); const notes = deps.notes ?? new WorktreeNoteService(); const consoleNamed = deps.consoleNamed ?? new ConsoleNamedConversationService(); const commandCatalog = deps.commandCatalog ?? new CommandCatalogService(); const workspaceFiles = deps.workspaceFiles ?? new WorkspaceFileService(); const comparison = deps.comparison ?? new ComparisonService(async worktreeId => worktreePrBase(await discovery.dashboard(), worktreeId)); const push = deps.push ?? new PushService(); const notifications = deps.notifications ?? new AgentNotificationCoordinator(() => {}); const prSwitch = deps.prSwitch ?? new PullRequestSwitchService(config, discovery); const worktreeManagement = deps.worktreeManagement ?? new WorktreeManagementService(() => discovery.projectsNow(), undefined, undefined, prSwitch); const cleanup = deps.cleanup ?? new CleanupService(discovery, undefined, tmux, undefined, worktreeManagement); const stackCommands = deps.worktreeCommands ?? new WorktreeCommandService(config, discovery); const newTask = deps.newTask ?? new NewTaskService(config, discovery, tmux); const dashboardUpdates = deps.dashboardUpdates ?? new DashboardUpdates<DashboardPayload>(dashboardFingerprint); const codexProgram = resolveAgentProgram(config, 'codex'); const review = reviewConfig(config); const interactiveRunner = interactiveReviewRunner(); const reviewRunner = deps.reviewRunner ?? new ModeDispatchReviewRunner(review.agents, byReviewAgentKind(kind => new HeadlessReviewRunner(reviewRunsFor(kind).headless, resolveAgentProgram(config, kind) ?? '')), interactiveRunner); const reviewTours = deps.reviewTours ?? new ReviewTourService(discovery, new ConfiguredReviewTourGenerator(reviewRunner, review.tour, review.agents[review.tour.agent].mode === 'interactive' ? INTERACTIVE_REVIEW_GENERATION_TIMEOUT_MS : REVIEW_GENERATION_TIMEOUT_MS)); const reviewStore = deps.reviewStore ?? new ReviewTourStore(); const serverAdmin = deps.serverAdmin ?? new ServerAdminService(config);
  const temporaryPreviews = deps.temporaryPreviews ?? new TemporaryPreviewService();
  // publish only boot-opaque presentations of trusted configured actions
  const buttonCatalog = deps.buttonActions?.catalog ?? new ConfiguredButtonCatalog(config);
  // create Files lazily so missing host prerequisites affect only Files requests
  const hostFiles = deps.hostFiles ?? createRuntimeHostFiles(config);
  // posts a tour's feedback to the branch's pull request against the tour's current Comparison
  const pullRequestReviews = deps.pullRequestReviews ?? new PullRequestReviewService(async (agentId, input) => await reviewTours.current(agentId, input));
  // freeze the checkout identity serving this process
  const deployedRevision = serverAdmin.revision();
  // a settled Code review refreshes the dashboard so its indicator follows
  const codeReviewer = new CodeReviewer(reviewRunner, review);
  // questions about a stored tour's Findings, asked of the Code review's own conversation
  const asks = new AskJobs(reviewRunner, reviewStore, () => review.presets);
  // questions about a Code panel's Comparison, asked of the tour guide or the scope's own diff conversation
  const changeAskStore = deps.changeAskStore ?? new ChangeAskStore();
  const changeAsks = new ChangeAsks(asks, changeAskStore, () => review.tour);
  // a review that lands replaces the one the Worktree's questions were asked of
  const codeReviews = new CodeReviewJobs(codeReviewer, reviewStore, async settled => { if (settled.state.kind === 'ready') void asks.supersedeWorktree(settled.worktreeId, 'reviewer'); await dashboardUpdates.refresh().catch(() => undefined); });
  const reviewJobs = new ReviewTourJobs(reviewTours, reviewStore, async review => {
    const worktree = review.prepared.resolved.worktree;
    const projectName = discovery.projectsNow().find(project => project.id === worktree.projectId)?.label ?? worktree.label;
    // refresh dashboard state and push independently
    await Promise.all([
      dashboardUpdates.refresh().then(() => undefined).catch(() => undefined),
      push.notify(reviewNotification(review.agentId, review.worktreeId, projectName, worktree.label)).then(() => undefined).catch(() => undefined)
    ]);
  }, codeReviews, asks);
  const reviewTourCapability = await reviewTours.capability();
  const codeReviewCapability = await codeReviewer.capability();
  const accountSpend = deps.accountSpend ?? new ApiKeySpendService();
  const accounts = deps.accounts ?? new CodexAccountService({ ...(codexProgram === undefined ? {} : { codexProgram }) });
  const claudeAccount = deps.claudeAccount ?? (() => readClaudeAccount());
  // tolerate narrow launch doubles while deriving the production launch account home
  const launchHome = typeof launch.agentHome === 'function' ? launch.agentHome() : process.env.HOME ?? '/';
  const agentUpdates = deps.agentUpdates ?? new AgentUpdateService(config, launchHome);
  const paneViewports = new PaneViewportCoordinator();
  // one tmux control-mode client per session, shared by every viewer, drives the
  // event-driven log frames (ADR 0008)
  const paneStream: PaneStreamProvider = deps.paneStream ?? new PaneStreamRegistry();
  const updateAdvisors = new Map<string, string>();
  const updateAdvisorLifecycles = new Map<string, Promise<void>>();
  // serialize launch and stop operations for one reviewed target
  const withUpdateAdvisorLifecycle = async <T>(targetSha: string, operation: () => Promise<T>): Promise<T> => {
    const previous = updateAdvisorLifecycles.get(targetSha) ?? Promise.resolve();
    let release = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.catch(() => undefined).then(async () => await gate);
    updateAdvisorLifecycles.set(targetSha, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      // discard only the final queued lifecycle
      if (updateAdvisorLifecycles.get(targetSha) === tail) updateAdvisorLifecycles.delete(targetSha);
    }
  };
  let accountSwitching = false;
  let notesRevision = 0;
  // derive peer forwarding independently of the legacy saved toggle
  const integrationConfig = structuredClone(integrationConfigForRemotes(config.integrations, config.remoteServers));
  const davoAvailable = integrationConfig.enabled && Boolean(process.env.RAC_OPENAI_API_KEY?.trim());
  // expose one secret-free voice settings snapshot
  const publicDavoSettings = () => ({ enabled: integrationConfig.realtime.enabled, available: davoAvailable, name: integrationConfig.realtime.name, context: integrationConfig.realtime.context });
  // prefer a dedicated federation secret while retaining existing deployments
  const instanceStatusSecret = process.env.RAC_INSTANCE_STATUS_SECRET ?? process.env.RAC_SESSION_SECRET ?? '';
  const instanceStatusPoller = deps.instanceStatusPoller ?? new RemoteInstanceStatusPoller(instanceStatusSecret);
  const projectProxy = new ProjectProxy(() => discovery.worktreesNow(), config.publicOrigin.origin, process.env.RAC_PROJECT_PROXY_HOST);
  const temporaryPreviewProxy = new TemporaryPreviewProxy();
  const temporaryPreviewAccess = new TemporaryPreviewAccess();
  // A Worktree id carries its whole percent-encoded path, which outgrows the router's default 100
  // character parameter cap (a GET then falls to the static 404, others get 414). Node's 16 KiB
  // request-head limit already bounds the URL, and no route uses a regex parameter.
  const app = Fastify({ logger: false, trustProxy: false, bodyLimit: 65_536, routerOptions: { maxParamLength: 16_384 } }); const webRoot = fileURLToPath(new URL('../../web/dist', import.meta.url));
  // The UI version is the hashed app bundle: match the module script specifically so
  // other head scripts (e.g. the pre-paint /theme-init.js) can precede it in the HTML.
  const uiVersion = async () => await readFile(join(webRoot, 'index.html'), 'utf8').then(html => /<script[^>]+type="module"[^>]+src="([^"]+)"/u.exec(html)?.[1]).catch(() => undefined); await app.register(cookie); await app.register(staticPlugin, { root: webRoot, index: false }); await app.register(rateLimit, { global: false });
  // A pane-socket `input` frame carries up to 64 KiB of decoded bytes (spec "The pane
  // socket"), which is ~87 KiB once base64url-encoded in the JSON envelope; the WS max
  // payload must clear that so a full 64 KiB paste is delivered rather than dropped by
  // the transport before the handler's own 64 KiB-decoded check.
  await app.register(websocket, { options: { maxPayload: 98_304 } });
  app.setErrorHandler((error, request, reply) => {
    const failure = error as { code?: unknown; statusCode?: number; message?: string };
    // redact parser errors before settings endpoint wrappers can run
    if (request.url.startsWith('/api/settings')) return reply.code(failure.statusCode === 413 ? 413 : 400).send({ error: 'invalid_settings_request' });
    // normalize review parser failures
    if ((request.url.includes('/review-tour') || request.url.includes('/code-review')) && (failure.code === 'FST_ERR_CTP_BODY_TOO_LARGE' || failure.code === 'FST_ERR_CTP_INVALID_JSON_BODY' || error instanceof SyntaxError)) return reply.code(400).send({ status: 'error', error: { code: 'invalid_request', retryable: false } });
    return reply.code(failure.statusCode ?? 500).send({ error: failure.message ?? 'internal error' });
  });
  app.addHook('onRequest', async (request, reply) => {
    // bypass console routing for configured project hosts
    if (projectProxy.handle(request.raw, reply.raw)) reply.hijack();
  });
  app.addHook('onReady', async () => {
    const consoleUpgradeListeners = app.server.listeners('upgrade');
    app.server.removeAllListeners('upgrade');
    // dispatch upgrades by configured host
    app.server.on('upgrade', (request, socket, head) => {
      // proxy project upgrades directly
      if (projectProxy.upgrade(request, socket, head)) return;
      // retain registered console WebSocket behavior
      for (const listener of consoleUpgradeListeners) listener.call(app.server, request, socket, head);
    });
  });
  const expectedHost = config.publicOrigin.host;
  const secureOrigin = config.publicOrigin.protocol === 'https:';
  const cookieName = secureOrigin ? '__Host-rac' : 'rac-local';
  const websocketScheme = secureOrigin ? 'wss' : 'ws';
  // allow direct http(s) navigation inside the browser split
  const frameSourcePolicy = "frame-src 'self' http: https:";
  const forbidden = () => Object.assign(new Error('forbidden'), { statusCode: 403 });
  const unauthorized = () => Object.assign(new Error('unauthorized'), { statusCode: 401 });
  const inactiveClient = () => Object.assign(new Error('another client is active'), { statusCode: 423 });
  function browser(request: FastifyRequest, mutation = false): void { if (request.headers.host !== expectedHost) throw forbidden(); if (mutation && request.headers.origin !== config.publicOrigin.origin) throw forbidden(); }
  function session(request: FastifyRequest, mutation = false): Session { browser(request, mutation); const s = auth.get(auth.unsign(request.cookies[cookieName])); if (!s) throw unauthorized(); if (mutation && !auth.csrf(s, request.headers['x-csrf-token'] as string | undefined)) throw forbidden(); return s; }
  // protected routes renew existing control but never acquire it implicitly
  function controlled(request: FastifyRequest, mutation = false): Session {
    const s = session(request, mutation);
    // require explicit takeover when no controller has been established
    if (!control.connect(s.id)) throw inactiveClient();
    return s;
  }
  // serve one authenticated expiring preview
  const temporaryPreview = async (request: FastifyRequest<{ Params: { token: string } }>, reply: FastifyReply) => {
    browser(request);
    const token = request.params.token;
    const browserSession = auth.get(auth.unsign(request.cookies[cookieName]));
    const granted = temporaryPreviewAccess.allows(request.cookies['rac-preview'], token);
    // require either the RAC session or one path-scoped asset grant
    if (browserSession === undefined && !granted) return reply.code(401).send({ error: 'unauthorized' });
    const target = await temporaryPreviews.resolve(token);
    // hide missing, expired, and invalid registrations alike
    if (target === undefined) return reply.code(404).send({ error: 'temporary preview unavailable' });
    const prefix = `/preview/${token}`;
    const rawUrl = request.raw.url ?? `${prefix}/`;
    const expiresAt = Date.parse(target.expiresAt);
    const accessCookie = browserSession !== undefined && !granted ? temporaryPreviewCookie(temporaryPreviewAccess.issue(token, expiresAt), token, expiresAt, secureOrigin) : undefined;
    // canonicalize the preview root before proxying
    if (rawUrl === prefix || rawUrl.startsWith(`${prefix}?`)) {
      // retain the scoped grant across the redirect
      if (accessCookie !== undefined) reply.header('Set-Cookie', accessCookie);
      return reply.redirect(`${prefix}/${rawUrl.slice(prefix.length)}`);
    }
    const upstreamPath = rawUrl.slice(prefix.length) || '/';
    reply.hijack();
    temporaryPreviewProxy.handle(request.raw, reply.raw, target, upstreamPath, prefix, accessCookie);
  };
  type PublishedServer = { name: string; url: string; icon?: InstanceIcon; defaultName?: string; defaultIcon?: InstanceIcon };
  type PublishedRemoteServer = PublishedServer & { icon: InstanceIcon; defaultName: string; defaultIcon: InstanceIcon };
  type PublishedRemoteStatus = PublishedRemoteServer & Pick<InstanceStatus, 'attention'>;
  type PublishedServerNavigation = PublishedServer & { remotes: PublishedServer[] };
  const remotesByOrigin = new Map(config.remoteServers.map(remote => [remote.url.origin, remote]));
  // apply local display overrides without mutating peer-published status cache entries
  const publishedRemote = (status: Pick<InstanceStatus, 'url' | 'name' | 'icon'>): PublishedRemoteServer => {
    const configured = remotesByOrigin.get(status.url);
    const defaultIcon: InstanceIcon = status.icon ?? 'terminal';
    return { url: status.url, defaultName: status.name, defaultIcon, name: configured?.name ?? status.name, icon: configured?.icon ?? defaultIcon };
  };
  // retain remote attention while overlaying only the browser-facing identity
  const publishedRemoteStatus = (status: InstanceStatus): PublishedRemoteStatus => ({ ...publishedRemote(status), attention: status.attention });
  // publish configured navigation before peer checks
  const configuredRemotes = config.remoteServers.map(remote => publishedRemote({ name: remote.url.hostname, url: remote.url.origin }));
  // publish safe local server metadata
  const server: PublishedServerNavigation = { name: config.name, url: config.publicOrigin.origin, ...(config.icon === undefined ? {} : { icon: config.icon }), remotes: configuredRemotes };
  // apply only the existing live settings after serialized durable writes
  const settings = deps.settings ?? new SettingsService(config, { live: {
    // refresh the published instance identity
    name: name => { config.name = name; server.name = name; },
    // keep launch resolutions aligned with the saved fallback
    defaultAgent: async kind => { config.defaultAgent = kind; await dashboardUpdates.refresh().catch(() => undefined); },
    // retain the proven voice-only live surface
    davo: saved => { if (saved.enabled && !davoAvailable) throw new Error('davo_unavailable'); integrationConfig.realtime = { ...integrationConfig.realtime, ...saved }; }
  } });
  // reuse browser auth without granting integration principals settings capabilities
  await registerSettingsRoutes(app, { service: settings, session, controlled, isController: id => control.ownerSessionId() === id });
  // keep outbound google authorization separate from inbound integration principals
  await registerGoogleCalendarRoutes(app, {
    service: googleCalendar, session, controlled,
    reservationGeneration: id => control.reservationGeneration(id),
    renewReservation: (id, generation) => control.renewReservation(id, generation),
    isSessionValid: id => control.reservationGeneration(id) !== undefined
  });
  // own provider workers within the normal application lifecycle
  app.addHook('onReady', async () => { googleCalendar.start(); });
  app.addHook('onClose', async () => { await googleCalendar.stop(); });
  // refresh remote identities from their publishers
  const refreshRemoteServers = async (known?: InstanceStatus[]) => {
    const statuses = known ?? await instanceStatusPoller.statuses(config.remoteServers);
    server.remotes = statuses.map(publishedRemote);
    return statuses;
  };
  // map typed review failures
  const reviewStatus = (code: ReviewErrorCode): number => {
    // map request failures
    if (code === 'invalid_request') return 400;
    // map missing targets
    if (code === 'target_unavailable') return 404;
    // map oversized snapshots
    if (code === 'too_large') return 413;
    // map invalid generator results
    if (code === 'generation_failed' || code === 'malformed_result' || code === 'generation_rejected') return 502;
    // map unavailable generator dependencies
    if (code === 'capability_unavailable' || code === 'authentication_required') return 503;
    // map bounded timeouts
    if (code === 'timed_out') return 504;
    // retain the explicit cancellation status
    if (code === 'cancelled') return 499;
    return 409;
  };
  // send one frozen review error envelope
  const reviewFailure = (reply: FastifyReply, error: unknown) => {
    const failure = error instanceof ReviewTourError ? error : new ReviewTourError('generation_failed', true);
    return reply.code(reviewStatus(failure.code)).send({ status: 'error', error: { code: failure.code, retryable: failure.retryable } });
  };
  // parse review query booleans
  const reviewQuery = (value: unknown): ReviewTourInput | undefined => {
    // require an object query
    if (value === null || typeof value !== 'object') return undefined;
    const query = value as { scope?: unknown; commit?: unknown; includeTests?: unknown; includeDocs?: unknown };
    // require the exact public query shape; a commit Comparison also names its commit
    if (Object.keys(query).filter(key => key !== 'commit').sort().join(',') !== 'includeDocs,includeTests,scope' || (query.includeTests !== 'true' && query.includeTests !== 'false') || (query.includeDocs !== 'true' && query.includeDocs !== 'false')) return undefined;
    return parseReviewTourInput({ scope: query.scope, ...(query.commit === undefined ? {} : { commit: query.commit }), includeTests: query.includeTests === 'true', includeDocs: query.includeDocs === 'true' });
  };
  // describe one authenticated browser session
  const sessionState = async (s: Session, active: boolean) => {
    // refresh peers off the authentication path
    void refreshRemoteServers().catch(() => undefined);
    const owner = control.ownerSessionId();
    return {
      csrfToken: s.csrf,
      active,
      deviceName: await devices.get(s.id),
      controllingDeviceName: owner === undefined ? undefined : await devices.get(owner),
      defaultAgent: typeof launch.defaultAgent === 'function' ? launch.defaultAgent() : undefined,
      davo: publicDavoSettings(),
      server
    };
  };
  // omit unavailable nullable limit fields
  const publicLimitWindow = (window: AccountRateLimitWindow) => ({ usedPercent: window.usedPercent, ...(window.windowDurationMins === null ? {} : { windowDurationMins: window.windowDurationMins }), ...(window.resetsAt === null ? {} : { resetsAt: window.resetsAt }) });
  // flatten one secret-free account response for the browser
  const publicAccount = (account: AccountSummary) => ({
    id: account.id,
    label: account.label,
    active: account.active,
    ...(account.authMode === 'apikey' ? { authMode: 'apikey' as const } : {}),
    ...(account.email === undefined ? {} : { email: account.email }),
    ...(account.planType === undefined ? {} : { planType: account.planType }),
    ...(account.limits?.primary === undefined ? {} : { primary: publicLimitWindow(account.limits.primary) }),
    ...(account.limits?.secondary === undefined ? {} : { secondary: publicLimitWindow(account.limits.secondary) }),
    ...(account.limits?.rateLimitResetCredits === undefined ? {} : { resetCount: account.limits.rateLimitResetCredits.availableCount }),
    ...(account.error === undefined ? {} : { error: account.error })
  });
  // resolve project and worktree names for one agent alert
  const notificationContextForAgent = (agent: Agent, { projects, places }: Pick<DashboardPayload, 'projects' | 'places'>): AgentNotificationContext => {
    const project = projects.find(candidate => candidate.id === agent.projectId);
    const worktree = project?.worktrees.find(candidate => candidate.id === agent.worktreeId);
    // a directory-Project or Scratch Agent's home is its Place's, so name it by the Place
    const placeLabel = places.find(candidate => candidate.id === agent.placeId)?.label;
    const fallbackName = agent.displayLabel ?? placeLabel ?? agent.home.split('/').filter(Boolean).at(-1) ?? agent.title;
    return {
      projectName: project?.label ?? fallbackName,
      worktreeName: worktree?.label ?? fallbackName,
      multipleWorktrees: (project?.worktrees.length ?? 0) > 1
    };
  };
  // count prompts before dispatch starts
  const queuedPromptCounts = async (agents: Agent[]) => new Map(await Promise.all(agents.map(async agent => {
    // suppress false completion alerts on storage errors
    const count = await queuedPrompts.list(promptScope(agent.id)).then(queue => queue?.length ?? 0).catch(() => 1);
    return [agent.id, count] as const;
  })));
  // overlay a stored tour's live Code review: running beats a stored review, which beats a failure
  const codeReviewSummary = (summary: StoredReviewTourSummary): StoredReviewTourSummary => {
    const live = codeReviews.status(summary.worktreeId, summary.fingerprint);
    if (live === 'running') { const { findings: _findings, ...rest } = summary; return { ...rest, codeReview: 'running' }; }
    return summary.codeReview === undefined && live === 'failed' ? { ...summary, codeReview: 'failed' } : summary;
  };
  // publish current pane observations on each dashboard update
  const dashboard = async (): Promise<DashboardPayload> => {
    const discovered = await discovery.dashboard(false, true);
    // share this scan with stack display without weakening fresh lifecycle checks
    const paneSnapshots = tmux.paneSnapshotsNow?.();
    // a Review run pane whose run is not in flight (a restart forgot it) goes back to the operator
    void interactiveRunner.releaseOrphans(discovered.agents);
    const queuedCounts = await queuedPromptCounts(discovered.agents);
    // recover durable intervals even when the original agent is no longer listed
    if (calendarLifecycle !== undefined) await prompts.reconcileCalendar?.(discovered.agents.map(agent => agent.id)).catch(() => undefined);
    await Promise.all(discovered.agents.map(agent => prompts.observe(agent).catch(() => undefined)));
    await prompts.retireDeparted(discovered.agents.map(agent => agent.id)).catch(() => undefined);
    // suppress completions while more work waits
    for (const agent of discovered.agents) notifications.observe(agent, (queuedCounts.get(agent.id) ?? 0) > 0, notificationContextForAgent(agent, discovered));
    notifications.retain(discovered.agents);
    const worktrees = discovery.worktreesNow();
    const controls = new Map(await Promise.all(worktrees.map(async worktree => [worktree.id, { actions: stackCommands.actions(worktree), ...await stackCommands.state(worktree, paneSnapshots) }] as const)));
    const controlFor = (worktreeId: string | undefined) => worktreeId === undefined ? undefined : controls.get(worktreeId);
    const worktreeViews = discovered.projects.flatMap(project => project.worktrees);
    const reviewBranches = worktreeViews.map(view => ({ worktreeId: view.id, branch: discovered.agents.find(agent => agent.worktreeId === view.id)?.branch ?? view.branch }));
    const reviews = (await reviewStore.summaries(reviewBranches)).map(codeReviewSummary);
    // resolve the Launch profile for every scope the web can launch into: each idle
    // worktree, each running agent's worktree (for Restart as…), each non-git directory
    // Project (launched in place), each Scratch Place, and the Scratch group
    const launchResolutions = await launch.launchResolutions([scratchLaunchKey, ...worktreeViews.map(view => view.id), ...discovered.agents.flatMap(agent => agent.worktreeId === undefined ? [] : [agent.worktreeId]), ...discovered.projects.flatMap(project => project.mode === 'directory' ? [project.id] : []), ...discovered.places.map(placeLaunchScope)]);
    const launchFor = (worktreeId: string | undefined) => launchResolutions.get(worktreeId ?? scratchLaunchKey);
    // an Agent resolves in its Worktree's scope, else its directory Project's or Scratch Place's
    const placeById = new Map(discovered.places.map(place => [place.id, place] as const));
    const agentLaunch = (agent: Agent) => {
      const place = agent.placeId === undefined ? undefined : placeById.get(agent.placeId);
      return agent.worktreeId === undefined && place !== undefined ? launchResolutions.get(placeLaunchScope(place)) : launchFor(agent.worktreeId);
    };
    return { ...discovered, agents: discovered.agents.map(agent => ({ ...agent, unread: notifications.isUnread(agent), completionId: notifications.completionId(agent), queuedPromptCount: queuedCounts.get(agent.id) ?? 0, ...(controlFor(agent.worktreeId) === undefined ? {} : { stack: controlFor(agent.worktreeId) }), ...(agentLaunch(agent) === undefined ? {} : { launch: agentLaunch(agent) }) })), places: discovered.places.map(place => ({ ...place, ...(launchResolutions.get(placeLaunchScope(place)) === undefined ? {} : { launch: launchResolutions.get(placeLaunchScope(place)) }) })), projects: discovered.projects.map(project => ({ ...project, ...(project.mode === 'directory' && launchResolutions.get(project.id) !== undefined ? { launch: launchResolutions.get(project.id) } : {}), worktrees: project.worktrees.map(worktree => ({ ...worktree, ...(controlFor(worktree.id) === undefined ? {} : { stack: controlFor(worktree.id) }), ...(launchFor(worktree.id) === undefined ? {} : { launch: launchFor(worktree.id) }) })) })), cleanupPending: cleanup.pending().length, buttons: buttonCatalog.value, notesRevision, scratchLaunch: launchResolutions.get(scratchLaunchKey), reviewTour: reviewTourCapability, codeReview: codeReviewCapability, reviews, ...(config.editor === undefined ? {} : { editor: true as const }), ...(config.keys === undefined ? {} : { keys: browserKeysConfig(config.keys) }) };
  };
  // observe only agent state needed by cross-instance attention
  const localInstanceAttention = async () => {
    const discovered = await discovery.dashboard();
    const queuedCounts = await queuedPromptCounts(discovered.agents);
    // update completion and question state for every agent
    for (const agent of discovered.agents) notifications.observe(agent, (queuedCounts.get(agent.id) ?? 0) > 0, notificationContextForAgent(agent, discovered));
    notifications.retain(discovered.agents);
    return instanceAttention({ agents: discovered.agents.map(agent => ({ ...agent, unread: notifications.isUnread(agent) })) });
  };
  dashboardUpdates.setLoader(dashboard);
  // keep sensitive browser capabilities scoped to the console origin
  app.addHook('onSend', async (request, reply, payload) => {
    // authorize WebAssembly only in the isolated formatter worker, never in the page
    const formatterPolicy = /^\/assets\/shell-format-worker-[\w-]+\.js(?:\?.*)?$/u.test(request.url) ? "script-src 'self' 'wasm-unsafe-eval'; " : '';
    reply.header('Cache-Control', 'no-store').header('X-Frame-Options', 'DENY').header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer').header('Permissions-Policy', 'camera=(), microphone=(self), geolocation=(self), clipboard-read=(self), clipboard-write=(self)').header('Cross-Origin-Opener-Policy', 'same-origin-allow-popups').header('Cross-Origin-Resource-Policy', 'same-origin').header('Content-Security-Policy', `default-src 'self'; ${formatterPolicy}connect-src 'self' ${websocketScheme}://${expectedHost}${integrationConfig.realtime.enabled ? ' https://api.openai.com' : ''}; img-src 'self' data:; style-src 'self' 'unsafe-inline'; ${frameSourcePolicy}; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
    // isolate editable static artwork from the application policy
    if (request.url === '/favicon.svg' || request.url.startsWith('/instance-icons/')) reply.header('Content-Security-Policy', "default-src 'none'; style-src 'none'; sandbox; base-uri 'none'; frame-ancestors 'none'");
    // publish HSTS only for HTTPS deployments
    if (secureOrigin) reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    return payload;
  });
  // expose the same shared services through remote transports
  if (integrationConfig.enabled) {
    const resource = `${config.publicOrigin.origin}/mcp`;
    const derivedRealtimeToken = createHmac('sha256', process.env.RAC_SESSION_SECRET ?? '').update('remote-agents:realtime-mcp:v1').digest('base64url');
    const realtimeToken = process.env.RAC_REALTIME_MCP_TOKEN?.trim() || derivedRealtimeToken;
    const integrationAuth = new IntegrationAuthService({ issuer: config.publicOrigin.origin, resource, stateFile: process.env.RAC_INTEGRATION_AUTH_FILE ?? '.data/integration-auth.json', realtimeToken, realtimeSubjectId: 'local-voice' });
    const integrationPolicy = new IntegrationPolicyService();
    const integrationAudit = new IntegrationAuditService();
    const integrationControl = new IntegrationControlService(() => control.ownerSessionId());
    await integrationPolicy.recoverUnknownOutcomes();
    const orchestration = new OrchestrationService({
      config,
      loadDashboard: () => dashboardUpdates.refresh(),
      discovery,
      tmux,
      prompts,
      promptHistory,
      worktreeCommands: stackCommands,
      workspaceFiles,
      pullRequests: prSwitch,
      newTasks: newTask,
      loadInstances: async () => {
        await refreshRemoteServers();
        return [{ id: server.url, name: server.name, url: server.url, local: true, ...(server.icon === undefined ? {} : { icon: server.icon }) }, ...server.remotes.map(remote => ({ id: remote.url, name: remote.name, url: remote.url, local: false, ...(remote.icon === undefined ? {} : { icon: remote.icon }) }))];
      },
      launchWorktree: worktreeId => launch.launch(worktreeId),
      launchScratch: () => launch.launchHome(),
      loadReview: (worktreeId, branch) => reviewStore.current(worktreeId, branch),
      startReview: (agentId, input) => reviewJobs.start('integration-gateway', agentId, input)
    });
    const federationSecret = process.env.RAC_INTEGRATION_FEDERATION_SECRET?.trim() || instanceStatusSecret;
    const integrationGateway = new IntegrationGateway({ config: integrationConfig, instanceId: config.publicOrigin.origin, orchestration, policy: integrationPolicy, audit: integrationAudit, control: integrationControl, ...(integrationConfig.multiInstance.enabled ? { forward: federationForwarder(config.remoteServers, federationSecret) } : {}) });
    const realtimeScopes: IntegrationScope[] = ['status:read', 'logs:read', 'files:read', ...(integrationConfig.realtime.writeToolsEnabled ? ['prompts:write', 'agents:control', 'stack:operate', 'review:write'] as IntegrationScope[] : [])];
    registerIntegrationAuthServer({
      app,
      auth: integrationAuth,
      resource,
      // bind OAuth consent to the existing signed browser session
      localSubject: (request, csrf): LocalIntegrationSubject | undefined => {
        try {
          const local = session(request);
          // verify form approval with the session's CSRF secret
          if (csrf !== undefined && (request.headers.origin !== config.publicOrigin.origin || !auth.csrf(local, csrf))) return undefined;
          return { id: local.id, csrf: local.csrf } as LocalIntegrationSubject;
        } catch { return undefined; }
      }
    });
    registerMcpServer({ app, publicOrigin: config.publicOrigin.origin, auth: integrationAuth, gateway: integrationGateway, realtimeScopes });
    app.post('/api/integration-federation', { config: { rateLimit: { max: 240, timeWindow: '1 minute' } } }, async (request, reply) => {
      browser(request);
      // keep cross-instance execution independently disabled
      if (!integrationConfig.multiInstance.enabled) return reply.code(404).send({ error: 'federation unavailable' });
      const delegated = verifyFederationRequest(federationSecret, request.headers['x-rac-federation-timestamp'], request.headers['x-rac-federation-signature'], request.body);
      // reject unsigned or malformed delegation
      if (delegated === undefined) return reply.code(401).send({ error: 'unauthorized' });
      return await integrationGateway.call({ authentication: 'oauth', subjectId: delegated.principal.subjectId, audience: resource, scopes: delegated.principal.scopes, ...(delegated.principal.clientId === undefined ? {} : { clientId: delegated.principal.clientId }) }, delegated.name, delegated.arguments, { voiceAuthorized: delegated.voiceAuthorized });
    });
    const realtime = new RealtimeService({ apiKey: process.env.RAC_OPENAI_API_KEY, settings: () => ({ name: integrationConfig.realtime.name, context: integrationConfig.realtime.context }) });
    app.get('/api/integrations/status', async request => {
      session(request);
      return { enabled: true, mcp: integrationConfig.mcp, control: integrationControl.snapshot(), realtime: { enabled: integrationConfig.realtime.enabled, available: integrationConfig.realtime.enabled && realtime.available(), writeToolsEnabled: integrationConfig.realtime.writeToolsEnabled } };
    });
    app.post('/api/realtime/session', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
      const local = controlled(request, true);
      // keep voice disabled unless both the feature and provider are configured
      if (!integrationConfig.realtime.enabled || !realtime.available()) return reply.code(503).send({ error: 'Realtime voice is unavailable.' });
      const principal = integrationAuth.authenticateRealtimeToken(realtimeToken);
      // fail closed if the isolated MCP credential is unavailable
      if (!principal.ok) return reply.code(503).send({ error: 'Realtime orchestration is unavailable.' });
      const allowedTools = integrationGateway.listTools({ ...principal.value, audience: resource, scopes: realtimeScopes }).map(tool => tool.name);
      const requestedContext = body(request);
      // accept only canonical selected-target identifiers
      if ((requestedContext.worktreeId !== undefined && (typeof requestedContext.worktreeId !== 'string' || requestedContext.worktreeId.length > 240)) || (requestedContext.agentId !== undefined && (typeof requestedContext.agentId !== 'string' || requestedContext.agentId.length > 240)) || typeof requestedContext.voiceSessionId !== 'string' || !/^[A-Za-z0-9_-]{20,64}$/u.test(requestedContext.voiceSessionId)) return reply.code(400).send({ error: 'invalid voice context' });
      // activate mutation access only for this voice session
      if (!integrationControl.startVoice(local.id, requestedContext.voiceSessionId)) return reply.code(409).send({ error: 'voice session stopped' });
      const result = await realtime.create({ subject: local.id, mcpUrl: resource, mcpAuthorization: realtimeToken, allowedTools, context: { instanceId: config.publicOrigin.origin, ...(requestedContext.worktreeId === undefined ? {} : { worktreeId: requestedContext.worktreeId as string }), ...(requestedContext.agentId === undefined ? {} : { agentId: requestedContext.agentId as string }) } });
      // revoke access when provider setup fails
      if (!result.ok) integrationControl.stopVoice(local.id, requestedContext.voiceSessionId);
      return result.ok ? reply.send(result) : reply.code(result.code === 'invalid_request' ? 400 : 502).send({ error: result.code });
    });
    app.post('/api/realtime/session/heartbeat', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
      const local = controlled(request, true);
      const voiceSessionId = body(request).voiceSessionId;
      // renew only the active voice browser
      if (typeof voiceSessionId !== 'string' || !/^[A-Za-z0-9_-]{20,64}$/u.test(voiceSessionId) || !integrationControl.heartbeatVoice(local.id, voiceSessionId)) return reply.code(409).send({ error: 'voice mode inactive' });
      return { ok: true };
    });
    app.post('/api/realtime/session/stop', async request => {
      const local = session(request, true);
      const voiceSessionId = body(request).voiceSessionId;
      // stop only one canonical browser voice session
      if (typeof voiceSessionId === 'string' && /^[A-Za-z0-9_-]{20,64}$/u.test(voiceSessionId)) integrationControl.stopVoice(local.id, voiceSessionId);
      return { ok: true };
    });
  }
  // share a boot-local route proof with the tunnel setup health check
  registerHealthRoute(app);
  // publish only the local instance attention state
  app.get('/api/instance-status', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (request, reply) => {
    browser(request);
    // require an authenticated peer signature
    if (!validInstanceStatusRequest(instanceStatusSecret, config.publicOrigin.origin, request.headers['x-rac-status-timestamp'], request.headers['x-rac-status-signature'])) return reply.code(401).send({ error: 'unauthorized' });
    return { name: server.name, ...(server.icon === undefined ? {} : { icon: server.icon }), attention: await localInstanceAttention() };
  });
  // serve the configured favicon before authentication
  app.get('/favicon.svg', async (request, reply) => { browser(request); return reply.type('image/svg+xml').send(await loadInstanceIconSvg(config.icon)); });
  // serve local artwork or the portable server menu fallback
  app.get('/instance-icons/:icon.svg', async (request, reply) => {
    browser(request);
    const icon = (request.params as { icon: string }).icon;
    // reject unknown icon paths
    if (!isInstanceIcon(icon)) return reply.code(404).send({ error: 'icon unavailable' });
    return reply.type('image/svg+xml').send(await loadInstanceIconSvg(icon));
  });
  app.get('/preview/:token', temporaryPreview);
  app.get('/preview/:token/*', temporaryPreview);
  // publish the privacy policy without session or controller checks
  app.get('/privacy', async (request, reply) => { browser(request); return reply.type('text/html; charset=utf-8').send(renderPublicPolicyPage('privacy')); });
  // publish terms without changing authentication for protected routes
  app.get('/terms', async (request, reply) => { browser(request); return reply.type('text/html; charset=utf-8').send(renderPublicPolicyPage('terms')); });
  // render public browser errors while retaining machine-readable API and asset failures
  app.setNotFoundHandler(async (request, reply) => {
    browser(request);
    const pathname = request.url.split('?')[0] ?? '';
    // honor explicit HTML media ranges without ignoring a rejected quality value
    const acceptsHtml = request.headers.accept?.toLowerCase().split(',').some(range => {
      const [mediaType, ...parameters] = range.split(';');
      // default an omitted quality value to the standard full preference
      const quality = parameters.find(parameter => parameter.trim().startsWith('q='))?.split('=')[1] ?? '1';
      return mediaType?.trim() === 'text/html' && Number(quality) > 0 && Number(quality) <= 1;
    });
    // keep reserved API and static asset namespaces machine-readable
    const resourcePath = /^\/(?:api|assets|fonts)(?:\/|$)/u.test(pathname);
    const html = (request.method === 'GET' || request.method === 'HEAD') && acceptsHtml && !resourcePath;
    const payload = html ? renderNotFoundPage() : JSON.stringify({ error: 'not found' });
    reply.code(404).header('Vary', 'Accept').type(html ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8').header('Content-Length', Buffer.byteLength(payload));
    // delegated static HEAD requests need explicit body suppression with matching GET length
    return reply.send(request.method === 'HEAD' ? undefined : payload);
  });
  app.get('/', async (request, reply) => { browser(request); return reply.sendFile('index.html'); });
  app.get('/api/ui-version', async (request) => { browser(request); return { version: await uiVersion() }; });
  // restore authentication without silently claiming an unowned console
  app.get('/api/auth/session', async (request) => { const s = session(request); return await sessionState(s, control.connect(s.id)); });
  // issue bootstrap without waiting for peers
  app.get('/api/auth/bootstrap', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request) => { browser(request); void refreshRemoteServers().catch(() => undefined); return { csrfToken: auth.bootstrap(), server }; });
  // aggregate configured instance attention for authenticated clients
  app.get('/api/server-statuses', async (request) => {
    session(request);
    const [localAttention, remotes] = await Promise.all([localInstanceAttention(), instanceStatusPoller.statuses(config.remoteServers)]);
    await refreshRemoteServers(remotes);
    return { servers: [{ url: config.publicOrigin.origin, name: server.name, ...(server.icon === undefined ? {} : { icon: server.icon }), attention: localAttention }, ...remotes.map(publishedRemoteStatus)] };
  });
  // explicit sign-in may establish initial ownership without displacing another client
  app.post('/api/auth/login', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => { browser(request, true); const data = body(request); const preauth = request.headers['x-csrf-token']; if (typeof data.password !== 'string' || typeof preauth !== 'string') return reply.code(401).send({ error: 'invalid credentials' }); const s = await auth.login(data.password, preauth); if (!s) return reply.code(401).send({ error: 'invalid credentials' }); reply.setCookie(cookieName, auth.sign(s), { path: '/', secure: secureOrigin, httpOnly: true, sameSite: 'lax', signed: false, maxAge: 400 * 24 * 60 * 60 }); return await sessionState(s, await control.claimInitial(s.id)); });
  app.post('/api/auth/take-control', async (request, reply) => {
    const s = session(request, true);
    const providedName = body(request).deviceName;
    let deviceName = await devices.get(s.id);
    if (providedName !== undefined) {
      if (typeof providedName !== 'string' || await devices.set(s.id, providedName) === undefined) return reply.code(400).send({ error: 'Device name must be between 1 and 64 visible characters.' });
      deviceName = await devices.get(s.id);
    }
    if (deviceName === undefined) return reply.code(400).send({ error: 'Name this device before taking control.' });
    await control.take(s.id);
    return await sessionState(s, true);
  });
  // rename the active browser client
  app.patch('/api/auth/device-name', async (request, reply) => {
    const s = controlled(request, true);
    const providedName = body(request).deviceName;
    // require a valid visible client name
    if (typeof providedName !== 'string' || await devices.set(s.id, providedName) === undefined) return reply.code(400).send({ error: 'Client name must be between 1 and 64 visible characters.' });
    return await sessionState(s, true);
  });
  // rename the current server persistently
  app.patch('/api/server/name', async (request, reply) => {
    const browserSession = controlled(request, true);
    const providedName = body(request).name;
    // require a valid configuration name
    if (typeof providedName !== 'string') return reply.code(400).send({ error: 'Server name must be between 1 and 80 visible characters.' });
    try {
      // retain narrow injected test services while production uses the shared serializer
      const name = deps.serverAdmin !== undefined && deps.settings === undefined ? await serverAdmin.renameServer(providedName) : await settings.updateApplication([{ op: 'set', path: ['name'], value: providedName.trim() }], browserSession.id).then(() => providedName.trim());
      // reject invalid or unavailable configuration writes
      if (name === undefined) return reply.code(400).send({ error: 'Server name must be between 1 and 80 visible characters.' });
      server.name = name;
      return { name, server };
    } catch {
      return reply.code(503).send({ error: 'Unable to update the server configuration.' });
    }
  });
  // persist the launch fallback selected by the controlling browser
  app.patch('/api/server/default-agent', async (request, reply) => {
    const browserSession = controlled(request, true);
    const selected = requestedKind(request);
    // require one known agent kind
    if (selected.invalid || selected.kind === undefined) return reply.code(400).send({ error: 'Choose a valid default agent.' });
    // refuse configured kinds that cannot launch now
    if (!launch.isLaunchableKind(selected.kind)) return reply.code(409).send({ error: 'The selected default agent is unavailable.' });
    let kind: AgentKind | undefined;
    try {
      // retain injected legacy doubles without bypassing production serialization
      kind = deps.serverAdmin !== undefined && deps.settings === undefined ? await serverAdmin.setDefaultAgent(selected.kind) : await settings.updateApplication([{ op: 'set', path: ['defaultAgent'], value: selected.kind }], browserSession.id).then(() => selected.kind);
    } catch {
      return reply.code(503).send({ error: 'Unable to update the server configuration.' });
    }
    // require a durable configuration write
    if (kind === undefined) return reply.code(503).send({ error: 'Unable to update the server configuration.' });
    config.defaultAgent = kind;
    // push fresh launch resolutions without rolling back a successful preference write
    await dashboardUpdates.refresh().catch(() => undefined);
    return { defaultAgent: kind };
  });
  // publish cached current and upstream agent versions
  app.get('/api/agents/updates', async request => {
    controlled(request);
    return { agents: await agentUpdates.statuses() };
  });
  // execute one configured agent update command
  app.post('/api/agents/:kind/update', { config: { rateLimit: { max: 3, timeWindow: '1 hour' } } }, async (request, reply) => {
    controlled(request, true);
    const kind = (request.params as { kind?: unknown }).kind;
    // require one registered adapter kind
    if (typeof kind !== 'string' || !(agentKinds as readonly string[]).includes(kind)) return reply.code(404).send({ error: 'Agent update is unavailable.' });
    const prefer = request.headers.prefer;
    // opt into background completion with one standard preference token
    const respondAsync = typeof prefer === 'string' && prefer.split(',').some(value => value.trim().toLowerCase() === 'respond-async');
    // preserve the synchronous response for older clients
    if (respondAsync) {
      const started = agentUpdates.startUpdate(kind as AgentKind);
      // map start refusals without launching work
      if (started.outcome === 'unavailable') return reply.code(404).send({ error: 'Agent update is unavailable.' });
      // preserve one in-flight installer
      if (started.outcome === 'busy') return reply.code(409).send({ error: 'Agent update is already running.' });
      return reply.code(202).send({ update: started.job });
    }
    const result = await agentUpdates.update(kind as AgentKind);
    // map service outcomes without exposing command details
    if (result.outcome === 'unavailable') return reply.code(404).send({ error: 'Agent update is unavailable.' });
    // preserve one in-flight update
    if (result.outcome === 'busy') return reply.code(409).send({ error: 'Agent update is already running.' });
    // report an operator command failure safely
    if (result.outcome === 'failed') return reply.code(502).send({ error: result.error ?? 'Agent update failed.' });
    return { agent: result.status };
  });
  // publish one authenticated background update state
  app.get('/api/agents/:kind/update/:id', async (request, reply) => {
    controlled(request);
    const { kind, id } = request.params as { kind?: unknown; id?: unknown };
    // require one registered adapter kind and opaque identifier
    if (typeof kind !== 'string' || !(agentKinds as readonly string[]).includes(kind) || typeof id !== 'string') return reply.code(404).send({ error: 'Agent update is unavailable.' });
    const update = agentUpdates.updateStatus(kind as AgentKind, id);
    // hide unknown, stale, and cross-kind jobs alike
    if (update === undefined) return reply.code(404).send({ error: 'Agent update status is unknown. Check the installed version before retrying.' });
    return { update };
  });
  // persist the configurable voice surface
  app.patch('/api/server/davo', async (request, reply) => {
    const browserSession = controlled(request, true);
    const requested = parseDavoSettings(body(request));
    // require one exact settings payload
    if (requested === undefined) return reply.code(400).send({ error: 'Choose valid Davo settings.' });
    // prevent enabling a provider surface unavailable in this process
    if (requested.enabled && !davoAvailable) return reply.code(409).send({ error: 'Davo is unavailable on this server.' });
    let saved;
    try {
      // route the established voice mutation through the same source transaction
      saved = deps.serverAdmin !== undefined && deps.settings === undefined ? await serverAdmin.setDavoSettings(requested) : await settings.updateApplication(Object.entries(requested).map(([key, value]) => ({ op: 'set' as const, path: ['integrations', 'realtime', key], value })), browserSession.id).then(() => requested);
    } catch {
      return reply.code(503).send({ error: 'Unable to update Davo settings.' });
    }
    // require a durable configuration write
    if (saved === undefined) return reply.code(503).send({ error: 'Unable to update Davo settings.' });
    integrationConfig.realtime = { ...integrationConfig.realtime, ...saved };
    return { davo: publicDavoSettings() };
  });
  // stop every advisor tied to one reviewed target
  const stopUpdateAdvisors = async (targetSha: string): Promise<boolean> => {
    const advisorIds = new Set<string>();
    const mappedId = updateAdvisors.get(targetSha);
    // include the in-memory target after an uninterrupted launch
    if (mappedId !== undefined) advisorIds.add(mappedId);
    let dashboard;
    try {
      dashboard = await discovery.dashboard();
    } catch {
      // never claim cleanup when pane discovery failed
      return false;
    }
    // recover every target-pinned advisor after a server restart
    for (const agent of dashboard?.agents ?? []) if (isUpdateAdvisorForTarget(agent.displayLabel, targetSha)) advisorIds.add(agent.id);
    let allClosed = true;
    // close only live server-owned advisors for this target
    for (const advisorId of advisorIds) {
      let target;
      try {
        target = await discovery.target(advisorId);
      } catch {
        // retain the mapping for a later cleanup retry
        allClosed = false;
        continue;
      }
      // treat already-vanished panes as stopped
      if (target === undefined) continue;
      // fail closed if an identifier no longer names the expected advisor
      if (!isUpdateAdvisorForTarget(target.agent.displayLabel, targetSha) || !await prompts.close(advisorId).catch(() => false)) allClosed = false;
    }
    // forget only targets with no surviving advisor
    if (allClosed) updateAdvisors.delete(targetSha);
    return allClosed;
  };
  // pull and rebuild this server on its host
  app.post('/api/server/update', { config: { rateLimit: { max: 2, timeWindow: '1 hour' } } }, async (request, reply) => {
    controlled(request, true);
    const data = body(request);
    const expectedTargetSha = data.expectedTargetSha;
    const advisoryAcknowledged = data.advisoryAcknowledged === true;
    // reject malformed reviewed targets
    if (!isFullGitSha(expectedTargetSha)) return reply.code(400).send({ error: 'Invalid server update target.' });
    const preview = await serverAdmin.updatePreview();
    // require one fresh host preview
    if (preview === undefined) return reply.code(503).send({ error: 'Server updates are unavailable on this deployment.' });
    // stop stale modals from installing a newer revision
    if (expectedTargetSha !== preview.targetSha) return reply.code(409).send({ error: 'The upstream update changed. Review the latest commits before updating.' });
    // require operator review for flagged host changes
    if (preview.advisory.required && !advisoryAcknowledged) return reply.code(409).send({ error: 'Review and acknowledge the update advisor guidance before updating.' });
    // reject current or divergent ranges
    const retryingReviewedTarget = preview.rebuildRetryAvailable && !preview.available && preview.baseSha === expectedTargetSha && preview.targetSha === expectedTargetSha;
    // allow a failed Compose rebuild to retry after Git reached the reviewed target
    if (!preview.available && !retryingReviewedTarget) return reply.code(409).send({ error: 'The server is already current.' });
    if (!preview.fastForwardable) return reply.code(409).send({ error: 'The server checkout cannot be fast-forwarded automatically.' });
    const status = await serverAdmin.startUpdate(preview.targetSha);
    // require the configured host bridge
    if (status === undefined) return reply.code(503).send({ error: 'Server updates are unavailable on this deployment.' });
    // reject a different target already mutating this host
    if (status.kind === 'target-conflict') return reply.code(409).send({ error: `Another reviewed server update is already running for ${status.targetSha.slice(0, 7)}.` });
    return reply.code(status.state === 'failed' ? 503 : 202).send(status);
  });
  // report one surviving host update
  app.get('/api/server/update/:id', async (request, reply) => {
    controlled(request);
    const status = await serverAdmin.updateStatus((request.params as { id: string }).id);
    // retain advice through the update, then close every target pane
    if (status?.state === 'complete') await stopUpdateAdvisors(status.targetSha);
    return status === undefined ? reply.code(404).send({ error: 'Server update unavailable.' }) : status;
  });
  // check whether origin main is ahead of local main
  app.get('/api/server/update-available', async (request, reply) => {
    controlled(request);
    const preview = await serverAdmin.updatePreview();
    // require the configured host bridge
    return preview === undefined
      ? reply.code(503).send({ error: 'Server update checks are unavailable on this deployment.' })
      : { available: preview.available || preview.rebuildRetryAvailable, commitCount: preview.commitCount, targetSha: preview.targetSha };
  });
  // publish the deployed checkout revision to settings
  app.get('/api/server/revision', async (request, reply) => {
    controlled(request);
    const revision = await deployedRevision;
    // keep unavailable repository metadata explicit
    return revision === undefined ? reply.code(503).send({ error: 'Server revision is unavailable on this deployment.' }) : revision;
  });
  // preview the exact fetched update range
  app.get('/api/server/update-preview', async (request, reply) => {
    controlled(request);
    const preview = await serverAdmin.updatePreview();
    // require the configured host bridge
    if (preview === undefined) return reply.code(503).send({ error: 'Server update previews are unavailable on this deployment.' });
    // warn that explicit update activates saved deployment settings too
    const pending = await settings.status().catch(() => undefined);
    return pending?.pending ? { ...preview, settingsImpact: { pendingTargets: pending.targets, warning: `Updating rebuilds RAC with all saved pending RAC settings${pending.targets.includes('cloudflared') ? '; Cloudflare changes still require their separate Restart proof' : ''}.` } } : preview;
  });
  // clear browser authentication even when durable ownership release fails
  app.post('/api/auth/logout', async (request, reply) => {
    const s = session(request, true);
    auth.logout(s.id);
    reply.clearCookie(cookieName, { path: '/', secure: secureOrigin, httpOnly: true, sameSite: 'lax' });
    await control.release(s.id);
    return reply.code(204).send();
  });
  app.get('/api/dashboard', async (request) => { controlled(request); return await dashboardUpdates.refresh(); });
  app.post('/api/dashboard/ticket', async (request) => { const s = controlled(request, true); return { ticket: tickets.mint(s.id, 'dashboard', 'dashboard').id }; });
  app.get('/api/cleanup', async (request) => { controlled(request); const targets = await cleanup.scan(); await dashboardUpdates.refresh().catch(() => undefined); return { targets }; });
  app.post('/api/cleanup', async (request, reply) => {
    controlled(request, true);
    const targets = await cleanup.cleanup(body(request).targetIds);
    if (targets === undefined) return reply.code(400).send({ error: 'invalid cleanup targets' });
    await dashboardUpdates.refresh().catch(() => undefined);
    return { targets };
  });
  const configuredWorktree = (id: string) => worktreeById(discovery.worktreesNow(), id);
  // the Place with this id: a Worktree from the current snapshot, else a directory-Project or
  // Scratch Place the dashboard lists (the configured ones always; an ad-hoc Scratch folder while
  // it holds an Agent, a Console shell or a pin)
  const resolvePlace = async (id: string): Promise<Place | undefined> => {
    const worktree = configuredWorktree(id);
    return worktree === undefined ? await discovery.place(id) : worktreePlace(worktree);
  };
  // bind configured actions to existing host, prompt and normal-launch engines
  const buttonActions = deps.buttonActions ?? new ButtonActionService(buttonCatalog, {
    resolvePlace,
    agents: async () => (await discovery.dashboard()).agents,
    prompts,
    // refresh only the exact Agent whose tracked request is being observed
    observePrompt: async agentId => {
      const target = await discovery.target(agentId, true);
      // a temporary listing failure is handled by the prompt engine's departure grace
      if (target !== undefined) await prompts.observe(target.agent);
      else await prompts.retireDeparted((await discovery.dashboard()).agents.map(agent => agent.id));
    },
    // retain signed directory authority until the host has opened the cwd
    directoryLease: async (place, sessionId, token) => {
      try { return await hostFiles.resolveDirectoryCapability(place, { id: sessionId }, token); }
      catch (error) { throw new ButtonActionError('files_context_changed', error instanceof HostFilesError ? error.statusCode : 503); }
    },
    shell: new HostCommandRunner(config),
    // snapshot, launch and wait through the same normal choice as Workspace Launch
    launchAgent: async place => {
      // ad-hoc folders have no normal Launch choice of their own
      if (place.adhoc === true) return undefined;
      let found: Agent | undefined;
      const outcome = await launchFresh({
        agentIds: async () => new Set((await discovery.dashboard()).agents.map(agent => agent.id)),
        // preserve remembered Worktree, Project and Scratch launch profiles
        launch: async () => await launch.launchAt(place),
        waitForNewAgent: async before => await waitForAgent(before, atPlace(place.id)),
        waitForReadiness,
        close: async agentId => await prompts.close(agentId),
        // delivery belongs to the tracked prompt path after readiness succeeds
        deliver: async agent => { found = agent; return true; }
      });
      return outcome.status === 'launched' ? found : undefined;
    }
  });
  // start only server-resolved definitions under the current controller and CSRF boundary
  app.post('/api/button-actions', { bodyLimit: 32_768, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (request, reply) => {
    const current = controlled(request, true);
    const parsed = buttonActionInputSchema.safeParse(request.body);
    // raw commands, prompts and cwd values are never accepted here
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_button_action' });
    try { return reply.code(202).send({ operation: await buttonActions.start(current.id, parsed.data) }); }
    catch (error) {
      // return only bounded action codes rather than trusted executable content
      if (error instanceof ButtonActionError) return reply.code(error.statusCode).send({ error: error.code });
      return reply.code(503).send({ error: 'button_action_unavailable' });
    }
  });
  // keep operation polling private to its originating active browser session
  app.get('/api/button-actions/:id', async (request, reply) => {
    const current = controlled(request);
    const id = (request.params as { id: string }).id;
    // reject malformed locators before inspecting any engine state
    if (!/^[A-Za-z0-9_-]{24,128}$/u.test(id)) return reply.code(404).send({ error: 'button_action_unavailable' });
    try { return { operation: await buttonActions.status(current.id, id) }; }
    catch (error) {
      // unknown and foreign operation locators remain indistinguishable
      if (error instanceof ButtonActionError) return reply.code(error.statusCode).send({ error: error.code });
      return reply.code(503).send({ error: 'button_action_unavailable' });
    }
  });
  // share existing Place resolution and authentication without relaxing legacy previews
  await registerHostFilesRoutes(app, { service: hostFiles, controlled, resolvePlace, downloadTickets: tickets });
  // a Place's notes key (placeNoteKey): a Worktree's Project, else the Place folder's hash
  const placeSaveKey = async (id: string): Promise<string | undefined> => {
    const place = await resolvePlace(id);
    return place === undefined ? undefined : placeNoteKey(place);
  };
  // The refusal for a Worktree-only route whose id is no Worktree: 409 for a directory-Project or
  // Scratch Place, 404 for an id that is no Place at all. Each route may keep its own body shape.
  const notGitCheckout = { error: 'Only a worktree supports this; this place is not a git checkout.' };
  const nonWorktreeReply = async (id: string, reply: FastifyReply, bodies: { missing?: unknown; refused?: unknown } = {}) =>
    await resolvePlace(id) === undefined ? reply.code(404).send(bodies.missing ?? { error: 'worktree unavailable' }) : reply.code(409).send(bodies.refused ?? notGitCheckout);
  // the anchor for a Schedule's displayed next-run and its firing: a restart never replays a missed
  // instant. Injectable so tests can place boot before a due instant they mean to fire.
  const scheduleBootAt = deps.scheduleBootAt ?? new Date();
  // serialize schedule execution and deletion around each canonical note
  const scheduleRunsInFlight = new Set<string>();
  const noteDeletionsInFlight = new Set<string>();
  const deleteNoteWithUndo = async (saveKey: string, noteId: string) => {
    const resolved = await notes.resolve(saveKey, noteId);
    // hide notes outside the requesting scope
    if (resolved === undefined) return undefined;
    const flightKey = `${resolved.key}:${noteId}`;
    // let the operation that claimed this canonical note finish first
    if (scheduleRunsInFlight.has(flightKey)) return 'schedule-running' as const;
    if (noteDeletionsInFlight.has(flightKey)) return 'deleting' as const;
    noteDeletionsInFlight.add(flightKey);
    try {
      return await notes.deleteWithUndo(saveKey, noteId);
    } finally {
      noteDeletionsInFlight.delete(flightKey);
    }
  };
  // summarize attachment bytes and add the server-computed next run
  const decorateNote = (note: WorktreeNote) => {
    const { attachments, ...safe } = note;
    return {
      ...safe,
      ...(attachments === undefined ? {} : { attachments: attachments.map(attachment => ({ name: attachment.name, size: promptAttachmentBytes(attachment)! })) }),
      ...(note.schedule === undefined ? {} : { nextRun: scheduleNextRun(note.schedule, scheduleBootAt)?.toISOString() })
    };
  };
  const decorateNotes = (stored: WorktreeNote[]) => stored.map(decorateNote);
  // notify every open dashboard that note metadata changed
  const publishNotesRevision = () => {
    notesRevision += 1;
    // follow an overlapping refresh when it captured the prior revision
    void dashboardUpdates.refresh().then(snapshot => snapshot?.notesRevision === notesRevision ? undefined : dashboardUpdates.refresh()).catch(() => undefined);
  };
  // publish mutations that can change another workspace's visible note
  const publishSharedNoteRevision = (note: WorktreeNote) => {
    // keep isolated note autosaves local
    if (note.allWorkspaces === true) publishNotesRevision();
  };
  // preview one stored attachment without filesystem resolution
  const previewNoteAttachment = async (saveKey: string, noteId: string, path: string) => {
    const attachments = await notes.attachments(saveKey, noteId);
    const attachment = attachments?.find(candidate => candidate.name === path);
    // hide unknown notes and attachment names alike
    if (attachment === undefined) return undefined;
    const bytes = promptAttachmentData(attachment.data);
    // persisted notes are validated, but fail closed if storage is corrupted
    return bytes === undefined ? undefined : previewFileBytes(attachment.name, bytes);
  };
  // resolve a Schedule notification's operator-facing "<Project | Scratch>" label and, for a Worktree
  // target, its wire id (the service worker deep-links to the Worktree). A Worktree resolves to its
  // Project's label; a gone Worktree falls back to a generic word so a "target is gone" skip still notifies.
  const resolveScheduleTarget = (target: ScheduleTarget): { label: string; worktreeId?: string } => {
    if ('scratch' in target) return { label: 'Scratch' };
    if ('worktreeId' in target) {
      const worktree = configuredWorktree(target.worktreeId);
      return { label: discovery.projectsNow().find(project => project.id === worktree?.projectId)?.label ?? worktree?.label ?? 'a worktree', worktreeId: target.worktreeId };
    }
    return { label: config.projects.find(project => project.id === target.projectId)?.label ?? 'a project' };
  };
  // validate a set-schedule body into a Schedule, or return the operator-facing reason it was refused;
  // launchability is checked at Run time, since configuration can change — here only existence and shape
  const buildSchedule = (raw: Record<string, unknown>): Schedule | string => {
    if (typeof raw.cron !== 'string' || raw.cron.length > 200) return 'invalid cron expression';
    const error = cronError(raw.cron);
    if (error !== undefined) return error;
    if (typeof raw.kind !== 'string' || !(agentKinds as readonly string[]).includes(raw.kind)) return 'unknown agent kind';
    const target = raw.target;
    if (!validScheduleTarget(target)) return 'invalid schedule target';
    if ('worktreeId' in target) {
      const worktree = configuredWorktree(target.worktreeId);
      if (worktree === undefined) return 'target worktree not found';
      // an implicit Project lasts only while something runs there or it is pinned (ADR 0014)
      if (discovery.projectsNow().some(project => project.id === worktree.projectId && project.implicit === true)) return 'target worktree is not in a configured project';
    }
    if ('projectId' in target) {
      const projectId = target.projectId;
      const project = config.projects.find(candidate => candidate.id === projectId);
      if (project === undefined || !project.available || project.mode !== 'directory') return 'target project unavailable';
    }
    if (typeof raw.enabled !== 'boolean') return 'invalid enabled flag';
    return { cron: raw.cron, kind: raw.kind as AgentKind, target, enabled: raw.enabled, updatedAt: new Date().toISOString() };
  };
  // resolve durable persistence for one live agent
  // where an Agent running at `home` keeps its notes
  const homePersistence = async ({ home, placeId }: QueuedPromptOrigin) => {
    const worktree = configuredWorktreeForWorkspace(discovery.worktreesNow(), home);
    // an Agent with no Worktree of its own keeps its notes with its Place, so an Agent in a
    // subfolder of a directory Project or Scratch folder shares the notes its Place tab shows
    const place = worktree === undefined && placeId !== undefined ? await resolvePlace(placeId) : undefined;
    const saveKey = worktree?.projectId ?? (place === undefined ? folderNoteKey(home) : placeNoteKey(place));
    return { worktree, saveKey, noteLabel: worktree?.label ?? place?.label ?? (basename(home) || 'workspace') };
  };
  const agentPersistence = async (id: string) => {
    const target = await discovery.target(id);
    // require one current agent target
    if (target === undefined) return undefined;
    return { agent: target.agent, ...await homePersistence(target.agent) };
  };
  // resolve one queue scope to its note key and current operator-facing label
  const notePersistenceForQueueScope = async (scope: string, prompt: QueuedPrompt): Promise<{ saveKey: string; noteLabel: string } | undefined> => {
    // a departed Agent's prompts go where it ran; one queued before origins were kept needs its live home
    if (scope.startsWith('agent:')) return await agentPersistence(scope.slice('agent:'.length)) ?? (prompt.origin === undefined ? undefined : await homePersistence(prompt.origin));
    const worktree = configuredWorktree(scope);
    const fallbackPath = worktreePathOf(scope) ?? scope;
    return { saveKey: projectIdOf(scope), noteLabel: worktree?.label ?? (basename(fallbackPath) || 'workspace') };
  };
  // create one queued prompt note and advance its dashboard revision
  const createQueuedPromptNote = async (persistence: { saveKey: string; noteLabel: string }, prompt: QueuedPrompt): Promise<WorktreeNote | undefined> => {
    const content = promptNoteContent(persistence.noteLabel, new Date(), prompt);
    const note = await notes.createWithText(persistence.saveKey, content.title, content.text, 'queued-prompt', content.attachments ?? []);
    // publish only durable queue-created notes
    if (note !== undefined) notesRevision += 1;
    return note;
  };
  // the PromptService's drain sink creates the same queued prompt notes as explicit Save
  const drainUndelivered = async (scope: string, prompt: QueuedPrompt): Promise<boolean> => {
    const persistence = await notePersistenceForQueueScope(scope, prompt);
    // retain the prompt when scratch persistence disappeared
    if (persistence === undefined) return false;
    return await createQueuedPromptNote(persistence, prompt) !== undefined;
  };
  // resolve the observed branch for one configured worktree
  const reviewBranch = async (id: string): Promise<string | undefined> => {
    const discovered = await discovery.dashboard();
    return discovered.agents.find(agent => agent.worktreeId === id)?.branch ?? discovered.projects.flatMap(project => project.worktrees).find(worktree => worktree.id === id)?.branch;
  };
  app.get('/api/worktrees/:id/notes', async (request, reply) => { controlled(request); const id = (request.params as { id: string }).id; const saveKey = await placeSaveKey(id); if (saveKey === undefined) return reply.code(404).send({ error: 'place unavailable' }); const stored = await notes.list(saveKey); return stored === undefined ? reply.code(400).send({ error: 'invalid place' }) : { notes: decorateNotes(stored) }; });
  // pin or unpin one Place so it keeps (or drops) its tab while idle; the override is stored in
  // `.data` under the Place id, discovery re-reads it on the next tick
  app.post('/api/worktrees/:id/pin', async (request, reply) => {
    controlled(request, true);
    const id = (request.params as { id: string }).id;
    const pinned = body(request).pinned;
    const place = await resolvePlace(id);
    // require one known Place and an explicit pin state
    if (place === undefined) return reply.code(404).send({ error: 'place unavailable' });
    if (typeof pinned !== 'boolean') return reply.code(400).send({ error: 'invalid pin state' });
    // a Worktree's override may unpin a Main checkout; any other Place defaults to unpinned, so
    // unpinning it clears the record rather than leaving a `pinned: false` behind
    await worktreeStore.setPinned(id, pinned || place.kind === 'worktree' ? pinned : undefined);
    discovery.invalidateWorktrees();
    await dashboardUpdates.refresh().catch(() => undefined);
    return reply.code(204).send();
  });
  // set or clear one Worktree's durable display label
  app.patch('/api/worktrees/:id/label', async (request, reply) => {
    controlled(request, true);
    const id = (request.params as { id: string }).id;
    const requestedLabel = body(request).label;
    // require one known Worktree before writing operator state. A directory Project's label is
    // its configured one and a Scratch Place's is fixed, so neither is relabelled.
    if (configuredWorktree(id) === undefined) return await nonWorktreeReply(id, reply, { refused: { error: 'Only a worktree can be renamed; a project or Scratch label is fixed.' } });
    // null restores the generated Project/branch label
    if (requestedLabel !== null && typeof requestedLabel !== 'string') return reply.code(400).send({ error: 'invalid worktree label' });
    const label = typeof requestedLabel === 'string' ? requestedLabel.trim() : undefined;
    // keep labels bounded and single-line
    if (label !== undefined && (label.length === 0 || label.length > 120 || /[\0-\x1f\x7f]/u.test(label))) return reply.code(400).send({ error: 'invalid worktree label' });
    await worktreeStore.setLabel(id, label);
    discovery.invalidateWorktrees();
    // publish independently so a slow dashboard scan never blocks the saved response
    void dashboardUpdates.refresh().catch(() => undefined);
    return reply.code(204).send();
  });
  // create an optionally titled note
  app.post('/api/worktrees/:id/notes', { bodyLimit: noteAttachmentBodyLimit }, async (request, reply) => {
    controlled(request, true);
    const id = (request.params as { id: string }).id;
    const saveKey = await placeSaveKey(id);
    const data = body(request);
    const title = data.title;
    const text = data.text;
    const attachments = promptAttachments(data.attachments);
    // require a current Place
    if (saveKey === undefined) return reply.code(404).send({ error: 'place unavailable' });
    // validate the optional title
    if (title !== undefined && (typeof title !== 'string' || !title.trim() || title.length > 120 || title.includes('\0'))) return reply.code(400).send({ error: 'invalid note title' });
    // validate the optional text
    if (text !== undefined && (typeof text !== 'string' || text.length > 30_000 || text.includes('\0'))) return reply.code(400).send({ error: 'invalid note' });
    // validate attachment records and byte limits
    if (attachments === undefined || !validPromptAttachments(attachments)) return reply.code(400).send({ error: 'invalid attachments' });
    // atomic initial content requires a title
    if ((text !== undefined || attachments.length > 0) && typeof title !== 'string') return reply.code(400).send({ error: 'invalid note title' });
    const note = text === undefined && attachments.length === 0
      ? await notes.create(saveKey, title as string | undefined)
      : await notes.createWithText(saveKey, title as string, typeof text === 'string' ? text : '', undefined, attachments);
    return note === undefined ? reply.code(409).send({ error: 'note limit reached' }) : reply.code(201).send(decorateNote(note));
  });
  // update one worktree note's text
  app.put('/api/worktrees/:id/notes/:noteId', { bodyLimit: 128_000 }, async (request, reply) => {
    controlled(request, true);
    const { id, noteId } = request.params as { id: string; noteId: string };
    const saveKey = await placeSaveKey(id);
    const text = body(request).text;
    // require one current place
    if (saveKey === undefined) return reply.code(404).send({ error: 'place unavailable' });
    // require bounded note content
    if (typeof text !== 'string' || text.length > 30_000 || text.includes('\0')) return reply.code(400).send({ error: 'invalid note' });
    const note = await notes.update(saveKey, noteId, text);
    // hide unknown notes
    if (note === undefined) return reply.code(404).send({ error: 'note unavailable' });
    publishSharedNoteRevision(note);
    return decorateNote(note);
  });
  // rename one note
  app.patch('/api/worktrees/:id/notes/:noteId', async (request, reply) => {
    controlled(request, true);
    const { id, noteId } = request.params as { id: string; noteId: string };
    const saveKey = await placeSaveKey(id);
    const title = body(request).title;
    // require one current place
    if (saveKey === undefined) return reply.code(404).send({ error: 'place unavailable' });
    // require one bounded title
    if (typeof title !== 'string' || !title.trim() || title.length > 120 || title.includes('\0')) return reply.code(400).send({ error: 'invalid note title' });
    const note = await notes.rename(saveKey, noteId, title);
    // hide unknown notes
    if (note === undefined) return reply.code(404).send({ error: 'note unavailable' });
    publishSharedNoteRevision(note);
    return decorateNote(note);
  });
  // set one worktree note's deletion lock
  app.put('/api/worktrees/:id/notes/:noteId/lock', async (request, reply) => {
    controlled(request, true);
    const { id, noteId } = request.params as { id: string; noteId: string };
    const saveKey = await placeSaveKey(id);
    const locked = body(request).locked;
    // require one current Place
    if (saveKey === undefined) return reply.code(404).send({ error: 'place unavailable' });
    // require an explicit boolean state
    if (typeof locked !== 'boolean') return reply.code(400).send({ error: 'invalid note lock' });
    const note = await notes.setLocked(saveKey, noteId, locked);
    // hide unknown notes
    if (note === undefined) return reply.code(404).send({ error: 'note unavailable' });
    publishNotesRevision();
    return decorateNote(note);
  });
  // set one worktree note's cross-workspace visibility
  app.put('/api/worktrees/:id/notes/:noteId/visibility', async (request, reply) => {
    controlled(request, true);
    const { id, noteId } = request.params as { id: string; noteId: string };
    const saveKey = await placeSaveKey(id);
    const allWorkspaces = body(request).allWorkspaces;
    // require one current place
    if (saveKey === undefined) return reply.code(404).send({ error: 'place unavailable' });
    // require an explicit boolean state
    if (typeof allWorkspaces !== 'boolean') return reply.code(400).send({ error: 'invalid note visibility' });
    const resolved = await notes.setVisibility(saveKey, noteId, allWorkspaces);
    // hide unknown and inaccessible notes
    if (resolved === undefined) return reply.code(404).send({ error: 'note unavailable' });
    publishNotesRevision();
    return { ...decorateNote(resolved.note), visibleHere: resolved.key === saveKey || resolved.note.allWorkspaces === true };
  });
  // delete one unlocked worktree note
  app.delete('/api/worktrees/:id/notes/:noteId', async (request, reply) => {
    controlled(request, true);
    const { id, noteId } = request.params as { id: string; noteId: string };
    const saveKey = await placeSaveKey(id);
    // require one current Place
    if (saveKey === undefined) return reply.code(404).send({ error: 'place unavailable' });
    const deletion = await deleteNoteWithUndo(saveKey, noteId);
    // preserve the run outcome while external schedule work is active
    if (deletion === 'schedule-running') return reply.code(409).send({ error: 'note schedule run is in progress' });
    if (deletion === 'deleting') return reply.code(409).send({ error: 'note deletion is in progress' });
    // distinguish durable locks from missing notes
    if (deletion === 'locked') return reply.code(409).send({ error: 'note is locked' });
    // hide unknown notes
    if (deletion === undefined) return reply.code(404).send({ error: 'note unavailable' });
    publishNotesRevision();
    return { ...decorateNote(deletion.note), undoToken: deletion.undoToken };
  });
  // restore one recently deleted note without accepting client-owned note data
  app.post('/api/notes/deletions/:token/undo', async (request, reply) => {
    controlled(request, true);
    const token = (request.params as { token: string }).token;
    const restored = await notes.undoDeletion(token);
    // distinguish retryable storage conflicts from unavailable tokens
    if (restored === 'gone') return reply.code(404).send({ error: 'note deletion unavailable' });
    if (restored === 'conflict') return reply.code(409).send({ error: 'note already exists' });
    if (restored === 'limit') return reply.code(409).send({ error: 'note limit reached' });
    publishNotesRevision();
    return decorateNote(restored);
  });
  // read full attachment payloads for one worktree note
  app.get('/api/worktrees/:id/notes/:noteId/attachments', async (request, reply) => {
    controlled(request);
    const { id, noteId } = request.params as { id: string; noteId: string };
    const saveKey = await placeSaveKey(id);
    if (saveKey === undefined) return reply.code(404).send({ error: 'place unavailable' });
    const attachments = await notes.attachments(saveKey, noteId);
    return attachments === undefined ? reply.code(404).send({ error: 'note unavailable' }) : { attachments };
  });
  // preview one worktree-note attachment from its stored bytes
  app.post('/api/worktrees/:id/notes/:noteId/attachments/preview', async (request, reply) => {
    controlled(request, true);
    const { id, noteId } = request.params as { id: string; noteId: string };
    const saveKey = await placeSaveKey(id);
    const path = body(request).path;
    // require one canonical attachment name
    if (typeof path !== 'string' || promptAttachmentName(path) !== path) return reply.code(400).send({ error: 'invalid attachment path' });
    // require one current Place
    if (saveKey === undefined) return reply.code(404).send({ error: 'place unavailable' });
    const preview = await previewNoteAttachment(saveKey, noteId, path);
    return preview === undefined ? reply.code(404).send({ error: 'attachment unavailable' }) : preview;
  });
  // append attachment payloads to one worktree note
  app.post('/api/worktrees/:id/notes/:noteId/attachments', { bodyLimit: noteAttachmentBodyLimit }, async (request, reply) => {
    controlled(request, true);
    const { id, noteId } = request.params as { id: string; noteId: string };
    const saveKey = await placeSaveKey(id);
    const attachments = promptAttachments(body(request).attachments);
    if (saveKey === undefined) return reply.code(404).send({ error: 'place unavailable' });
    if (attachments === undefined || attachments.length === 0 || !validPromptAttachments(attachments)) return reply.code(400).send({ error: 'invalid attachments' });
    const note = await notes.appendAttachments(saveKey, noteId, attachments);
    if (note === undefined) return reply.code(404).send({ error: 'note unavailable' });
    // reject additions that exceed note or storage limits
    if (note === 'invalid') return reply.code(400).send({ error: 'invalid attachments' });
    publishSharedNoteRevision(note);
    return decorateNote(note);
  });
  // remove one normalized attachment name from a worktree note
  app.delete('/api/worktrees/:id/notes/:noteId/attachments', async (request, reply) => {
    controlled(request, true);
    const { id, noteId } = request.params as { id: string; noteId: string };
    const name = (request.query as { name?: unknown }).name;
    const saveKey = await placeSaveKey(id);
    if (saveKey === undefined) return reply.code(404).send({ error: 'place unavailable' });
    if (typeof name !== 'string' || promptAttachmentName(name) === undefined) return reply.code(400).send({ error: 'invalid attachment name' });
    const note = await notes.removeAttachment(saveKey, noteId, name);
    // hide unknown attachments
    if (note === undefined) return reply.code(404).send({ error: 'attachment unavailable' });
    publishSharedNoteRevision(note);
    return decorateNote(note);
  });
  // set or replace one note's Schedule
  app.put('/api/worktrees/:id/notes/:noteId/schedule', async (request, reply) => {
    controlled(request, true);
    const { id, noteId } = request.params as { id: string; noteId: string };
    const saveKey = await placeSaveKey(id);
    // require one current place
    if (saveKey === undefined) return reply.code(404).send({ error: 'place unavailable' });
    const schedule = buildSchedule(body(request));
    // reject malformed schedules
    if (typeof schedule === 'string') return reply.code(400).send({ error: schedule });
    const note = await notes.setSchedule(saveKey, noteId, schedule);
    // hide unknown notes
    if (note === undefined) return reply.code(404).send({ error: 'note unavailable' });
    publishSharedNoteRevision(note);
    return decorateNote(note);
  });
  // remove one note's Schedule, keeping the note
  app.delete('/api/worktrees/:id/notes/:noteId/schedule', async (request, reply) => {
    controlled(request, true);
    const { id, noteId } = request.params as { id: string; noteId: string };
    const saveKey = await placeSaveKey(id);
    // require one current place
    if (saveKey === undefined) return reply.code(404).send({ error: 'place unavailable' });
    const note = await notes.removeSchedule(saveKey, noteId);
    // hide unknown notes
    if (note === undefined) return reply.code(404).send({ error: 'note unavailable' });
    publishSharedNoteRevision(note);
    return decorateNote(note);
  });
  // run one worktree note's Schedule now, exactly as the scheduler will
  app.post('/api/worktrees/:id/notes/:noteId/schedule/run', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => { controlled(request, true); const { id, noteId } = request.params as { id: string; noteId: string }; const saveKey = await placeSaveKey(id); if (saveKey === undefined) return reply.code(404).send({ error: 'place unavailable' }); return await runScheduleNow(saveKey, noteId, reply); });
  // list one live agent's notes
  app.get('/api/agents/:id/notes', async (request, reply) => {
    controlled(request);
    const persistence = await agentPersistence((request.params as { id: string }).id);
    // require one current persistence group
    if (persistence === undefined) return reply.code(404).send({ error: 'agent unavailable' });
    const stored = await notes.list(persistence.saveKey);
    return stored === undefined ? reply.code(400).send({ error: 'invalid note group' }) : { notes: decorateNotes(stored) };
  });
  // create one live agent note
  app.post('/api/agents/:id/notes', { bodyLimit: noteAttachmentBodyLimit }, async (request, reply) => {
    controlled(request, true);
    const persistence = await agentPersistence((request.params as { id: string }).id);
    const data = body(request);
    const title = data.title;
    const text = data.text;
    const attachments = promptAttachments(data.attachments);
    // require one current persistence group
    if (persistence === undefined) return reply.code(404).send({ error: 'agent unavailable' });
    // require one bounded optional title
    if (title !== undefined && (typeof title !== 'string' || !title.trim() || title.length > 120 || title.includes('\0'))) return reply.code(400).send({ error: 'invalid note title' });
    // require one bounded optional initial text
    if (text !== undefined && (typeof text !== 'string' || text.length > 30_000 || text.includes('\0'))) return reply.code(400).send({ error: 'invalid note' });
    // require valid attachment records and byte limits
    if (attachments === undefined || !validPromptAttachments(attachments)) return reply.code(400).send({ error: 'invalid attachments' });
    // initial content must carry a title and is written atomically
    if ((text !== undefined || attachments.length > 0) && typeof title !== 'string') return reply.code(400).send({ error: 'invalid note title' });
    const note = text === undefined && attachments.length === 0
      ? await notes.create(persistence.saveKey, typeof title === 'string' ? title : undefined)
      : await notes.createWithText(persistence.saveKey, title as string, typeof text === 'string' ? text : '', undefined, attachments);
    return note === undefined ? reply.code(409).send({ error: 'note limit reached' }) : reply.code(201).send(decorateNote(note));
  });
  // update one live agent note
  app.put('/api/agents/:id/notes/:noteId', { bodyLimit: 128_000 }, async (request, reply) => {
    controlled(request, true);
    const { id, noteId } = request.params as { id: string; noteId: string };
    const persistence = await agentPersistence(id);
    const text = body(request).text;
    // require one current persistence group
    if (persistence === undefined) return reply.code(404).send({ error: 'agent unavailable' });
    // require bounded note content
    if (typeof text !== 'string' || text.length > 30_000 || text.includes('\0')) return reply.code(400).send({ error: 'invalid note' });
    const note = await notes.update(persistence.saveKey, noteId, text);
    // hide unknown notes
    if (note === undefined) return reply.code(404).send({ error: 'note unavailable' });
    publishSharedNoteRevision(note);
    return decorateNote(note);
  });
  // rename one live agent note
  app.patch('/api/agents/:id/notes/:noteId', async (request, reply) => {
    controlled(request, true);
    const { id, noteId } = request.params as { id: string; noteId: string };
    const persistence = await agentPersistence(id);
    const title = body(request).title;
    // require one current persistence group
    if (persistence === undefined) return reply.code(404).send({ error: 'agent unavailable' });
    // require one bounded title
    if (typeof title !== 'string' || !title.trim() || title.length > 120 || title.includes('\0')) return reply.code(400).send({ error: 'invalid note title' });
    const note = await notes.rename(persistence.saveKey, noteId, title);
    // hide unknown notes
    if (note === undefined) return reply.code(404).send({ error: 'note unavailable' });
    publishSharedNoteRevision(note);
    return decorateNote(note);
  });
  // set one live agent note's deletion lock
  app.put('/api/agents/:id/notes/:noteId/lock', async (request, reply) => {
    controlled(request, true);
    const { id, noteId } = request.params as { id: string; noteId: string };
    const persistence = await agentPersistence(id);
    const locked = body(request).locked;
    // require one current persistence group
    if (persistence === undefined) return reply.code(404).send({ error: 'agent unavailable' });
    // require an explicit boolean state
    if (typeof locked !== 'boolean') return reply.code(400).send({ error: 'invalid note lock' });
    const note = await notes.setLocked(persistence.saveKey, noteId, locked);
    // hide unknown notes
    if (note === undefined) return reply.code(404).send({ error: 'note unavailable' });
    publishNotesRevision();
    return decorateNote(note);
  });
  // set one live agent note's cross-workspace visibility
  app.put('/api/agents/:id/notes/:noteId/visibility', async (request, reply) => {
    controlled(request, true);
    const { id, noteId } = request.params as { id: string; noteId: string };
    const persistence = await agentPersistence(id);
    const allWorkspaces = body(request).allWorkspaces;
    // require one current persistence group
    if (persistence === undefined) return reply.code(404).send({ error: 'agent unavailable' });
    // require an explicit boolean state
    if (typeof allWorkspaces !== 'boolean') return reply.code(400).send({ error: 'invalid note visibility' });
    const resolved = await notes.setVisibility(persistence.saveKey, noteId, allWorkspaces);
    // hide unknown and inaccessible notes
    if (resolved === undefined) return reply.code(404).send({ error: 'note unavailable' });
    publishNotesRevision();
    return { ...decorateNote(resolved.note), visibleHere: resolved.key === persistence.saveKey || resolved.note.allWorkspaces === true };
  });
  // delete one unlocked live agent note
  app.delete('/api/agents/:id/notes/:noteId', async (request, reply) => {
    controlled(request, true);
    const { id, noteId } = request.params as { id: string; noteId: string };
    const persistence = await agentPersistence(id);
    // require one current persistence group
    if (persistence === undefined) return reply.code(404).send({ error: 'agent unavailable' });
    const deletion = await deleteNoteWithUndo(persistence.saveKey, noteId);
    // preserve the run outcome while external schedule work is active
    if (deletion === 'schedule-running') return reply.code(409).send({ error: 'note schedule run is in progress' });
    if (deletion === 'deleting') return reply.code(409).send({ error: 'note deletion is in progress' });
    // distinguish durable locks from missing notes
    if (deletion === 'locked') return reply.code(409).send({ error: 'note is locked' });
    // hide unknown notes
    if (deletion === undefined) return reply.code(404).send({ error: 'note unavailable' });
    publishNotesRevision();
    return { ...decorateNote(deletion.note), undoToken: deletion.undoToken };
  });
  // read full attachment payloads for one live agent note
  app.get('/api/agents/:id/notes/:noteId/attachments', async (request, reply) => {
    controlled(request);
    const { id, noteId } = request.params as { id: string; noteId: string };
    const persistence = await agentPersistence(id);
    if (persistence === undefined) return reply.code(404).send({ error: 'agent unavailable' });
    const attachments = await notes.attachments(persistence.saveKey, noteId);
    return attachments === undefined ? reply.code(404).send({ error: 'note unavailable' }) : { attachments };
  });
  // preview one live-agent note attachment from its stored bytes
  app.post('/api/agents/:id/notes/:noteId/attachments/preview', async (request, reply) => {
    controlled(request, true);
    const { id, noteId } = request.params as { id: string; noteId: string };
    const persistence = await agentPersistence(id);
    const path = body(request).path;
    // require one canonical attachment name
    if (typeof path !== 'string' || promptAttachmentName(path) !== path) return reply.code(400).send({ error: 'invalid attachment path' });
    // require one live agent scope
    if (persistence === undefined) return reply.code(404).send({ error: 'agent unavailable' });
    const preview = await previewNoteAttachment(persistence.saveKey, noteId, path);
    return preview === undefined ? reply.code(404).send({ error: 'attachment unavailable' }) : preview;
  });
  // append attachment payloads to one live agent note
  app.post('/api/agents/:id/notes/:noteId/attachments', { bodyLimit: noteAttachmentBodyLimit }, async (request, reply) => {
    controlled(request, true);
    const { id, noteId } = request.params as { id: string; noteId: string };
    const persistence = await agentPersistence(id);
    const attachments = promptAttachments(body(request).attachments);
    if (persistence === undefined) return reply.code(404).send({ error: 'agent unavailable' });
    if (attachments === undefined || attachments.length === 0 || !validPromptAttachments(attachments)) return reply.code(400).send({ error: 'invalid attachments' });
    const note = await notes.appendAttachments(persistence.saveKey, noteId, attachments);
    if (note === undefined) return reply.code(404).send({ error: 'note unavailable' });
    // reject additions that exceed note or storage limits
    if (note === 'invalid') return reply.code(400).send({ error: 'invalid attachments' });
    publishSharedNoteRevision(note);
    return decorateNote(note);
  });
  // remove one normalized attachment name from a live agent note
  app.delete('/api/agents/:id/notes/:noteId/attachments', async (request, reply) => {
    controlled(request, true);
    const { id, noteId } = request.params as { id: string; noteId: string };
    const name = (request.query as { name?: unknown }).name;
    const persistence = await agentPersistence(id);
    if (persistence === undefined) return reply.code(404).send({ error: 'agent unavailable' });
    if (typeof name !== 'string' || promptAttachmentName(name) === undefined) return reply.code(400).send({ error: 'invalid attachment name' });
    const note = await notes.removeAttachment(persistence.saveKey, noteId, name);
    // hide unknown attachments
    if (note === undefined) return reply.code(404).send({ error: 'attachment unavailable' });
    publishSharedNoteRevision(note);
    return decorateNote(note);
  });
  // set or replace one live agent note's Schedule
  app.put('/api/agents/:id/notes/:noteId/schedule', async (request, reply) => {
    controlled(request, true);
    const { id, noteId } = request.params as { id: string; noteId: string };
    const persistence = await agentPersistence(id);
    if (persistence === undefined) return reply.code(404).send({ error: 'agent unavailable' });
    const schedule = buildSchedule(body(request));
    if (typeof schedule === 'string') return reply.code(400).send({ error: schedule });
    const note = await notes.setSchedule(persistence.saveKey, noteId, schedule);
    // hide unknown notes
    if (note === undefined) return reply.code(404).send({ error: 'note unavailable' });
    publishSharedNoteRevision(note);
    return decorateNote(note);
  });
  // remove one live agent note's Schedule, keeping the note
  app.delete('/api/agents/:id/notes/:noteId/schedule', async (request, reply) => {
    controlled(request, true);
    const { id, noteId } = request.params as { id: string; noteId: string };
    const persistence = await agentPersistence(id);
    if (persistence === undefined) return reply.code(404).send({ error: 'agent unavailable' });
    const note = await notes.removeSchedule(persistence.saveKey, noteId);
    // hide unknown notes
    if (note === undefined) return reply.code(404).send({ error: 'note unavailable' });
    publishSharedNoteRevision(note);
    return decorateNote(note);
  });
  // run one live agent note's Schedule now, exactly as the scheduler will
  app.post('/api/agents/:id/notes/:noteId/schedule/run', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    controlled(request, true);
    const { id, noteId } = request.params as { id: string; noteId: string };
    const persistence = await agentPersistence(id);
    if (persistence === undefined) return reply.code(404).send({ error: 'agent unavailable' });
    return await runScheduleNow(persistence.saveKey, noteId, reply);
  });
  // preview a cron expression's next three instants in the console's own zone
  app.get('/api/schedule/preview', async (request, reply) => {
    controlled(request);
    const cron = (request.query as { cron?: unknown }).cron;
    if (typeof cron !== 'string' || cron.length > 200) return reply.code(400).send({ error: 'invalid cron expression' });
    const error = cronError(cron);
    if (error !== undefined) return reply.code(400).send({ error });
    return { next: (previewRuns(cron, new Date(), 3) ?? []).map(run => run.toISOString()) };
  });
  // the current Conversation id of a live agent, but only when it is open on this very
  // Worktree — a sibling-Worktree agent, a stale agentId, or an unresolvable Conversation
  // marks nothing current (used by the conversations listing route)
  const currentConversationOnWorktree = async (worktreeId: string, agentId: string): Promise<string | undefined> => {
    const target = await discovery.target(agentId);
    const targetWorktree = target === undefined ? undefined : configuredWorktreeForWorkspace(discovery.worktreesNow(), target.agent.home);
    return targetWorktree?.id === worktreeId ? discovery.conversationId(agentId) : undefined;
  };
  // a Project's current Worktree directories mapped to their Worktree id: the host-visible
  // checkout root each Conversation is started in (the cwd an Adapter's `list` scans and
  // reports on each row), so a listed row's directory resolves back to its Worktree
  const projectConversationScope = (projectId: string): Map<string, string> => {
    const scope = new Map<string, string>();
    for (const worktree of discovery.worktreesNow()) if (worktree.projectId === projectId) scope.set(worktreeHostRoot(worktree), worktree.id);
    return scope;
  };
  // list the Named conversations under these directories, resolve each row's Worktree, whether it
  // is the current one, and whether the console named it, and order the union newest-active first.
  // Codex and OMX share one rollout reader (ADR 0005), so the union emits a single codex-family row
  // per rollout; the console badges it with the Worktree's remembered Launch kind when that is codex
  // or omx, else codex (a Claude/Pi Worktree that also holds a Codex rollout still shows it as Codex).
  // the kind a shared codex-family rollout resumes under on one Worktree: its remembered
  // Launch kind when that is itself codex or omx, else Codex — the per-Worktree form of the
  // attribution `listConversations` applies across the whole list
  const rememberedCodexKind = async (worktreeId: string): Promise<AgentKind> => {
    const remembered = await worktreeStore.launchProfiles().catch(() => ({} as Record<string, AgentKind | undefined>));
    const kind = remembered[worktreeId];
    return kind !== undefined && codexFamily(kind) ? kind : 'codex';
  };
  // whether a listed row is one the console named: an intersection with the record store, so a
  // Conversation the agent no longer lists disappears with it (codex-family matched by id, ADR 0005)
  const rowConsoleNamed = (records: readonly ConsoleNamedConversation[], row: { kind: AgentKind; id: string }): boolean =>
    records.some(record => sameConversation(record, row));
  const listConversations = async (directories: readonly string[], scope: Map<string, string>, currentId: string | undefined, consoleNamedRecords: readonly ConsoleNamedConversation[]): Promise<ConversationRow[]> => {
    const listed = await discovery.conversations(directories);
    // read remembered kinds once, only when a codex-family row needs attributing
    const remembered = listed.some(row => codexFamily(row.kind))
      ? await worktreeStore.launchProfiles().catch(() => ({} as Record<string, AgentKind | undefined>))
      : {};
    const rows: ConversationRow[] = listed.map(row => {
      const worktreeId = scope.get(row.directory);
      const rememberedKind = worktreeId === undefined ? undefined : remembered[worktreeId];
      // a shared codex-family row follows the Worktree's remembered kind only when that is
      // itself codex or omx; anything else (Claude/Pi/unset) leaves the rollout badged Codex
      const kind = codexFamily(row.kind) ? (rememberedKind !== undefined && codexFamily(rememberedKind) ? rememberedKind : 'codex') : row.kind;
      return {
        kind,
        id: row.id,
        name: row.name,
        ...(row.automatic === undefined ? {} : { automatic: row.automatic }),
        lastActiveAt: row.lastActiveAt,
        directory: row.directory,
        ...(worktreeId === undefined ? {} : { worktreeId }),
        consoleNamed: rowConsoleNamed(consoleNamedRecords, { kind: row.kind, id: row.id }),
        reviewRun: isReviewRunName(row.name),
        current: currentId !== undefined && row.id === currentId,
      };
    });
    rows.sort((left, right) => right.lastActiveAt - left.lastActiveAt);
    return rows;
  };
  // the scan scope and directories for one live agent: its whole Project's Worktree host roots,
  // or just its own directory for a Scratch agent that has no Worktree to resume into
  const agentConversationScope = (persistence: NonNullable<Awaited<ReturnType<typeof agentPersistence>>>): { scope: Map<string, string>; directories: string[] } => {
    const scope = persistence.worktree === undefined ? new Map<string, string>() : projectConversationScope(persistence.worktree.projectId);
    return { scope, directories: persistence.worktree === undefined ? [persistence.agent.home] : [...scope.keys()] };
  };
  // list one Worktree's Project-wide Named conversations (every kind, every Worktree of the
  // Project); an optional live agent open on this Worktree marks the current row
  app.get('/api/worktrees/:id/conversations', async (request, reply) => {
    controlled(request);
    const id = (request.params as { id: string }).id;
    const agentId = (request.query as { agentId?: unknown }).agentId;
    const worktree = configuredWorktree(id);
    // require one configured Worktree
    if (worktree === undefined) return await nonWorktreeReply(id, reply);
    // reject malformed agent context
    if (agentId !== undefined && (typeof agentId !== 'string' || !agentId)) return reply.code(400).send({ error: 'invalid agent' });
    const scope = projectConversationScope(worktree.projectId);
    // resolve the current Conversation only for a live agent open on this very Worktree
    const currentId = typeof agentId === 'string' ? await currentConversationOnWorktree(id, agentId) : undefined;
    // a failed record read degrades to "nothing console-named" rather than dropping the list
    const records = await consoleNamed.list(worktree.projectId).catch(() => undefined) ?? [];
    const conversations = await listConversations([...scope.keys()], scope, currentId, records);
    return { conversations, canResume: launch.canResumeConversation(id) };
  });
  // list one live agent's Named conversations: its whole Project when it belongs to a
  // Worktree, or just its own directory for a Scratch agent (no Worktree to resume into)
  app.get('/api/agents/:id/conversations', async (request, reply) => {
    controlled(request);
    const id = (request.params as { id: string }).id;
    const persistence = await agentPersistence(id);
    // require one current agent target
    if (persistence === undefined) return reply.code(404).send({ error: 'agent unavailable' });
    const { scope, directories } = agentConversationScope(persistence);
    const currentId = await discovery.conversationId(id);
    // a failed record read degrades to "nothing console-named" rather than dropping the list
    const records = await consoleNamed.list(persistence.saveKey).catch(() => undefined) ?? [];
    const conversations = await listConversations(directories, scope, currentId, records);
    return { conversations, canResume: persistence.worktree !== undefined && launch.canResumeConversation(persistence.worktree.id) };
  });
  // the current Conversation's name, which titles the agent panel: one pane's by-id store read
  // (no scan of the agents' stores), so the panel can ask on mount and after Clear or naming
  app.get('/api/agents/:id/conversation', async (request, reply) => {
    controlled(request);
    const id = (request.params as { id: string }).id;
    if (await discovery.target(id) === undefined) return reply.code(404).send({ error: 'agent unavailable' });
    // an unreadable store degrades to an untitled Conversation, as the list does
    const conversation = await discovery.conversation(id).catch(() => undefined);
    return conversation?.title === undefined ? {} : { name: conversation.title };
  });
  // name the current Conversation from the console: submit the CLI's own rename command into the
  // pane (bypassing the prompt service — no history entry, no queued-prompt phase), confirm the
  // name from the agent's own store, then record that the console named it (ADR 0007). The name
  // itself lives only in the agent's store; the console keeps `{ kind, id, namedAt }`.
  app.post('/api/agents/:id/conversations/name', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    controlled(request, true);
    const id = (request.params as { id: string }).id;
    const requestedName = body(request).name;
    // require one bounded, single-line name with no control characters
    if (typeof requestedName !== 'string') return reply.code(400).send({ error: 'invalid conversation name' });
    const trimmed = requestedName.trim();
    if (trimmed.length === 0 || trimmed.length > 120 || /[\0-\x1f\x7f]/u.test(trimmed)) return reply.code(400).send({ error: 'invalid conversation name' });
    // the agents' own stores collapse runs of whitespace when they read a name back, so collapse
    // here too — otherwise the read-back of a name with interior double spaces never confirms
    const name = trimmed.replace(/\s+/gu, ' ');
    const persistence = await agentPersistence(id);
    // require one live agent
    if (persistence === undefined) return reply.code(404).send({ error: 'agent unavailable' });
    const conversations = adapterFor(persistence.agent.kind)?.conversations;
    // require an Adapter that both renames and reads the name back
    if (conversations?.rename === undefined || conversations.readName === undefined) return reply.code(409).send({ error: 'This agent cannot be named from the console.' });
    // one rename in flight per agent: a second pasted rename would race the first's read-back
    if (renamesInFlight.has(id)) return reply.code(409).send({ error: 'A rename is already in progress for this conversation.' });
    renamesInFlight.add(id);
    try {
      // refuse while a question dialog owns the keyboard — it would swallow the pasted rename.
      // force a fresh dashboard: this is a safety gate immediately before terminal input, so a
      // stale snapshot must not let the rename paste into a question that just appeared
      const observed = (await discovery.dashboard(true).catch(() => undefined))?.agents.find(agent => agent.id === id);
      if (observed !== undefined && agentAttentionState(observed) === 'question') return reply.code(409).send({ error: 'Answer the agent\'s question before naming this conversation.' });
      // require a known current Conversation to rename and to read back
      const conversationId = await discovery.conversationId(id);
      if (conversationId === undefined) return reply.code(409).send({ error: 'The current conversation is unknown.' });
      const target = await discovery.target(id);
      if (target === undefined) return reply.code(404).send({ error: 'agent unavailable' });
      // hold the agent's lifecycle mutation lock across the paste so a concurrent restart/switch
      // cannot close the pane mid-delivery (and so it, in turn, defers to this rename), exactly as
      // prompt submission does; a live restart reservation refuses the rename
      const releaseMutation = prompts.beginAgentMutation(id);
      if (releaseMutation === undefined) return reply.code(409).send({ error: 'The agent is busy with another operation.' });
      const rename = conversations.rename(name);
      const buffer = `rac-${randomBytes(18).toString('base64url')}`;
      try {
        // paste the Adapter's rename text and send its keys directly on the pane (Enter in every state)
        if (!await tmux.pastePrompt(target.socket, target.agent.paneId, buffer, rename.text)
          || !await tmux.sendKeys(target.socket, target.agent.paneId, rename.keys)) return reply.code(502).send({ error: 'Could not deliver the rename to the agent.' });
      } finally { releaseMutation(); }
      // read the name back from the agent's own store until it reports the submitted name
      const cwd = discovery.paneDirectory(id);
      let confirmed = false;
      for (let attempt = 0; attempt < conversationNamePollAttempts; attempt += 1) {
        await conversationNamePollDelay();
        const current = await conversations.readName(conversationId, cwd).catch(() => undefined);
        if (current === name) { confirmed = true; break; }
      }
      // the name may still have applied (it will show under All named), but the quick list is
      // "what I confirmed here", so an unconfirmed rename records nothing
      if (!confirmed) return reply.code(409).send({ error: 'The agent did not confirm the name.' });
      // the rename already applied and confirmed; a failed record write (a corrupt or locked store)
      // must not 500 the request — the row simply won't be console-named until the next successful name
      await consoleNamed.record(persistence.saveKey, { kind: persistence.agent.kind, id: conversationId }).catch(() => undefined);
      // return the freshly-listed row for the named Conversation (now console-named and current)
      const { scope, directories } = agentConversationScope(persistence);
      const stored = await consoleNamed.list(persistence.saveKey).catch(() => undefined) ?? [];
      const rows = await listConversations(directories, scope, conversationId, stored);
      const row = rows.find(candidate => sameConversation(candidate, { kind: persistence.agent.kind, id: conversationId }));
      return reply.code(201).send({ conversation: row });
    } finally {
      renamesInFlight.delete(id);
    }
  });
  // forget the console's record of one Conversation (Worktree-scoped, by kind and id). The
  // transcript and its name survive; the row leaves the quick list and stays under All named.
  app.delete('/api/worktrees/:id/conversations/:kind/:conversationId', async (request, reply) => {
    controlled(request, true);
    const { id, kind, conversationId } = request.params as { id: string; kind: string; conversationId: string };
    const saveKey = configuredWorktree(id)?.projectId;
    // require one configured Worktree group
    if (saveKey === undefined) return await nonWorktreeReply(id, reply);
    // reject an unknown kind
    if (!agentKinds.includes(kind as AgentKind)) return reply.code(400).send({ error: 'invalid conversation' });
    const removed = await consoleNamed.remove(saveKey, kind as AgentKind, conversationId);
    return removed ? reply.code(204).send() : reply.code(404).send({ error: 'conversation record unavailable' });
  });
  // the agent-scoped twin: a Scratch agent's records key to its home, not a Project
  app.delete('/api/agents/:id/conversations/:kind/:conversationId', async (request, reply) => {
    controlled(request, true);
    const { id, kind, conversationId } = request.params as { id: string; kind: string; conversationId: string };
    const persistence = await agentPersistence(id);
    // require one live agent
    if (persistence === undefined) return reply.code(404).send({ error: 'agent unavailable' });
    // reject an unknown kind
    if (!agentKinds.includes(kind as AgentKind)) return reply.code(400).send({ error: 'invalid conversation' });
    const removed = await consoleNamed.remove(persistence.saveKey, kind as AgentKind, conversationId);
    return removed ? reply.code(204).send() : reply.code(404).send({ error: 'conversation record unavailable' });
  });
  // preview one file in a Place
  app.post('/api/worktrees/:id/file-preview', async (request, reply) => {
    controlled(request, true);
    const { id } = request.params as { id: string };
    const path = body(request).path;
    // require one bounded relative path
    if (typeof path !== 'string' || !path || path.length > 512 || path.includes('\0')) return reply.code(400).send({ error: 'invalid file path' });
    const place = await resolvePlace(id);
    // require a known Place; a file preview reads the folder, no git needed
    if (place === undefined) return reply.code(404).send({ error: 'place unavailable' });
    const preview = await workspaceFiles.preview(place.home, path);
    return preview === undefined ? reply.code(404).send({ error: 'file unavailable' }) : preview;
  });
  // the git patch for a Comparison of one configured worktree (Working, All PR, or one commit): the
  // Changes with their per-file patch text, a content-sensitive fingerprint (for staleness), and per-file size-cap markers
  app.post('/api/worktrees/:id/comparison', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
    controlled(request, true);
    const { id } = request.params as { id: string };
    const scope = comparisonScope(request);
    // require Working, All PR, or a named commit
    if (scope === undefined) return reply.code(400).send({ error: 'invalid comparison' });
    const worktree = configuredWorktree(id);
    // require a configured workspace
    if (worktree === undefined) return await nonWorktreeReply(id, reply);
    const result = await comparison.patch(worktree, scope);
    // an unresolvable base, conflicted tree, or unavailable worktree has no Comparison to show
    return result.ok ? { kind: result.kind, ...result.patch } : reply.code(404).send({ error: 'comparison unavailable' });
  });
  // the commits an All PR Comparison spans, newest first, each with its own Changes; feeds the
  // branch fly-out's By commit grouping
  app.get('/api/worktrees/:id/commits', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
    controlled(request);
    const { id } = request.params as { id: string };
    const worktree = configuredWorktree(id);
    // require a configured workspace
    if (worktree === undefined) return await nonWorktreeReply(id, reply);
    const log = await comparison.commits(worktree);
    // no resolvable merge base, or git could not read the history
    return log ?? reply.code(404).send({ error: 'commits unavailable' });
  });
  // one changed file's contents at the Comparison base and at the working tree, feeding context
  // expansion / full-context mode; the path is allow-listed to the Comparison's Changes
  app.post('/api/worktrees/:id/comparison/file', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (request, reply) => {
    controlled(request, true);
    const { id } = request.params as { id: string };
    const scope = comparisonScope(request);
    const path = body(request).path;
    // require Working, All PR, or a named commit
    if (scope === undefined) return reply.code(400).send({ error: 'invalid comparison' });
    // require one bounded relative path
    if (typeof path !== 'string' || !path || path.length > 512 || path.includes('\0')) return reply.code(400).send({ error: 'invalid file path' });
    const worktree = configuredWorktree(id);
    // require a configured workspace
    if (worktree === undefined) return await nonWorktreeReply(id, reply);
    const result = await comparison.file(worktree, scope, path);
    // a path outside the Comparison, or a Comparison that will not resolve, is unavailable
    if (!result.ok) return reply.code(404).send({ error: result.reason === 'not_in_comparison' ? 'file unavailable' : 'comparison unavailable' });
    return { path: result.path, base: result.base ?? null, working: result.working ?? null };
  });
  // expose the persisted public identity only to an authenticated browser
  app.get('/api/push/public-key', async (request, reply) => {
    session(request);
    try {
      await push.initialize();
      return { publicKey: push.publicKey };
    } catch {
      return reply.code(503).send({ error: 'push_unavailable' });
    }
  });
  app.post('/api/push/subscriptions', async (request, reply) => { session(request, true); return await push.subscribe(body(request) as never) ? reply.code(204).send() : reply.code(400).send({ error: 'invalid push subscription' }); });
  // dismiss the viewed agent regardless of its current directory or workspace
  app.post('/api/agents/:id/notifications/dismiss', async (request, reply) => {
    controlled(request, true);
    const completionId = body(request).completionId;
    // reject malformed identities; omitted identities leave completions unchanged
    if (completionId !== undefined && typeof completionId !== 'string') return reply.code(400).send({ error: 'invalid completion id' });
    const target = await discovery.target((request.params as { id: string }).id);
    // reject agents that are no longer present
    if (!target) return reply.code(404).send({ error: 'target unavailable' });
    notifications.view(target.agent, completionId);
    return reply.code(204).send();
  });
  // a Worktree's pull requests and local branches, whether or not an Agent runs there
  app.get('/api/worktrees/:id/switch-prs', async (request, reply) => { controlled(request); const availability = await prSwitch.available((request.params as { id: string }).id); return availability === undefined ? reply.code(404).send({ error: 'pull request switching unavailable' }) : availability; });
  // the same list for the whole repository, with no worktree's checkout overlaid; it asks GitHub, so it shares the branch list's budget
  app.get('/api/projects/:id/switch-prs', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => { controlled(request); const list = await prSwitch.branchList((request.params as { id: string }).id); return list === undefined ? reply.code(404).send({ error: 'repository branch list unavailable' }) : list; });
  app.get('/api/agents/:id/github-actions', async (request, reply) => { controlled(request); const url = await prSwitch.actionsUrl((request.params as { id: string }).id); return url === undefined ? reply.code(404).send({ error: 'GitHub Actions unavailable' }) : { url }; });
  // a Worktree's GitHub Actions, for the Workspace toolbar's menu whether or not an Agent runs there
  app.get('/api/worktrees/:id/github-actions', async (request, reply) => {
    controlled(request);
    const worktree = configuredWorktree((request.params as { id: string }).id);
    const url = worktree === undefined ? undefined : await prSwitch.actionsUrlAt(worktree.identity);
    return url === undefined ? reply.code(404).send({ error: 'GitHub Actions unavailable' }) : { url };
  });
  // the review threads, review summaries and conversation on a Worktree branch's open pull request
  app.get('/api/worktrees/:id/pull-request/comments', async (request, reply) => {
    controlled(request);
    const id = (request.params as { id: string }).id;
    const worktree = configuredWorktree(id);
    if (worktree === undefined) return reply.code(404).send({ error: 'worktree unavailable' });
    try {
      return await prSwitch.commentsAt(worktree.identity, await reviewBranch(id));
    } catch (error) {
      if (error instanceof PullRequestLookupError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  });
  // a Worktree branch's saved All PR base (git config `gh-merge-base`) and the origin branches it may name
  app.get('/api/worktrees/:id/merge-base', async (request, reply) => {
    controlled(request);
    const worktree = configuredWorktree((request.params as { id: string }).id);
    if (worktree === undefined) return reply.code(404).send({ error: 'worktree unavailable' });
    const choices = await mergeBaseChoices(worktree.identity);
    return choices === undefined ? reply.code(409).send({ error: 'Could not list the branches on origin.' }) : choices;
  });
  // save (or, with `branch: null`, clear) the All PR base of the Worktree's branch
  app.put('/api/worktrees/:id/merge-base', async (request, reply) => {
    controlled(request, true);
    const worktree = configuredWorktree((request.params as { id: string }).id);
    if (worktree === undefined) return reply.code(404).send({ error: 'worktree unavailable' });
    const base = body(request).branch;
    if (base !== null && (typeof base !== 'string' || base === '' || base.length > 255)) return reply.code(400).send({ error: 'No base branch was named.' });
    const result = await saveMergeBase(worktree.identity, base);
    if (result === 'detached') return reply.code(409).send({ error: 'This worktree has no branch checked out.' });
    if (result === 'unknown_base') return reply.code(400).send({ error: `origin has no branch named ${base}.` });
    if (result === 'failed') return reply.code(409).send({ error: 'Could not save the base branch.' });
    discovery.invalidateWorktrees();
    await dashboardUpdates.refresh().catch(() => undefined);
    return reply.code(204).send();
  });
  app.post('/api/worktrees/:id/switch-pr', async (request, reply) => { controlled(request, true); const number = body(request).number; if (!Number.isInteger(number)) return reply.code(409).send({ error: 'That is not a valid pull request number.' }); const result = await prSwitch.switch((request.params as { id: string }).id, number as number); if (result === 'busy') return reply.code(409).send({ error: 'An agent in this worktree is busy. Wait for it to finish, then switch again.' }); if (result !== 'switched') return reply.code(409).send({ error: result.error }); discovery.invalidateWorktrees(); await dashboardUpdates.refresh().catch(() => undefined); return reply.code(202).send(); });
  // move one occupied pull request into the requested worktree
  app.post('/api/worktrees/:id/move-pr', async (request, reply) => { controlled(request, true); const number = body(request).number; if (!Number.isInteger(number)) return reply.code(409).send({ error: 'Unable to move that pull request. The destination must be clean and the source branch must still be open in another worktree.' }); const result = await prSwitch.move((request.params as { id: string }).id, number as number); if (result === 'busy') return reply.code(409).send({ error: 'An agent is busy. Wait for it to finish, then move the pull request again.' }); if (result === 'moved' || result === 'recovery-required') { discovery.invalidateWorktrees(); await dashboardUpdates.refresh().catch(() => undefined); } if (result === 'recovery-required') return reply.code(409).send({ error: 'The pull request move needs manual recovery. Check both worktrees; any unrecovered changes remain safely stored in Git stash.', recoveryRequired: true }); return result === 'moved' ? reply.code(202).send() : reply.code(409).send({ error: 'Unable to move that pull request. The destination must be clean and the source branch must still be open in another worktree.' }); });
  app.post('/api/worktrees/:id/switch-branch', async (request, reply) => { controlled(request, true); const branch = body(request).branch; if (typeof branch !== 'string') return reply.code(409).send({ error: 'No branch was named.' }); const result = await prSwitch.switchBranch((request.params as { id: string }).id, branch); if (result === 'busy') return reply.code(409).send({ error: 'An agent in this worktree is busy. Wait for it to finish, then switch again.' }); if (result !== 'switched') return reply.code(409).send({ error: result.error }); discovery.invalidateWorktrees(); await dashboardUpdates.refresh().catch(() => undefined); return reply.code(202).send(); });
  // move one occupied local branch into the requested worktree
  app.post('/api/worktrees/:id/move-branch', async (request, reply) => { controlled(request, true); const branch = body(request).branch; if (typeof branch !== 'string') return reply.code(409).send({ error: 'Unable to move that branch. The destination must be clean and the source branch must still be open in another worktree.' }); const result = await prSwitch.moveBranch((request.params as { id: string }).id, branch); if (result === 'busy') return reply.code(409).send({ error: 'An agent is busy. Wait for it to finish, then move the branch again.' }); if (result === 'moved' || result === 'recovery-required') { discovery.invalidateWorktrees(); await dashboardUpdates.refresh().catch(() => undefined); } if (result === 'recovery-required') return reply.code(409).send({ error: 'The branch move needs manual recovery. Check both worktrees; any unrecovered changes remain safely stored in Git stash.', recoveryRequired: true }); return result === 'moved' ? reply.code(202).send() : reply.code(409).send({ error: 'Unable to move that branch. The destination must be clean and the source branch must still be open in another worktree.' }); });
  app.get('/api/agents/:id/new-task', async (request, reply) => { controlled(request); const availability = await newTask.available((request.params as { id: string }).id); return availability === undefined ? reply.code(404).send({ error: 'new task unavailable' }) : availability; });
  app.post('/api/agents/:id/new-task', async (request, reply) => { controlled(request, true); if (!await newTask.start((request.params as { id: string }).id)) return reply.code(409).send({ error: 'Unable to start a new task. The working copy must be clean and pushed.' }); return reply.code(202).send(); });
  app.post('/api/agents/:id/prompt', { bodyLimit: Math.ceil(maxPromptAttachmentBytes * 1.4) }, async (request, reply) => {
    controlled(request, true);
    const data = body(request);
    const attachments = promptAttachments(data.attachments);
    if (typeof data.prompt !== 'string' || attachments === undefined || !validPrompt(data.prompt, attachments)) return reply.code(400).send({ error: 'invalid prompt' });
    if (!await prompts.submit((request.params as { id: string }).id, data.prompt, attachments)) return reply.code(404).send({ error: 'target unavailable' });
    return reply.code(204).send();
  });
  app.get('/api/agents/:id/prompt-history', async (request, reply) => { controlled(request); const id = (request.params as { id: string }).id; if (await discovery.target(id) === undefined) return reply.code(404).send({ error: 'target unavailable' }); const prompts = await promptHistory.list(promptScope(id)); return prompts === undefined ? reply.code(400).send({ error: 'invalid prompt history scope' }) : { prompts }; });
  app.get('/api/agents/:id/queued-prompts', async (request, reply) => { controlled(request); const queued = await prompts.listQueued((request.params as { id: string }).id); return queued === undefined ? reply.code(404).send({ error: 'target unavailable' }) : { prompts: queued }; });
  app.put('/api/agents/:id/queued-prompts/:promptId', async (request, reply) => { controlled(request, true); const { id, promptId } = request.params as { id: string; promptId: string }; const text = body(request).prompt; if (typeof text !== 'string') return reply.code(400).send({ error: 'invalid prompt' }); const prompt = await prompts.updateQueued(id, promptId, text); return prompt === undefined ? reply.code(404).send({ error: 'queued prompt unavailable' }) : prompt; });
  app.post('/api/agents/:id/queued-prompts/:promptId/move', async (request, reply) => { controlled(request, true); const { id, promptId } = request.params as { id: string; promptId: string }; const direction = body(request).direction; if (direction !== 'earlier' && direction !== 'later') return reply.code(400).send({ error: 'invalid queue direction' }); const queued = await prompts.moveQueued(id, promptId, direction); return queued === undefined ? reply.code(404).send({ error: 'queued prompt unavailable' }) : { prompts: queued }; });
  app.delete('/api/agents/:id/queued-prompts/:promptId', async (request, reply) => { controlled(request, true); const { id, promptId } = request.params as { id: string; promptId: string }; return await prompts.removeQueued(id, promptId) ? reply.code(204).send() : reply.code(404).send({ error: 'queued prompt unavailable' }); });
  app.get('/api/agents/:id/commands', async (request, reply) => {
    controlled(request);
    const target = await discovery.target((request.params as { id: string }).id);
    if (!target) return reply.code(404).send({ error: 'target unavailable' });
    const adapter = adapterFor(target.agent.kind);
    // an Adapter without a command catalog serves an empty one
    if (adapter === undefined) return { commands: [] };
    const worktree = configuredWorktreeForWorkspace(discovery.worktreesNow(), target.agent.home);
    // the Adapter resolves its own state directory (its skills root) from the environment
    const stateDirectory = adapter.commands?.stateDirectory() ?? '';
    return { commands: await commandCatalog.catalog(adapter, worktree?.path ?? target.agent.home, stateDirectory) };
  });
  // list workspace files referenced by one completed response
  app.post('/api/agents/:id/message-files', async (request, reply) => {
    controlled(request, true);
    const message = body(request).message;
    if (typeof message !== 'string' || message.length > 30_000 || message.includes('\0')) return reply.code(400).send({ error: 'invalid assistant message' });
    const target = await discovery.target((request.params as { id: string }).id);
    if (!target) return reply.code(404).send({ error: 'target unavailable' });
    const worktree = configuredWorktreeForWorkspace(discovery.worktreesNow(), target.agent.home);
    return { files: await workspaceFiles.list(worktree?.identity ?? target.agent.home, message) };
  });
  // preview one workspace file or bounded host temporary screenshot
  app.post('/api/agents/:id/file-preview', async (request, reply) => {
    controlled(request, true);
    const path = body(request).path;
    if (typeof path !== 'string' || !path || path.length > 512 || path.includes('\0')) return reply.code(400).send({ error: 'invalid file path' });
    const target = await discovery.target((request.params as { id: string }).id);
    if (!target) return reply.code(404).send({ error: 'target unavailable' });
    const worktree = configuredWorktreeForWorkspace(discovery.worktreesNow(), target.agent.home);
    const panePid = discovery.paneProcessId(target.agent.id);
    // fall back only to the image-only host temporary bridge
    const preview = await workspaceFiles.preview(worktree?.identity ?? target.agent.home, path) ?? await workspaceFiles.previewTemporaryImage(path, panePid);
    return preview === undefined ? reply.code(404).send({ error: 'file unavailable' }) : preview;
  });
  // save a queued prompt as a Note under the agent's note key, consuming the queued copy only once
  app.post('/api/agents/:id/queued-prompts/:promptId/save', async (request, reply) => {
    controlled(request, true);
    const { id, promptId } = request.params as { id: string; promptId: string };
    const persistence = await agentPersistence(id);
    if (persistence === undefined) return reply.code(404).send({ error: 'target unavailable' });
    let note: WorktreeNote | undefined;
    const result = await prompts.consumeQueuedOnSuccess(id, promptId, async queued => {
      // create before consuming the queue entry
      note = await createQueuedPromptNote(persistence, queued);
      return note !== undefined;
    });
    // distinguish missing prompts from note-store refusal
    if (result === 'missing') return reply.code(404).send({ error: 'queued prompt unavailable' });
    if (result === 'failed' || note === undefined) return reply.code(409).send({ error: 'unable to save queued prompt' });
    // publish the revision without delaying a durable save response
    void dashboardUpdates.refresh().catch(() => undefined);
    return reply.code(201).send(decorateNote(note));
  });
  app.post('/api/agents/:id/cancel', async (request, reply) => { controlled(request, true); const outcome = await prompts.cancel((request.params as { id: string }).id); if (outcome === 'unavailable') return reply.code(404).send({ error: 'target unavailable' }); if (outcome === 'not-working') return reply.code(409).send({ error: 'The agent is not working; there is nothing to interrupt.' }); return reply.code(204).send(); });
  // leave a tmux mode holding the Agent's pane (a picker opened by a hook): input is refused
  // there, so prompts sit queued until it closes; the queue drains on the next observe
  app.post('/api/agents/:id/pane-mode/exit', async (request, reply) => { controlled(request, true); const target = await discovery.target((request.params as { id: string }).id); if (target === undefined) return reply.code(404).send({ error: 'target unavailable' }); if (!await tmux.exitPaneMode(target.socket, target.agent.paneId)) return reply.code(503).send({ error: 'Unable to leave the pane mode.' }); await dashboardUpdates.refresh().catch(() => undefined); return reply.code(204).send(); });
  app.post('/api/agents/:id/review-tour/jobs', { bodyLimit: REVIEW_REQUEST_BODY_BYTES }, async (request, reply) => {
    const owner = controlled(request, true).id;
    const start = parseReviewTourStart(request.body);
    const requestIdHeader = request.headers['idempotency-key'];
    const requestId = requestIdHeader === undefined ? undefined : parseReviewRequestId(requestIdHeader);
    // reject malformed review requests
    if (start === undefined || requestIdHeader !== undefined && requestId === undefined) return reply.code(400).send({ status: 'error', error: { code: 'invalid_request', retryable: false } });
    try {
      const started = await reviewJobs.start(owner, (request.params as { id: string }).id, start.input, requestId, start.codeReview);
      // return empty selections without a job
      if (started.kind === 'empty') return reply.code(200).send({ status: 'empty', comparison: started.comparison });
      return reply.code(202).send({ status: 'pending', job: started.job, ...(started.codeReview === undefined ? {} : { codeReview: started.codeReview }) });
    } catch (error) { return reviewFailure(reply, error); }
  });
  // add a Code review to a current stored tour: the Comparison is captured again and must match
  app.post('/api/agents/:id/code-review/jobs', { bodyLimit: REVIEW_REQUEST_BODY_BYTES }, async (request, reply) => {
    const owner = controlled(request, true).id;
    const add = parseCodeReviewAdd(request.body);
    // reject malformed review requests
    if (add === undefined) return reply.code(400).send({ status: 'error', error: { code: 'invalid_request', retryable: false } });
    const agentId = (request.params as { id: string }).id;
    try {
      // refuse an unusable preset before capturing anything
      await codeReviews.validate(add.options);
      const prepared = await reviewTours.prepare(agentId, add.input);
      // refuse a review of a Comparison the tour no longer narrates
      if (prepared.comparison.fingerprint !== add.fingerprint) throw new ReviewTourError('stale_during_generation', true);
      return reply.code(202).send({ status: 'pending', job: await codeReviews.start(owner, agentId, prepared, add.options) });
    } catch (error) { return reviewFailure(reply, error); }
  });
  app.get('/api/code-review/jobs/:jobId', async (request, reply) => {
    const owner = controlled(request).id;
    const job = codeReviews.get(owner, (request.params as { jobId: string }).jobId);
    // hide missing or cross-owner jobs
    if (job === undefined) return reply.code(404).send({ status: 'error', error: { code: 'target_unavailable', retryable: false } });
    // map every job state
    // a pending job names an interactive run's Agent, so the client can open its pane
    if (job.state.kind === 'pending') return reply.code(202).send({ status: 'pending', job: startedReviewJob(job), ...(job.state.run === undefined ? {} : { run: job.state.run }) });
    if (job.state.kind === 'ready') return reply.code(200).send({ status: 'ready', review: job.state.review });
    if (job.state.kind === 'gone') return reply.code(410).send({ status: 'error', jobId: job.id, error: { code: job.state.code, retryable: true } });
    return reply.code(reviewStatus(job.state.code)).send({ status: 'error', jobId: job.id, error: { code: job.state.code, retryable: job.state.retryable } });
  });
  app.delete('/api/code-review/jobs/:jobId', async (request, reply) => {
    const owner = controlled(request, true).id;
    // cancel only owner-scoped jobs
    return codeReviews.cancel(owner, (request.params as { jobId: string }).jobId) ? reply.code(204).send() : reply.code(404).send({ status: 'error', error: { code: 'target_unavailable', retryable: false } });
  });
  // post a tour's feedback to the branch's pull request as the operator's draft review
  app.post('/api/agents/:id/review-tour/pr-review', { bodyLimit: PR_REVIEW_REQUEST_BODY_BYTES }, async (request, reply) => {
    controlled(request, true);
    const input = parsePullRequestReviewInput(request.body);
    // reject malformed post requests, a Working tour included
    if (input === undefined) return reply.code(400).send({ status: 'error', error: { code: 'invalid_request', retryable: false } });
    try {
      return reply.code(200).send(await pullRequestReviews.post((request.params as { id: string }).id, input));
    } catch (error) {
      // a worktree or GitHub refusal carries its message and the details the client shows
      if (error instanceof PullRequestReviewError) return reply.code(error.httpStatus).send({ status: 'error', error: { code: error.code, retryable: error.retryable, message: error.message, ...error.details } });
      // a Comparison capture failure keeps the tour's own codes
      if (error instanceof ReviewTourError) return reviewFailure(reply, error);
      return reply.code(500).send({ status: 'error', error: { code: 'post_failed', retryable: true } });
    }
  });
  app.get('/api/agents/:id/review-tour/fingerprint', async (request, reply) => {
    controlled(request);
    const input = reviewQuery(request.query);
    // reject malformed fingerprint queries
    if (input === undefined) return reply.code(400).send({ status: 'error', error: { code: 'invalid_request', retryable: false } });
    try {
      const current = await reviewTours.fingerprint((request.params as { id: string }).id, input);
      return reply.code(200).send({ status: current.empty ? 'empty' : 'comparison', comparison: current.comparison });
    } catch (error) { return reviewFailure(reply, error); }
  });
  app.get('/api/review-tour/jobs/:jobId', async (request, reply) => {
    const owner = controlled(request).id;
    const job = reviewJobs.get(owner, (request.params as { jobId: string }).jobId);
    // hide missing or cross-owner jobs
    if (job === undefined) return reply.code(404).send({ status: 'error', error: { code: 'target_unavailable', retryable: false } });
    // map every frozen job state
    // a pending job names an interactive run's Agent, so the client can open its pane
    if (job.state.kind === 'pending') return reply.code(202).send({ status: 'pending', job: startedReviewJob(job), ...(job.state.run === undefined ? {} : { run: job.state.run }) });
    if (job.state.kind === 'ready') return reply.code(200).send({ status: 'ready', tour: job.state.tour });
    if (job.state.kind === 'empty') return reply.code(200).send({ status: 'empty', comparison: job.state.comparison });
    if (job.state.kind === 'gone') return reply.code(410).send({ status: 'error', jobId: job.id, error: { code: job.state.code, retryable: true } });
    return reply.code(reviewStatus(job.state.code)).send({ status: 'error', jobId: job.id, error: { code: job.state.code, retryable: job.state.retryable } });
  });
  app.delete('/api/review-tour/jobs/:jobId', async (request, reply) => {
    const owner = controlled(request, true).id;
    // cancel only owner-scoped jobs
    return reviewJobs.cancel(owner, (request.params as { jobId: string }).jobId) ? reply.code(204).send() : reply.code(404).send({ status: 'error', error: { code: 'target_unavailable', retryable: false } });
  });
  app.get('/api/worktrees/:id/review-tour', async (request, reply) => {
    const owner = controlled(request).id;
    const id = (request.params as { id: string }).id;
    // require a configured worktree
    if (configuredWorktree(id) === undefined) return await nonWorktreeReply(id, reply, { missing: { status: 'error', error: { code: 'target_unavailable', retryable: false } }, refused: { status: 'error', error: { code: 'target_unavailable', retryable: false } } });
    const review = await reviewStore.current(id, await reviewBranch(id));
    // hide missing and branch-invalidated reviews
    if (review === undefined) return reply.code(404).send({ status: 'error', error: { code: 'target_unavailable', retryable: false } });
    // join the tour's completed Code review, and a pending one the dialog can resume polling
    const codeReview = await reviewStore.codeReview(id, review.branch, review.tour.fingerprint);
    const codeReviewJob = codeReviews.pending(owner, id, review.tour.fingerprint);
    return reply.code(200).send({ status: 'ready', review: { ...review, ...(codeReview === undefined ? {} : { codeReview }), ...(codeReviewJob === undefined ? {} : { codeReviewJob }) } });
  });
  // ask about the Worktree's stored tour, the reviewer about a Finding or the guide about some lines: a job polled to its answer
  app.post('/api/worktrees/:id/review-tour/asks', { bodyLimit: ASK_REQUEST_BODY_BYTES }, async (request, reply) => {
    const owner = controlled(request, true).id;
    const id = (request.params as { id: string }).id;
    const worktree = configuredWorktree(id);
    if (worktree === undefined) return await nonWorktreeReply(id, reply, { missing: { status: 'error', error: { code: 'target_unavailable', retryable: false } }, refused: { status: 'error', error: { code: 'target_unavailable', retryable: false } } });
    const input = parseAskRequest(request.body);
    if (input === undefined) return reply.code(400).send({ status: 'error', error: { code: 'invalid_request', retryable: false } });
    const branch = await reviewBranch(id);
    if (branch === undefined) return reply.code(404).send({ status: 'error', error: { code: 'target_unavailable', retryable: false } });
    try {
      const started = await asks.ask(owner, { worktreeId: id, workspace: worktree.identity, branch }, input);
      return reply.code(202).send({ status: 'pending', job: started.job, threadId: started.threadId });
    } catch (error) { return reviewFailure(reply, error); }
  });
  // the stored tour's Ask threads, and the owner's questions still being answered
  app.get('/api/worktrees/:id/review-tour/asks', async (request, reply) => {
    const owner = controlled(request).id;
    const id = (request.params as { id: string }).id;
    if (configuredWorktree(id) === undefined) return await nonWorktreeReply(id, reply, { missing: { status: 'error', error: { code: 'target_unavailable', retryable: false } }, refused: { status: 'error', error: { code: 'target_unavailable', retryable: false } } });
    const stored = await reviewStore.current(id, await reviewBranch(id));
    const threads = stored === undefined ? [] : await reviewStore.askThreads(id, stored.branch, stored.tour.fingerprint);
    return reply.code(200).send({ status: 'ready', threads, pending: stored === undefined ? [] : asks.pending(owner, id) });
  });
  app.get('/api/review-tour/asks/jobs/:jobId', async (request, reply) => {
    const owner = controlled(request).id;
    const job = asks.get(owner, (request.params as { jobId: string }).jobId);
    // hide missing or cross-owner jobs
    if (job === undefined) return reply.code(404).send({ status: 'error', error: { code: 'target_unavailable', retryable: false } });
    // a pending turn names an interactive run's Agent, so the thread can open its pane
    if (job.state.kind === 'pending') return reply.code(202).send({ status: 'pending', job: startedReviewJob(job), ...(job.state.run === undefined ? {} : { run: job.state.run }) });
    if (job.state.kind === 'ready') return reply.code(200).send({ status: 'ready' });
    if (job.state.kind === 'gone') return reply.code(410).send({ status: 'error', jobId: job.id, error: { code: job.state.code, retryable: true } });
    return reply.code(reviewStatus(job.state.code)).send({ status: 'error', jobId: job.id, error: { code: job.state.code, retryable: job.state.retryable } });
  });
  // The tour guide's conversation while the Worktree's stored tour covers a file of a Code panel scope:
  // the same scope, a file among the tour's Changes, and a Comparison that still has the tour's fingerprint
  const coveringGuide = async (worktreeId: string, branch: string, scope: ComparisonScope, file: string) => {
    const tour = (await reviewStore.current(worktreeId, branch))?.tour;
    const sameScope = typeof scope === 'object' ? tour?.scope === 'commit' && tour.commit === scope.commit : tour?.scope === scope;
    if (tour?.guide === undefined || !sameScope || !tour.changes.some(change => change.file === file)) return undefined;
    const agent = (await discovery.dashboard()).agents.find(candidate => candidate.worktreeId === worktreeId);
    const current = agent === undefined ? undefined : await reviewTours.current(agent.id, { scope: tour.scope, ...(tour.commit === undefined ? {} : { commit: tour.commit }), includeTests: tour.includeTests, includeDocs: tour.includeDocs }).catch(() => undefined);
    return current?.fingerprint === tour.fingerprint ? tour.guide : undefined;
  };
  // ask about lines of a Code panel's Comparison (the query's `kind`, and `commit`): a job polled to its answer
  app.post('/api/worktrees/:id/comparison/asks', { bodyLimit: ASK_REQUEST_BODY_BYTES }, async (request, reply) => {
    const owner = controlled(request, true).id;
    const id = (request.params as { id: string }).id;
    const worktree = configuredWorktree(id);
    if (worktree === undefined) return await nonWorktreeReply(id, reply, { missing: { status: 'error', error: { code: 'target_unavailable', retryable: false } }, refused: { status: 'error', error: { code: 'target_unavailable', retryable: false } } });
    const scope = comparisonScope(request, request.query as Record<string, unknown>);
    const input = parseChangeAskRequest(request.body);
    if (scope === undefined || input === undefined) return reply.code(400).send({ status: 'error', error: { code: 'invalid_request', retryable: false } });
    const branch = await reviewBranch(id);
    if (branch === undefined) return reply.code(404).send({ status: 'error', error: { code: 'target_unavailable', retryable: false } });
    try {
      const started = await changeAsks.ask(owner, { worktreeId: id, workspace: worktree.identity, branch, scope, branchNow: async () => await reviewBranch(id), patch: async () => { const result = await comparison.patch(worktree, scope); return result.ok ? result.patch : undefined; }, guide: async file => await coveringGuide(id, branch, scope, file) }, input);
      return reply.code(202).send({ status: 'pending', job: started.job, threadId: started.threadId, target: started.target });
    } catch (error) { return reviewFailure(reply, error); }
  });
  // a Code panel Comparison's Ask threads, and the owner's questions about it still being answered
  app.get('/api/worktrees/:id/comparison/asks', async (request, reply) => {
    const owner = controlled(request).id;
    const id = (request.params as { id: string }).id;
    if (configuredWorktree(id) === undefined) return await nonWorktreeReply(id, reply, { missing: { status: 'error', error: { code: 'target_unavailable', retryable: false } }, refused: { status: 'error', error: { code: 'target_unavailable', retryable: false } } });
    const scope = comparisonScope(request, request.query as Record<string, unknown>);
    if (scope === undefined) return reply.code(400).send({ status: 'error', error: { code: 'invalid_request', retryable: false } });
    const branch = await reviewBranch(id);
    const threads = branch === undefined ? [] : await changeAsks.threads({ worktreeId: id, branch, scope });
    return reply.code(200).send({ status: 'ready', threads, pending: changeAsks.pending(owner, id, scope) });
  });
  app.delete('/api/worktrees/:id/review-tour', async (request, reply) => {
    controlled(request, true);
    const id = (request.params as { id: string }).id;
    // require a configured worktree
    if (configuredWorktree(id) === undefined) return await nonWorktreeReply(id, reply, { missing: { status: 'error', error: { code: 'target_unavailable', retryable: false } }, refused: { status: 'error', error: { code: 'target_unavailable', retryable: false } } });
    await reviewStore.dismiss(id);
    // the dismissed tour's Code review and questions go with it
    codeReviews.supersedeWorktree(id);
    void asks.supersedeWorktree(id, 'tour');
    await dashboardUpdates.refresh().catch(() => undefined);
    return reply.code(204).send();
  });
  app.delete('/api/agents/:id', async (request, reply) => { controlled(request, true); const id = (request.params as { id: string }).id; const target = await discovery.target(id); if (!target || discovery.worktreesNow().some(worktree => worktreeMatchesWorkspace(worktree, target.agent.home)) || !await prompts.close(id)) return reply.code(404).send({ error: 'target unavailable' }); return reply.code(204).send(); });
  // permanently close one idle configured agent
  app.post('/api/agents/:id/deactivate', async (request, reply) => {
    controlled(request, true);
    const id = (request.params as { id: string }).id;
    const target = await discovery.target(id);
    const worktree = target === undefined ? undefined : configuredWorktreeForWorkspace(discovery.worktreesNow(), target.agent.home);
    // preserve active configured agents
    if (!target || worktree === undefined || agentAttentionState(target.agent) === 'working') return reply.code(409).send({ error: 'only idle configured agents can be turned off' });
    // require a live target
    if (!await prompts.close(id)) return reply.code(404).send({ error: 'target unavailable' });
    return reply.code(204).send();
  });
  // deliver either a numbered choice or free text to the active question
  app.post('/api/agents/:id/question', async (request, reply) => {
    controlled(request, true);
    const data = body(request);
    const answer = typeof data.text === 'string' && data.index === undefined ? data.text
      : Number.isInteger(data.index) && data.text === undefined ? data.index as number : undefined;
    // reject ambiguous payloads and stale or unsupported question answers
    if (typeof data.questionId !== 'string' || answer === undefined
      || !await prompts.answerQuestion((request.params as { id: string }).id, data.questionId, answer)) return reply.code(404).send({ error: 'question unavailable' });
    return reply.code(204).send();
  });
  // delay between launch checks
  const launchPollDelay = deps.launchPollDelay ?? defaultLaunchPollDelay;
  // read-back after a console rename: poll the agent's own store every 200 ms for ~1.5 s until
  // it reports the submitted name (the probe saw a rename apply within ~200 ms, idle or mid-turn)
  const conversationNamePollIntervalMs = 200;
  const conversationNamePollAttempts = 8;
  const conversationNamePollDelay = deps.conversationNamePollDelay ?? (async () => await new Promise(resolve => setTimeout(resolve, conversationNamePollIntervalMs)));
  // agents with a console rename in flight, so a second concurrent rename is refused
  const renamesInFlight = new Set<string>();
  // Name a fresh agent's Conversation from the server (no HTTP request), mirroring the delivery,
  // read-back and record of the console rename route below: paste the Adapter's rename text under the
  // lifecycle mutation lock, poll the agent's own store until it reports the name, then record it as
  // console-named so the closed managed Run stays discoverable in the Named list. Best-effort — a kind
  // that cannot rename or a busy pane is `skipped` and the Run proceeds unnamed. A freshly started
  // agent's paste can land while its Enter does not, so the keys are pressed again while the read-back
  // has not confirmed; a rename still unconfirmed is `stuck`, its text possibly left in the composer.
  // The route keeps its own HTTP guards (question check, returned row).
  const conversationNamePresses = 3;
  const nameAgentConversation = async (agentId: string, name: string): Promise<'named' | 'skipped' | 'stuck'> => {
    const clean = name.trim().replace(/\s+/gu, ' ').slice(0, 120);
    if (clean.length === 0 || renamesInFlight.has(agentId)) return 'skipped';
    const persistence = await agentPersistence(agentId);
    if (persistence === undefined) return 'skipped';
    const conversations = adapterFor(persistence.agent.kind)?.conversations;
    if (conversations?.rename === undefined || conversations.readName === undefined) return 'skipped';
    renamesInFlight.add(agentId);
    try {
      const conversationId = await discovery.conversationId(agentId);
      const target = await discovery.target(agentId);
      if (conversationId === undefined || target === undefined) return 'skipped';
      const rename = conversations.rename(clean);
      const buffer = `rac-${randomBytes(18).toString('base64url')}`;
      const cwd = discovery.paneDirectory(agentId);
      for (let press = 0; press < conversationNamePresses; press += 1) {
        const releaseMutation = prompts.beginAgentMutation(agentId);
        if (releaseMutation === undefined) return press === 0 ? 'skipped' : 'stuck';
        try {
          if (press === 0 && !await tmux.pastePrompt(target.socket, target.agent.paneId, buffer, rename.text)) return 'skipped';
          if (!await tmux.sendKeys(target.socket, target.agent.paneId, rename.keys)) return 'stuck';
        } finally { releaseMutation(); }
        for (let attempt = 0; attempt < conversationNamePollAttempts; attempt += 1) {
          await conversationNamePollDelay();
          if (await conversations.readName(conversationId, cwd).catch(() => undefined) === clean) {
            await consoleNamed.record(persistence.saveKey, { kind: persistence.agent.kind, id: conversationId }).catch(() => undefined);
            return 'named';
          }
        }
      }
      return 'stuck';
    } finally {
      renamesInFlight.delete(agentId);
    }
  };
  // Submit a server-sent prompt to a freshly launched agent and confirm the agent started it
  // (reported itself busy). A paste can land while its Enter does not, so the submit keys are
  // pressed again a couple of times before the delivery counts as failed. A
  // prompt that completes without work, or a shell-mode one, reports nothing to confirm.
  const promptStartAttempts = 40;
  const promptStartPressEvery = 8;
  const submitConfirmed = async (agentId: string, text: string, attachments: PromptAttachment[] = []): Promise<boolean> => {
    if (!await prompts.submit(agentId, text, attachments)) return false;
    const first = await discovery.target(agentId);
    if (first === undefined) return false;
    const submission = adapterFor(first.agent.kind)?.submission;
    const shellMode = attachments.length === 0 && text.startsWith('!');
    if (submission === undefined || shellMode || (attachments.length === 0 && submission.completesWithoutWork?.(text) === true)) return true;
    const composed = submission.prepare(text, 'prompt');
    for (let attempt = 1; attempt <= promptStartAttempts; attempt += 1) {
      await launchPollDelay();
      const target = await discovery.target(agentId, true);
      if (target === undefined) return false;
      if (agentAttentionState(target.agent) !== 'finished') return true;
      if (attempt % promptStartPressEvery !== 0 || attempt === promptStartAttempts) continue;
      const releaseMutation = prompts.beginAgentMutation(agentId);
      if (releaseMutation === undefined) continue;
      try { await tmux.sendKeys(target.socket, target.agent.paneId, composed.idleKeys ?? composed.keys).catch(() => false); }
      finally { releaseMutation(); }
    }
    return false;
  };
  // wait for slow agent startup, shared with the Run primitive (launch/wait.ts)
  const waitForAgent = createAgentWaiter(discovery, launchPollDelay);
  // the pane snapshot an Adapter's `newConversation` rules read, from one discovered agent
  // (Scheduled prompts) — the single builder the readiness poll and the reset settle loop share
  const runSnapshot = (agent: Agent): PaneSnapshot => ({ title: agent.title, attention: agentAttentionState(agent), ...(agent.conversationId === undefined ? {} : { conversationId: agent.conversationId }) });
  // wait for a freshly launched pane to become ready for its first prompt, reading the
  // launching Adapter's `ready` rule over the pane's snapshot and capture (Scheduled
  // prompts). A kind without a new-conversation capability takes its first prompt at once.
  const waitForReadiness = async (agent: Agent, attempts = launchPollAttempts): Promise<ReadinessOutcome> => {
    const ready = adapterFor(agent.kind)?.newConversation?.ready;
    // no readiness rule: the fresh launch may take its first prompt immediately
    if (ready === undefined) return { state: 'ready' };
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      // force a fresh read each poll so the reported id/title/attention (and a vanished pane)
      // reflect this instant, not the ~2s background snapshot — mirrors the prompt service
      const target = await discovery.target(agent.id, true);
      // a pane that vanished before it settled is a launch that did not survive
      if (target === undefined) return { state: 'blocked', reason: 'the agent closed before it was ready' };
      const capture = await tmux.capture(target.socket, target.agent.paneId).catch(() => undefined) ?? '';
      const readiness = ready(runSnapshot(target.agent), capture);
      // ready to paste, or blocked on something only the operator can clear
      if (readiness.state === 'ready') return { state: 'ready' };
      if (readiness.state === 'blocked') return { state: 'blocked', reason: readiness.reason };
      // pause before retrying
      if (attempt + 1 < attempts) await launchPollDelay();
    }
    return { state: 'timed-out' };
  };
  // ── Interactive Review runs (ADR 0010) ──────────────────────────────────────────
  // A Review run on a kind configured `interactive` runs as a fresh, visible Agent in the Worktree's
  // Workspace. Its kind must be configured and executable; the host bridge is refused, because the
  // instructions of a run too long to paste are handed over in a file under the shared /tmp, which
  // the host's tmux cannot see from the container. Declared as a function so the dispatcher built
  // above can take it; its steps run only once a run starts.
  function interactiveReviewRunner(): InteractiveReviewRunner {
    return new InteractiveReviewRunner({
      capability: async kind => {
        const configured = config.adapters[kind];
        if (configured === undefined) return { available: false, reason: 'configuration_invalid' };
        if (!configured.launchable) return { available: false, reason: 'generator_unavailable' };
        return process.env.RAC_HOST_TMUX_DIR === undefined ? { available: true } : { available: false, reason: 'interactive_unavailable' };
      },
      agentIds: async () => new Set((await discovery.dashboard()).agents.map(agent => agent.id)),
      launch: async (worktreeId, kind, review) => {
        const { mcp } = reviewRunsFor(kind).interactive;
        const adapter = config.adapters[kind];
        const worktree = configuredWorktree(worktreeId);
        if (mcp === undefined || adapter === undefined || worktree === undefined) return await launch.launchReviewRun(worktreeId, kind, review);
        // a kind that must disable its MCP servers by name disables every one it would load there; one it cannot list or address refuses the launch
        const disabled = await mcpDisableArgs(mcp, adapter.program, worktree.identity, adapter.env);
        if (disabled === undefined) { console.warn(`[review] ${worktree.identity}: could not disable ${kind} MCP servers; the run is not launched`); return false; }
        return await launch.launchReviewRun(worktreeId, kind, { ...review, extraArgs: [...review.extraArgs, ...disabled] });
      },
      waitForAgent: (before, runId) => waitForAgent(before, reviewRunAgent(runId)),
      waitForReadiness: agent => waitForReadiness(agent),
      name: async (agentId, name) => await nameAgentConversation(agentId, name) !== 'stuck',
      beginTurn: (agent, maxBytes) => beginReplyTurn(discovery, agent, maxBytes),
      latestReply: (agent, maxBytes) => latestReply(discovery, agent, maxBytes),
      // only a Code review leaves a recovery; an orphaned tour is handed back
      recover: async (recovery, agentId) => await codeReviews.recover(recovery, agentId),
      submit: (agentId, text) => submitConfirmed(agentId, text),
      // the reported id, else the Adapter's own discovery (Codex reports none)
      conversationId: agentId => discovery.conversationId(agentId),
      // the cached discovery snapshot (rescanned once over 2 s old, which the dashboard poll keeps it
      // under); an Agent missing from it is confirmed gone by a forced scan inside `target`
      attention: async agentId => { await discovery.refresh(); const target = await discovery.target(agentId); return target === undefined ? undefined : agentAttentionState(target.agent); },
      close: agentId => prompts.close(agentId),
      release: async agentId => { const target = await discovery.target(agentId); return target !== undefined && await tmux.unmarkReviewRun(target.socket, target.agent.paneId); },
      delay: async () => await new Promise(resolve => setTimeout(resolve, 1_000))
    }, { promptDirectory: join(`/tmp/remote-agent-console-${process.getuid?.() ?? 0}`, 'review-runs') });
  }
  // ── The Run primitive (Scheduled prompts) ─────────────────────────────────────────
  // One server operation performs every Run — Run now on a Schedule, Launch and run on an idle
  // worktree tab, and (later) the scheduler tick. It reuses the Schedule's own idle pane by
  // resetting the conversation through the Adapter's new-conversation command, and launches a
  // fresh agent otherwise; the Note's text is then submitted through the normal prompt path. The
  // caller owns recording `lastRun` and mapping the outcome to HTTP — this returns what happened.
  type RunFailureReason = 'launch-refused' | 'no-agent' | 'not-ready-blocked' | 'not-ready-timeout' | 'delivery-failed' | 'reset-lost';
  type RunOutcome =
    | { status: 'launched'; agentId: string }
    | { status: 'skipped'; detail: string; agentId?: string }
    | { status: 'failed'; detail: string; reason: RunFailureReason; agentId?: string };
  // A reset settles within ~2 s (Claude) / ~1.5 s (Codex); poll a little past that so the
  // Adapter's own budget, not this cap, ends the wait. The injectable poll delay paces it in tests.
  const resetSettleAttempts = 20;
  // how to launch, match and reuse each Schedule target, mirroring the launcher rows; undefined
  // when the target no longer resolves (a removed Worktree, an unavailable directory Project).
  // A directory Project or Scratch matches its Agents by Place, wherever in the Place they run.
  type RunPlan = { matches: (agent: Agent) => boolean; launch: () => Promise<boolean>; waitForNewAgent: (before: Set<string>) => Promise<Agent | undefined> };
  const resolveRunPlan = async (target: ScheduleTarget, kind: AgentKind | undefined): Promise<RunPlan | undefined> => {
    if ('worktreeId' in target) {
      const worktree = configuredWorktree(target.worktreeId);
      if (worktree === undefined) return undefined;
      return {
        matches: agent => !isReviewRun(agent) && worktreeMatchesWorkspace(worktree, agent.home),
        launch: () => launch.launch(target.worktreeId, kind),
        waitForNewAgent: before => waitForAgent(before, inWorktree(target.worktreeId)),
      };
    }
    // only an available directory Project launches in place (a repository Project runs through its Worktrees)
    const inPlace = 'projectId' in target
      ? { place: await launch.directoryPlace(target.projectId), launch: () => launch.launchProjectDirectory(target.projectId, kind) }
      : { place: await launch.scratchPlace(), launch: () => launch.launchHome(kind) };
    const place = inPlace.place;
    if (place === undefined) return undefined;
    return { matches: atPlace(place.id), launch: inPlace.launch, waitForNewAgent: before => waitForAgent(before, atPlace(place.id)) };
  };
  // reuse the Schedule's own idle pane: reset the conversation, wait for the Adapter's settle
  // rule, then submit the Note's text with the reset instant so Codex completion anchors on the
  // fresh thread. Attention working/question and a non-empty composer are skipped, not forced.
  const runReuse = async (prior: { agent: Agent; socket: SocketRef }, capability: NonNullable<Adapter['newConversation']>, text: string, attachments: PromptAttachment[]): Promise<RunOutcome> => {
    const agentId = prior.agent.id;
    const attention = agentAttentionState(prior.agent);
    if (attention === 'working') return { status: 'skipped', detail: 'previous run still working', agentId };
    if (attention === 'question') return { status: 'skipped', detail: 'previous run is asking a question', agentId };
    // a draft or an open dialog in the composer would merge the reset into a prompt: skip instead.
    // A pane we cannot read is skipped too rather than pasted into blind.
    const capture = await tmux.capture(prior.socket, prior.agent.paneId).catch(() => undefined);
    if (capture === undefined) return { status: 'skipped', detail: 'could not read the pane', agentId };
    if (!capability.composerEmpty(capture)) return { status: 'skipped', detail: 'composer has unsent text', agentId };
    const before = runSnapshot(prior.agent);
    const resetAt = Date.now();
    // paste the reset command through the normal submission path
    if (!await prompts.submitReset(agentId, capability.command)) return { status: 'failed', detail: 'reset did not settle', reason: 'reset-lost', agentId };
    const observed: PaneSnapshot[] = [];
    const start = Date.now();
    let settling: ResetSettling = 'pending';
    for (let attempt = 0; attempt < resetSettleAttempts; attempt += 1) {
      await launchPollDelay();
      const current = await discovery.target(agentId, true);
      // a pane that vanished under the reset is a lost reset
      if (current === undefined) { settling = 'lost'; break; }
      observed.push(runSnapshot(current.agent));
      settling = capability.settled(before, observed, Date.now() - start);
      if (settling !== 'pending') break;
    }
    // a lost or never-settled reset leaves the pane alone (it is the Schedule's own)
    if (settling !== 'settled') return { status: 'failed', detail: 'reset did not settle', reason: 'reset-lost', agentId };
    // submit the note through the prompt service exactly as a typed prompt, carrying the reset instant
    if (!await prompts.submit(agentId, text, attachments, resetAt)) return { status: 'failed', detail: 'the note could not be delivered', reason: 'delivery-failed', agentId };
    return { status: 'launched', agentId };
  };
  // launch a fresh agent for the target through the managed-run primitive, then submit the note; a
  // blocked or slow readiness closes the pane this Run created rather than leaving it behind (the Run
  // then has no pane to remember or deep-link to, so lastRun records no agentId and the notification
  // falls back to the Worktree or root url)
  const notReadyDetail = `agent did not become ready in ${launchReadyTimeoutSeconds} s`;
  const freshFailureDetail: Record<FreshLaunchFailure, string> = { 'launch-refused': 'launch refused', 'no-agent': notReadyDetail, 'not-ready-blocked': notReadyDetail, 'not-ready-timeout': notReadyDetail, 'delivery-failed': 'the note could not be delivered' };
  const runFresh = async (plan: RunPlan, text: string, attachments: PromptAttachment[], name?: string): Promise<RunOutcome> => {
    const outcome = await launchFresh({
      agentIds: async () => new Set((await discovery.dashboard()).agents.map(agent => agent.id)),
      launch: plan.launch,
      waitForNewAgent: plan.waitForNewAgent,
      waitForReadiness,
      close: agentId => prompts.close(agentId),
      // an unattended (managed) Run names its fresh conversation before delivering, so the pane the
      // reconciler later closes is still findable by name in the Named list
      ...(name === undefined ? {} : { prepare: async (agent: Agent) => await nameAgentConversation(agent.id, name) !== 'stuck' }),
      deliver: agent => submitConfirmed(agent.id, text, attachments)
    });
    if (outcome.status === 'launched') return outcome;
    return { status: 'failed', reason: outcome.reason, detail: outcome.detail ?? freshFailureDetail[outcome.reason], ...(outcome.agentId === undefined ? {} : { agentId: outcome.agentId }) };
  };
  const runOnce = async (input: { text: string; attachments: PromptAttachment[]; kind: AgentKind | undefined; target: ScheduleTarget; previousAgentId?: string; unattended?: boolean; conversationName?: string }): Promise<RunOutcome> => {
    // preconditions — a failure records `skipped` with the reason and pastes nothing
    if (!validPrompt(input.text, input.attachments)) return { status: 'skipped', detail: 'note is empty' };
    const plan = await resolveRunPlan(input.target, input.kind);
    if (plan === undefined) return { status: 'skipped', detail: 'target is gone' };
    // whether the kind can launch is checked at Run time, since configuration can change
    if (input.kind !== undefined && !launch.isLaunchableKind(input.kind)) return { status: 'skipped', detail: `${input.kind} is not available` };
    // an unattended (scheduler-fired) Run always launches fresh and names its conversation; its pane is
    // closed on completion by the reconciler, so it never reuses a pane and the composer is never read.
    // Only an attended Run now reuses the Schedule's own pane when the remembered agent is still a live
    // agent of the same kind whose workspace is the target; a kind without a reset capability launches fresh.
    if (!input.unattended) {
      const capability = input.kind === undefined ? undefined : adapterFor(input.kind)?.newConversation;
      if (input.previousAgentId !== undefined && capability !== undefined) {
        const prior = await discovery.target(input.previousAgentId, true);
        // a live previous agent of another kind or workspace was retargeted: leave it alone, launch fresh
        if (prior !== undefined && prior.agent.kind === input.kind && plan.matches(prior.agent)) return await runReuse(prior, capability, input.text, input.attachments);
      }
    }
    return await runFresh(plan, input.text, input.attachments, input.unattended ? input.conversationName : undefined);
  };
  const performRun = async (input: { text: string; attachments: PromptAttachment[]; kind: AgentKind | undefined; target: ScheduleTarget; previousAgentId?: string; unattended?: boolean; conversationName?: string }): Promise<RunOutcome> => {
    const outcome = await runOnce(input);
    // every outcome refreshes the dashboard, even a precondition skip that changed nothing
    await dashboardUpdates.refresh().catch(() => undefined);
    return outcome;
  };
  // map a non-launched Run outcome to the launch routes' HTTP contract, so Launch and run keeps
  // its 409 / 504 / 502 responses now that it runs through the shared primitive
  const runFailureReply = (outcome: Extract<RunOutcome, { status: 'failed' | 'skipped' }>): { code: number; error: string } => {
    if (outcome.status === 'skipped') return { code: 409, error: outcome.detail };
    switch (outcome.reason) {
      case 'launch-refused': return { code: 409, error: 'Could not start the worktree agent.' };
      case 'no-agent': return { code: 504, error: `The worktree session started, but the agent did not become ready within ${launchReadyTimeoutSeconds} seconds.` };
      case 'not-ready-blocked': return { code: 409, error: `The agent started but is not ready: ${outcome.detail}.` };
      case 'not-ready-timeout': return { code: 504, error: `The agent started but did not become ready within ${launchReadyTimeoutSeconds} seconds.` };
      case 'delivery-failed': return { code: 502, error: 'The agent started but the note could not be delivered.' };
      // Launch and run never reuses a pane (no previous agent), so a lost reset cannot reach here;
      // the case is kept only to keep the switch exhaustive over RunFailureReason.
      case 'reset-lost': return { code: 409, error: 'The previous run could not be reset.' };
    }
  };
  // the name a managed (unattended) Run gives its fresh conversation, so the pane the reconciler later
  // closes stays findable in the Named list: a clock, the Note's title (or a snippet of its text) and
  // the host-local run time, capped to the 120-char rename limit
  const scheduledConversationName = (note: WorktreeNote, at: string): string => {
    const when = new Date(at);
    const pad = (value: number) => String(value).padStart(2, '0');
    const stamp = Number.isNaN(when.getTime()) ? at : `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${pad(when.getHours())}:${pad(when.getMinutes())}`;
    const label = (note.title ?? note.text ?? '').trim().replace(/\s+/gu, ' ') || 'Scheduled note';
    return `⏰ ${label} — ${stamp}`.slice(0, 120);
  };
  // terminal statuses that warrant an unattended notification (a skip, an outright failure, a run that
  // timed out, or one that ended asking a question); a launched/running/completed Run stays quiet
  const scheduleAttentionStatuses = new Set<ScheduleRunStatus>(['skipped', 'failed', 'needs-input', 'timed-out']);
  const notifyScheduleRun = (schedule: Schedule, noteId: string, noteTitle: string | undefined, lastRun: ScheduleLastRun): void => {
    if (!scheduleAttentionStatuses.has(lastRun.status)) return;
    const target = resolveScheduleTarget(schedule.target);
    void push.notify(scheduleNotification({
      status: lastRun.status as 'skipped' | 'failed' | 'needs-input' | 'timed-out',
      targetLabel: target.label,
      noteId,
      ...(noteTitle === undefined ? {} : { noteTitle }),
      ...(lastRun.detail === undefined ? {} : { detail: lastRun.detail }),
      ...(lastRun.agentId === undefined ? {} : { agentId: lastRun.agentId }),
      ...(target.worktreeId === undefined ? {} : { worktreeId: target.worktreeId })
    })).catch(() => undefined);
  };
  // Run one Note's Schedule once at the due (or Run-now) instant `at`, and record the outcome on its
  // `lastRun`. One Run per Schedule at a time — the flight guard is shared by Run now, the scheduler
  // tick and the reconciler, so no two of them mutate the one Note at once. An `unattended` (scheduler)
  // Run is a managed lifecycle: it launches fresh, names its conversation, records `running`, and the
  // reconciler later closes its pane; an attended Run now records the immediate outcome and leaves its
  // pane open. An unexpected error still records a `failed` run, so "every run is recorded" holds even
  // for infrastructure failures. Returns the updated Note, or why nothing ran (Scheduled prompts).
  const recordedScheduleRun = async (saveKey: string, noteId: string, at: string, unattended: boolean): Promise<{ note: WorktreeNote } | 'in-flight' | 'gone'> => {
    const resolved = await notes.resolve(saveKey, noteId);
    // gone: an unknown Note or a Note without a Schedule to run
    if (resolved === undefined || resolved.note.schedule === undefined) return 'gone';
    const canonicalSaveKey = resolved.key;
    const flightKey = `${canonicalSaveKey}:${noteId}`;
    if (scheduleRunsInFlight.has(flightKey) || noteDeletionsInFlight.has(flightKey)) return 'in-flight';
    scheduleRunsInFlight.add(flightKey);
    try {
      const current = await notes.resolve(canonicalSaveKey, noteId);
      // re-read after claiming the note so deletion cannot leave a stale run
      if (current === undefined || current.note.schedule === undefined) return 'gone';
      const note = current.note;
      const schedule = current.note.schedule;
      let lastRun: ScheduleLastRun;
      try {
        const outcome = await performRun({
          text: note.text,
          attachments: note.attachments ?? [],
          kind: schedule.kind,
          target: schedule.target,
          unattended,
          ...(unattended ? { conversationName: scheduledConversationName(note, at) } : {}),
          ...(unattended || schedule.lastRun?.agentId === undefined ? {} : { previousAgentId: schedule.lastRun.agentId })
        });
        // a managed launch is only the *start* of a Run: record it `running` with the watch anchors and
        // let the reconciler close the pane and write the terminal outcome. An attended Run now records
        // the immediate `launched`/`skipped`/`failed` outcome and leaves its pane open.
        lastRun = unattended && outcome.status === 'launched'
          ? { at, status: 'running', startedAt: new Date().toISOString(), sawWorking: false, ...(outcome.agentId === undefined ? {} : { agentId: outcome.agentId }) }
          : { at, status: outcome.status, ...(outcome.status === 'launched' ? {} : { detail: outcome.detail }), ...(outcome.agentId === undefined ? {} : { agentId: outcome.agentId }) };
      } catch (error) {
        // an unexpected dependency failure is still an outcome the operator should see, not a lost run
        console.warn(`[schedule] run errored for ${flightKey}:`, error);
        lastRun = { at, status: 'failed', detail: 'run error' };
      }
      const updated = await notes.recordLastRun(canonicalSaveKey, noteId, lastRun);
      // the Schedule may have been removed mid-run; the outcome is then dropped, notification and all
      if (updated === undefined) return 'gone';
      publishSharedNoteRevision(updated);
      // a launched/running/completed Run stays quiet; the reconciler notifies the terminal outcome
      notifyScheduleRun(schedule, noteId, note.title, lastRun);
      return { note: updated };
    } finally {
      scheduleRunsInFlight.delete(flightKey);
    }
  };
  // a managed Run still working after this is closed and recorded `timed-out`, so a runaway task never
  // holds its Note's one-Run slot forever
  const scheduleRunMaxMs = 30 * 60 * 1_000;
  // Advance one in-flight managed Run: read its pane's attention and either flip `sawWorking`, or record
  // a terminal outcome and close the pane. Shares the per-Note flight guard with dispatch so a manual Run
  // now and this reconcile can never mutate the one Note at once (Scheduled prompts).
  const reconcileScheduleRun = async (saveKey: string, noteId: string): Promise<void> => {
    const resolved = await notes.resolve(saveKey, noteId);
    // stop when the note is no longer visible from the requested scope
    if (resolved === undefined) return;
    const canonicalSaveKey = resolved.key;
    const flightKey = `${canonicalSaveKey}:${noteId}`;
    if (scheduleRunsInFlight.has(flightKey) || noteDeletionsInFlight.has(flightKey)) return;
    scheduleRunsInFlight.add(flightKey);
    try {
      const current = await notes.resolve(canonicalSaveKey, noteId);
      // re-read after claiming the note so deletion cannot leave stale state
      if (current === undefined) return;
      const note = current.note;
      const schedule = note?.schedule;
      const lastRun = schedule?.lastRun;
      if (note === undefined || schedule === undefined || lastRun?.status !== 'running') return;
      const agentId = lastRun.agentId;
      const target = agentId === undefined ? undefined : await discovery.target(agentId, true);
      const started = Date.parse(lastRun.startedAt ?? lastRun.at);
      const elapsed = Number.isNaN(started) ? 0 : Date.now() - started;
      let terminal: ScheduleLastRun | undefined;
      let progressed: ScheduleLastRun | undefined;
      let closeId: string | undefined;
      // a terminal outcome drops the agentId: the pane is (about to be) closed or already gone, so a
      // deep-link would be dead — the notification falls back to the Worktree and the renamed
      // conversation is how the closed Run is found. Only the still-`running` progress keeps its pane.
      if (agentId === undefined || target === undefined) {
        // the managed pane is gone — a manual stop, a crash, or a restart that outlived it
        terminal = { at: lastRun.at, status: 'failed', detail: 'the agent was closed before the run finished' };
      } else {
        const progress = managedRunProgress(agentAttentionState(target.agent), lastRun.sawWorking === true, elapsed);
        if (progress === 'working') {
          if (elapsed >= scheduleRunMaxMs) { terminal = { at: lastRun.at, status: 'timed-out', detail: `still working after ${Math.round(scheduleRunMaxMs / 60_000)} min` }; closeId = agentId; }
          else if (lastRun.sawWorking !== true) progressed = { ...lastRun, sawWorking: true };
        } else if (progress === 'question') {
          terminal = { at: lastRun.at, status: 'needs-input', detail: 'the run ended asking a question' }; closeId = agentId;
        } else if (progress === 'finished') {
          terminal = { at: lastRun.at, status: 'completed' }; closeId = agentId;
        }
        // else: starting — finished, never observed working, still within the start window → it may not have begun
      }
      if (closeId !== undefined) await prompts.close(closeId).catch(() => undefined);
      const record = terminal ?? progressed;
      if (record === undefined) return;
      const updated = await notes.recordLastRun(canonicalSaveKey, noteId, record);
      // stop when the schedule changed during reconciliation
      if (updated === undefined) return;
      publishSharedNoteRevision(updated);
      // progress changes need no terminal notification
      if (terminal === undefined) return;
      notifyScheduleRun(schedule, noteId, note.title, terminal);
    } finally {
      scheduleRunsInFlight.delete(flightKey);
    }
  };
  // fire enabled Schedules once a minute, unattended, through the very seam Run now uses; the reconcile
  // pass closes each managed Run's pane when it finishes. Constructed here so it closes over the real Run
  // primitive; decorated onto the app below so index.ts starts it and the HTTP-seam tests drive its
  // `tick(now)`. It is not started here — tests build the app without a live timer running.
  const scheduler = new Scheduler(
    () => notes.scheduled(),
    (key, noteId, at) => recordedScheduleRun(key, noteId, at, true),
    scheduleBootAt,
    undefined,
    (key, noteId) => reconcileScheduleRun(key, noteId)
  );
  // Run now on a Schedule: run it synchronously exactly as the scheduler will and return the decorated
  // Note; a second Run now while one is in flight is refused with a conflict.
  const runScheduleNow = async (saveKey: string, noteId: string, reply: FastifyReply): Promise<unknown> => {
    const result = await recordedScheduleRun(saveKey, noteId, new Date().toISOString(), false);
    if (result === 'gone') return reply.code(404).send({ error: 'schedule unavailable' });
    if (result === 'in-flight') return reply.code(409).send({ error: 'A run of this schedule is already in progress.' });
    return decorateNote(result.note);
  };
  // launch and pre-prompt one dedicated update advisor
  const launchUpdateAdvisor = async (targetSha: string): Promise<string | undefined> => {
    const preview = await serverAdmin.updatePreview();
    // require the exact current advisory range
    if (preview === undefined || preview.targetSha !== targetSha) return undefined;
    const advisor = serverAdmin.updateAdvisor(preview);
    // require a server-owned advisor request
    if (advisor === undefined) return undefined;
    const dashboard = await discovery.dashboard();
    const activeTarget = await serverAdmin.activeUpdateTarget();
    const protectedLabels = new Set([updateAdvisorLabel(targetSha), ...(activeTarget === undefined ? [] : [updateAdvisorLabel(activeTarget)])]);
    const protectedIds = new Set<string>();
    // retain only the newest pane for each protected target
    for (const label of protectedLabels) {
      const candidates = dashboard.agents.filter(candidate => candidate.displayLabel === label);
      const newest = candidates.sort((left, right) => Number(right.paneId.slice(1)) - Number(left.paneId.slice(1)))[0];
      // preserve one current advisor
      if (newest !== undefined) protectedIds.add(newest.id);
    }
    const prunedIds = new Set<string>();
    // close mapped advisors superseded by the current target
    for (const [candidateTarget, candidateId] of updateAdvisors) {
      // preserve the requested and actively updating targets
      if (candidateTarget === targetSha || candidateTarget === activeTarget) continue;
      const closed = await prompts.close(candidateId).catch(() => false);
      // forget only panes confirmed closed
      if (closed) {
        updateAdvisors.delete(candidateTarget);
        prunedIds.add(candidateId);
      }
    }
    // recover and prune superseded advisor panes after server restarts
    for (const candidate of dashboard.agents) {
      // retain ordinary agents and one pane for each protected target
      if (!isUpdateAdvisorLabel(candidate.displayLabel) || protectedIds.has(candidate.id) || prunedIds.has(candidate.id)) continue;
      const closed = await prompts.close(candidate.id).catch(() => false);
      // remove recovered mappings only after confirmed cleanup
      if (closed) {
        prunedIds.add(candidate.id);
        for (const [candidateTarget, candidateId] of updateAdvisors) if (candidateId === candidate.id) updateAdvisors.delete(candidateTarget);
      }
    }
    const currentLabel = updateAdvisorLabel(targetSha);
    const existingId = [...protectedIds].find(candidateId => dashboard.agents.some(candidate => candidate.id === candidateId && candidate.displayLabel === currentLabel));
    // reuse one surviving advisor for the reviewed target
    if (existingId !== undefined && await discovery.target(existingId) !== undefined) {
      updateAdvisors.set(targetSha, existingId);
      return existingId;
    }
    const before = new Set(dashboard.agents.map(agent => agent.id));
    // launch inside the fixed host checkout
    if (!await launch.launchUpdateAdvisor(advisor.repository, targetSha)) return undefined;
    const agent = await waitForAgent(before, candidate => candidate.displayLabel === updateAdvisorPendingLabel(targetSha));
    // stop after a failed discovery handoff
    if (agent === undefined) return undefined;
    // close an unprompted scratch pane
    if (!await prompts.submitUpdateAdvisor(agent.id, targetSha, advisor.prompt)) {
      await prompts.close(agent.id).catch(() => false);
      return undefined;
    }
    // trust recovered panes only after the initial prompt is scheduled
    if (!await prompts.markUpdateAdvisorReady(agent.id, targetSha)) {
      await prompts.close(agent.id).catch(() => false);
      return undefined;
    }
    updateAdvisors.set(targetSha, agent.id);
    return agent.id;
  };
  // start or reuse a fixed update advisor
  app.post('/api/server/update-advisor', async (request, reply) => {
    controlled(request, true);
    const targetSha = body(request).targetSha;
    // require one reviewed target
    if (!isFullGitSha(targetSha)) return reply.code(400).send({ error: 'Invalid update advisor target.' });
    const agentId = await withUpdateAdvisorLifecycle(targetSha, async () => await launchUpdateAdvisor(targetSha));
    return agentId === undefined ? reply.code(503).send({ error: 'Unable to start the update advisor.' }) : reply.code(201).send({ agentId, targetSha });
  });
  // stop the advisor when its owning update modal closes
  app.delete('/api/server/update-advisor', async (request, reply) => {
    controlled(request, true);
    const targetSha = body(request).targetSha;
    // require one reviewed target
    if (!isFullGitSha(targetSha)) return reply.code(400).send({ error: 'Invalid update advisor target.' });
    const result = await withUpdateAdvisorLifecycle(targetSha, async () => {
      // preserve advice throughout an active host update
      if (await serverAdmin.activeUpdateTarget() === targetSha) return 'active' as const;
      return await stopUpdateAdvisors(targetSha) ? 'stopped' as const : 'failed' as const;
    });
    if (result === 'active') return reply.code(409).send({ error: 'The update advisor is retained while its host update is active.' });
    return result === 'stopped' ? reply.code(204).send() : reply.code(503).send({ error: 'Unable to stop the update advisor.' });
  });
  type IdleRestartResult = { status: 'restarted'; worktreeId: string; agentId: string } | { status: 'skipped'|'failed'; worktreeId: string; reason: 'unavailable'|'not-idle'|'launch-failed'|'timed-out'; error: string };
  // restart one still-idle configured agent
  const restartIdleConfiguredAgent = async (id: string, expectedWorktreeId?: string, expectedMutationVersion?: number, expectedMutationGeneration?: number, threadId?: string, kind?: AgentKind): Promise<IdleRestartResult> => {
    const releaseRestart = await prompts.acquireRestartLock(id, expectedMutationVersion, expectedMutationGeneration);
    // reject overlapping prompt and lifecycle work
    if (releaseRestart === undefined) return { status: 'skipped', worktreeId: expectedWorktreeId ?? 'unknown', reason: 'not-idle', error: 'The worktree is no longer idle.' };
    try {
      const current = await discovery.dashboard(true);
      const observed = current.agents.find(agent => agent.id === id);
      const worktree = observed === undefined ? undefined : configuredWorktreeForWorkspace(discovery.worktreesNow(), observed.home);
      const worktreeId = worktree?.id ?? expectedWorktreeId ?? 'unknown';
      // require the original configured target
      if (observed === undefined || worktree === undefined || (expectedWorktreeId !== undefined && worktree.id !== expectedWorktreeId)) return { status: 'skipped', worktreeId, reason: 'unavailable', error: 'The worktree agent is no longer open.' };
      // reject working and question states
      if (agentAttentionState(observed) !== 'finished') return { status: 'skipped', worktreeId, reason: 'not-idle', error: 'Only idle configured agents can restart.' };
      // revalidate state before closing
      if (observed.worktreeId !== worktree.id) return { status: 'skipped', worktreeId, reason: 'not-idle', error: 'The worktree agent is no longer idle.' };
      const queued = await queuedPrompts.list(promptScope(observed.id)).then(prompts => prompts?.length).catch(() => undefined);
      // preserve queued or unreadable prompt work
      if (queued === undefined || queued > 0) return { status: 'skipped', worktreeId, reason: 'not-idle', error: 'The agent has queued prompts.' };
      // With other Agents at the Worktree, "continue the latest" could pick up a sibling's
      // Conversation: a restart resumes this Agent's own, and starts fresh when it cannot (another
      // kind, or no Conversation reported yet).
      const hasSiblings = worktreeAgents(current.agents, worktree.id).some(agent => agent.id !== id);
      const ownConversation = threadId === undefined && hasSiblings && (kind === undefined || kind === observed.kind) && observed.conversationId !== undefined && adapterFor(observed.kind)?.conversations?.validId(observed.conversationId) === true ? observed.conversationId : undefined;
      const resumeThread = threadId ?? ownConversation;
      const resumeKind = ownConversation === undefined ? kind : observed.kind;
      // validate exact resume before closing the current agent
      if (resumeThread !== undefined && !launch.canResumeConversation(worktree.id)) return { status: 'failed', worktreeId, reason: 'launch-failed', error: 'Exact chat resume is not configured for this worktree.' };
      const before = new Set(current.agents.map(agent => agent.id));
      // require the original agent to close
      if (!await prompts.close(id)) return { status: 'skipped', worktreeId, reason: 'unavailable', error: 'The worktree agent could not be closed.' };
      const resumed = resumeThread !== undefined ? await launch.resumeConversation(worktree.id, resumeThread, resumeKind)
        : hasSiblings ? await launch.launch(worktree.id, kind) : await launch.resume(worktree.id, kind);
      // require the resumed agent to start
      if (!resumed) {
        await dashboardUpdates.refresh().catch(() => undefined);
        return { status: 'failed', worktreeId, reason: 'launch-failed', error: 'The agent closed, but it could not be resumed.' };
      }
      const agent = await waitForAgent(before, inWorktree(worktree.id));
      // retain recovery controls after a timeout
      if (agent === undefined) {
        await dashboardUpdates.refresh().catch(() => undefined);
        return { status: 'failed', worktreeId, reason: 'timed-out', error: `The agent closed and resumed, but Codex did not become ready within ${launchReadyTimeoutSeconds} seconds.` };
      }
      await prompts.handOver(id, agent.id).catch(() => undefined);
      await dashboardUpdates.refresh().catch(() => undefined);
      return { status: 'restarted', worktreeId, agentId: agent.id };
    } finally {
      releaseRestart();
    }
  };
  // query all configured Codex accounts on menu open
  app.get('/api/codex/accounts', async (request, reply) => {
    controlled(request);
    try {
      const configured = await accounts.listAccounts();
      // fetch billing only for explicitly identified api-key slots
      const summaries = await Promise.all(configured.map(async account => {
        const summary = publicAccount(account);
        // preserve chatgpt summaries without a billing query
        if (account.authMode !== 'apikey') return summary;
        const spend = await accountSpend.read(account.id);
        // expose only public totals and never billing credentials or provider identifiers
        return { ...summary, spend: spend.status === 'available'
          ? { status: spend.status, todayUsd: spend.todayUsd, weekUsd: spend.weekUsd, asOf: spend.asOf }
          : { status: spend.status } };
      }));
      return { accounts: summaries };
    } catch {
      return reply.code(503).send({ error: 'Unable to load ChatGPT accounts.' });
    }
  });
  // read the signed-in Claude account and its usage on menu open
  app.get('/api/claude/accounts', async request => {
    controlled(request);
    return { accounts: [publicAccount(await claudeAccount())] };
  });
  // rename one configured codex account without selecting it
  app.patch('/api/codex/accounts/:id', async (request, reply) => {
    controlled(request, true);
    const id = (request.params as { id: string }).id;
    const label = normalizeAccountLabel(body(request).label);
    // require one safe slot and printable bounded label
    if (!safeAccountId.test(id) || label === undefined) return reply.code(400).send({ error: 'Invalid account rename.' });
    try {
      return { account: publicAccount(await accounts.renameAccount(id, label)) };
    } catch (error) {
      // distinguish missing slots from storage failures
      if (error instanceof Error && error.message === 'Account not found') return reply.code(404).send({ error: 'Account not found.' });
      return reply.code(503).send({ error: 'Unable to rename account.' });
    }
  });
  // switch the global account and restart every open idle worktree
  app.post('/api/codex/accounts/switch', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    controlled(request, true);
    const id = body(request).id;
    // require one bounded configured identifier
    if (typeof id !== 'string' || !safeAccountId.test(id)) return reply.code(400).send({ error: 'Invalid ChatGPT account.' });
    // serialize switch and restart handoffs
    if (accountSwitching) return reply.code(409).send({ error: 'Another ChatGPT account switch is already running.' });
    accountSwitching = true;
    try {
      const selectionMutationGeneration = prompts.mutationGeneration();
      const discovered = await discovery.dashboard();
      const queuedCounts = await queuedPromptCounts(discovered.agents);
      const byWorktree = new Map<string, Agent[]>();
      // group only open configured worktrees
      for (const agent of discovered.agents) {
        // ignore scratch, stale configured identifiers and Review runs' own Agents
        if (agent.worktreeId === undefined || isReviewRun(agent) || discovery.worktreesNow().every(worktree => worktree.id !== agent.worktreeId)) continue;
        const group = byWorktree.get(agent.worktreeId) ?? [];
        group.push(agent);
        byWorktree.set(agent.worktreeId, group);
      }
      const restartTargets: Array<{ agentId: string; worktreeId: string; mutationVersion: number; mutationGeneration: number }> = [];
      const skipped: Array<{ worktreeId: string; status: 'skipped'; error: string }> = [];
      // select only unambiguous idle worktrees
      for (const [worktreeId, agents] of byWorktree) {
        const agent = agents[0];
        // preserve duplicate, active, questioning, and queued work
        if (agent === undefined || agents.length !== 1 || agentAttentionState(agent) !== 'finished' || (queuedCounts.get(agent.id) ?? 1) > 0) {
          skipped.push({ worktreeId, status: 'skipped', error: 'The worktree is not idle.' });
          continue;
        }
        restartTargets.push({ agentId: agent.id, worktreeId, mutationVersion: prompts.mutationVersion(agent.id), mutationGeneration: selectionMutationGeneration });
      }
      const account = await accounts.switchAccount(id);
      const restarted = await Promise.all(restartTargets.map(async target => {
        try {
          const result = await restartIdleConfiguredAgent(target.agentId, target.worktreeId, target.mutationVersion, target.mutationGeneration);
          // expose only the stable worktree outcome
          return result.status === 'restarted'
            ? { worktreeId: result.worktreeId, status: 'restarted' as const }
            : { worktreeId: result.worktreeId, status: result.status, error: result.error };
        } catch {
          return { worktreeId: target.worktreeId, status: 'failed' as const, error: 'The worktree could not be restarted.' };
        }
      }));
      return { account: publicAccount(account), restarts: [...restarted, ...skipped] };
    } catch {
      return reply.code(404).send({ error: 'Unable to switch ChatGPT accounts.' });
    } finally {
      accountSwitching = false;
    }
  });
  // redeem one reset credit for a configured ChatGPT account
  app.post('/api/codex/accounts/:id/reset', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
    controlled(request, true);
    const id = (request.params as { id: string }).id;
    // require one bounded configured identifier
    if (!safeAccountId.test(id)) return reply.code(400).send({ error: 'Invalid ChatGPT account.' });
    try {
      const result = await accounts.consumeRateLimitReset(id);
      return { outcome: result.outcome, ...(result.account === undefined ? {} : { account: publicAccount(result.account) }) };
    } catch (error) {
      // reject resets unsupported by the stored auth mode
      if (error instanceof UnsupportedAccountOperationError) return reply.code(400).send({ error: 'API key accounts do not support ChatGPT resets.' });
      // distinguish missing slots from provider failures
      if (error instanceof Error && error.message === 'Account not found') return reply.code(404).send({ error: 'ChatGPT account not found.' });
      return reply.code(502).send({ error: 'Unable to use the ChatGPT reset.' });
    }
  });
  // start one isolated ChatGPT device-code login
  app.post('/api/codex/accounts/login', { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async (request, reply) => {
    controlled(request, true);
    const repairAccountId = body(request).repairAccountId;
    // validate optional repair targets
    if (repairAccountId !== undefined && (typeof repairAccountId !== 'string' || !safeAccountId.test(repairAccountId))) return reply.code(400).send({ error: 'Invalid ChatGPT account.' });
    try {
      return reply.code(201).send({ login: await accounts.startAddAccount(repairAccountId) });
    } catch (error) {
      // reject device repair unsupported by the stored auth mode
      if (error instanceof UnsupportedAccountOperationError) return reply.code(400).send({ error: 'API key accounts do not support ChatGPT login.' });
      // distinguish missing repair targets
      if (error instanceof Error && error.message === 'Account not found') return reply.code(404).send({ error: 'ChatGPT account not found.' });
      return reply.code(503).send({ error: 'Unable to start ChatGPT login.' });
    }
  });
  // save one api key as an alternative codex account
  app.post('/api/codex/accounts/api-key', { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async (request, reply) => {
    controlled(request, true);
    const apiKey = normalizeApiKey(body(request).apiKey);
    // require one bounded key without provider-specific prefix assumptions
    if (apiKey === undefined) return reply.code(400).send({ error: 'Invalid API key.' });
    try {
      return reply.code(201).send({ account: publicAccount(await accounts.addApiKeyAccount(apiKey)) });
    } catch {
      return reply.code(503).send({ error: 'Unable to add API key account.' });
    }
  });
  // report one device-code login state
  app.get('/api/codex/accounts/login/:id', async (request) => {
    controlled(request);
    const status = await accounts.status((request.params as { id: string }).id);
    // flatten newly configured accounts
    return status.status === 'succeeded' ? { ...status, account: publicAccount(status.account) } : status;
  });
  // cancel one abandoned device-code login
  app.delete('/api/codex/accounts/login/:id', async (request, reply) => {
    controlled(request, true);
    return await accounts.cancelAddAccount((request.params as { id: string }).id) ? reply.code(204).send() : reply.code(404).send({ error: 'ChatGPT login unavailable.' });
  });
  // resume a listed Conversation in its home Worktree. `:id` is the Conversation's home
  // Worktree; the body's `{ kind, id }` is one row of that Project's conversations list. A
  // shared codex-family rollout resumes under the Worktree's remembered Launch kind (ADR
  // 0005 relaxed), and the id is resolved and validated through that kind's own Adapter.
  app.post('/api/worktrees/:id/conversations/switch', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    controlled(request, true);
    const id = (request.params as { id: string }).id;
    const { kind, id: conversationId } = body(request) as { kind?: unknown; id?: unknown };
    const worktree = configuredWorktree(id);
    // require one configured worktree
    if (worktree === undefined) return await nonWorktreeReply(id, reply);
    // reject a malformed switch target
    if (typeof conversationId !== 'string' || typeof kind !== 'string' || !agentKinds.includes(kind as AgentKind)) return reply.code(400).send({ error: 'invalid conversation' });
    const rowKind = kind as AgentKind;
    // a shared codex-family row follows the Worktree's remembered Launch kind (codex or omx),
    // else Codex; every other kind resumes as itself
    const resumeKind = codexFamily(rowKind) ? await rememberedCodexKind(worktree.id) : rowKind;
    // resume through the row's own Adapter (validId replaces the launch service's UUID check)
    if (adapterFor(resumeKind)?.conversations?.validId(conversationId) !== true) return reply.code(409).send({ error: 'This conversation cannot be resumed.' });
    // the resolved kind must itself be launchable, so a de-configured kind (e.g. a Worktree
    // that last ran OMX after OMX was removed) fails here rather than after the restart path
    // has already closed the live agent
    if (launch.isLaunchableKind?.(resumeKind) === false) return reply.code(409).send({ error: 'This conversation cannot be resumed.' });
    // require the Conversation to be homed in this Worktree: a scan of only this Worktree's
    // directory lists it exactly when the agent's own picker would resume it here
    const homeDirectory = worktreeHostRoot(worktree);
    const homed = (await discovery.conversations([homeDirectory])).some(row => sameConversation(row, { kind: rowKind, id: conversationId }));
    if (!homed) return reply.code(409).send({ error: 'This conversation does not belong to this worktree.' });
    // fail before any destructive handoff
    if (!launch.canResumeConversation(worktree.id)) return reply.code(409).send({ error: 'Exact chat resume is not configured for this worktree.' });
    const selectionMutationGeneration = prompts.mutationGeneration();
    const current = await discovery.dashboard(true);
    const open = worktreeAgents(current.agents, worktree.id);
    // avoid an ambiguous destructive handoff
    if (open.length > 1) return reply.code(409).send({ error: 'Close duplicate worktree agents before switching chats.' });
    const activeAgent = open[0];
    // restart one existing idle agent safely, resuming through the row's own Adapter
    if (activeAgent !== undefined) {
      const result = await restartIdleConfiguredAgent(activeAgent.id, worktree.id, prompts.mutationVersion(activeAgent.id), selectionMutationGeneration, conversationId, resumeKind);
      // return one successful replacement
      if (result.status === 'restarted') return reply.code(201).send({ agentId: result.agentId });
      // distinguish stale targets from active work
      if (result.status === 'skipped') return reply.code(result.reason === 'unavailable' ? 404 : 409).send({ error: result.error });
      return reply.code(result.reason === 'timed-out' ? 504 : 409).send({ error: result.error });
    }
    const before = new Set(current.agents.map(agent => agent.id));
    // launch an inactive worktree directly into the Conversation, through its own Adapter
    if (!await launch.resumeConversation(worktree.id, conversationId, resumeKind)) return reply.code(409).send({ error: 'Could not resume the conversation.' });
    const agent = await waitForAgent(before, inWorktree(worktree.id));
    // surface slow or failed resume handoffs
    if (agent === undefined) return reply.code(504).send({ error: `The conversation started, but the agent did not become ready within ${launchReadyTimeoutSeconds} seconds.` });
    await dashboardUpdates.refresh().catch(() => undefined);
    return reply.code(201).send({ agentId: agent.id });
  });
  // restart one idle configured agent by resuming its last conversation
  app.post('/api/agents/:id/restart', async (request, reply) => {
    controlled(request, true);
    const id = (request.params as { id: string }).id;
    const kind = requestedKind(request);
    // reject an unknown kind before any handoff
    if (kind.invalid) return reply.code(400).send({ error: 'invalid agent kind' });
    const mutationGeneration = prompts.mutationGeneration();
    const result = await restartIdleConfiguredAgent(id, undefined, prompts.mutationVersion(id), mutationGeneration, undefined, kind.kind);
    // return one successful replacement
    if (result.status === 'restarted') return reply.code(201).send({ agentId: result.agentId });
    // distinguish missing targets from active work
    if (result.status === 'skipped') return reply.code(result.reason === 'unavailable' ? 404 : 409).send({ error: result.error });
    return reply.code(result.reason === 'timed-out' ? 504 : 409).send({ error: result.error });
  });
  app.post('/api/worktrees/:id/launch', async (request, reply) => {
    controlled(request, true);
    const worktreeId = (request.params as { id: string }).id;
    const kind = requestedKind(request);
    // reject an unknown kind before any handoff
    if (kind.invalid) return reply.code(400).send({ error: 'invalid agent kind' });
    const before = new Set((await discovery.dashboard()).agents.map(agent => agent.id));
    // require a successful launch handoff (refuses an unconfigured or unlaunchable kind)
    if (!await launch.launch(worktreeId, kind.kind)) return reply.code(409).send({ error: 'Could not start the worktree agent.' });
    const agent = await waitForAgent(before, inWorktree(worktreeId));
    // report a true timeout
    if (!agent) return reply.code(504).send({ error: `The worktree session started, but Codex did not become ready within ${launchReadyTimeoutSeconds} seconds.` });
    return reply.code(201).send({ agentId: agent.id });
  });
  // the Run target that launches at a Place, as its launcher row does; an ad-hoc Scratch folder
  // has no launch of its own, only the configured Scratch folder does
  const placeRunTarget = (place: Place): ScheduleTarget | undefined => {
    if (place.kind === 'worktree') return { worktreeId: place.id };
    if (place.kind === 'directory') return { projectId: place.projectId };
    return place.adhoc === true ? undefined : { scratch: true };
  };
  // Launch and run one Note on an idle Place tab — the fresh-launch entry into the Run
  // primitive (Scheduled prompts). It records nothing on the Note and returns the new agent id
  // so the web can switch to its tab; the primitive keeps the 409 / 504 / 502 contract /launch
  // uses (a blocked or slow readiness closes the pane it created), mapped from the outcome.
  app.post('/api/worktrees/:id/notes/:noteId/run', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    controlled(request, true);
    const { id, noteId } = request.params as { id: string; noteId: string };
    const kind = requestedKind(request);
    // reject an unknown kind before any handoff
    if (kind.invalid) return reply.code(400).send({ error: 'invalid agent kind' });
    const place = await resolvePlace(id);
    if (place === undefined) return reply.code(404).send({ error: 'place unavailable' });
    const note = (await notes.list(placeNoteKey(place)))?.find(candidate => candidate.id === noteId);
    if (note === undefined) return reply.code(404).send({ error: 'note unavailable' });
    // never launch an agent for a note without prompt content
    if (!validPrompt(note.text, note.attachments ?? [])) return reply.code(400).send({ error: 'note is empty' });
    const target = placeRunTarget(place);
    if (target === undefined) return reply.code(409).send({ error: 'The console cannot launch an agent in this folder.' });
    const outcome = await performRun({ text: note.text, attachments: note.attachments ?? [], kind: kind.kind, target });
    if (outcome.status === 'launched') return reply.code(201).send({ agentId: outcome.agentId });
    const failure = runFailureReply(outcome);
    return reply.code(failure.code).send({ error: failure.error });
  });
  // launch an agent in place in a non-git `directory` Project (it has no Worktrees). The
  // launch joins the Project's Place, so the new Agent is matched back by its Place.
  app.post('/api/projects/:id/launch', async (request, reply) => {
    controlled(request, true);
    const projectId = (request.params as { id: string }).id;
    const kind = requestedKind(request);
    // reject an unknown kind before any handoff
    if (kind.invalid) return reply.code(400).send({ error: 'invalid agent kind' });
    // only an available non-git directory Project launches in place, joining its Place
    const place = await launch.directoryPlace(projectId);
    if (place === undefined) return reply.code(404).send({ error: 'project unavailable' });
    const before = new Set((await discovery.dashboard()).agents.map(agent => agent.id));
    // require a successful launch handoff (refuses an unconfigured or unlaunchable kind)
    if (!await launch.launchProjectDirectory(projectId, kind.kind)) return reply.code(409).send({ error: 'Could not start the project agent.' });
    const agent = await waitForAgent(before, atPlace(place.id));
    // report a true timeout
    if (!agent) return reply.code(504).send({ error: `The project session started, but the agent did not become ready within ${launchReadyTimeoutSeconds} seconds.` });
    return reply.code(201).send({ agentId: agent.id });
  });
  // the branches the Add dialog offers — local branches (flagged when a Worktree already
  // holds one, which the checkout picker hides but the base picker keeps) plus remote-only
  // branches — and the resolved default branch to pre-select the base
  app.get('/api/projects/:id/branches', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    controlled(request);
    const result = await worktreeManagement.branches((request.params as { id: string }).id);
    if (!result.ok) return reply.code(result.status).send({ error: result.error });
    return { branches: result.branches, ...(result.defaultBranch === undefined ? {} : { defaultBranch: result.defaultBranch }) };
  });
  // create a Worktree for a new or existing branch, pin it, run the Project's configured
  // `commands.setup` to prepare the fresh checkout, give it an idle shell, and — unless the
  // operator opted out — launch the Project's last-used kind in it. The created Worktree
  // stands even when setup or the agent launch fails, so the response is a 201 carrying the
  // new Worktree id plus the started agent, a launch error, and/or a setup error, never a 504.
  app.post('/api/projects/:id/worktrees', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    controlled(request, true);
    const projectId = (request.params as { id: string }).id;
    const requestBody = body(request);
    // a stale client's `launch: false` predates the open choice and meant the idle shell alone
    const { mode, branch, base, number, open = requestBody.launch === false ? 'terminal' : 'agent' } = requestBody;
    // hand-validate the body before any git runs
    // structural validation only; the service owns branch-name legality (a 409)
    if (mode !== 'new' && mode !== 'existing' && mode !== 'pull-request') return reply.code(400).send({ error: 'invalid worktree mode' });
    // a pull request is named by number alone; its branch comes from the server's own PR list
    if (mode === 'pull-request' && (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1)) return reply.code(400).send({ error: 'invalid pull request number' });
    if (mode !== 'pull-request' && (typeof branch !== 'string' || branch.length === 0)) return reply.code(400).send({ error: 'invalid branch name' });
    if (base !== undefined && (typeof base !== 'string' || base.length > 255)) return reply.code(400).send({ error: 'invalid base' });
    if (open !== 'agent' && open !== 'terminal' && open !== 'empty') return reply.code(400).send({ error: 'invalid open choice' });
    // the service refuses an Agent for a fork pull request, which it resolves from its own list
    const outcome = await worktreeManagement.add(projectId, mode === 'pull-request' ? { mode, number: number as number, openAgent: open === 'agent' } : { mode, branch: branch as string, ...(typeof base === 'string' ? { base } : {}) });
    if (!outcome.ok) return reply.code(outcome.status).send({ error: outcome.error });
    // republish discovery so the new checkout is keyed and resolvable before pin and launch
    discovery.invalidateWorktrees();
    const worktree = (await discovery.worktrees(true)).find(candidate => candidate.identity === outcome.path);
    const worktreeId = worktree?.id ?? worktreeWireId(projectId, outcome.path);
    // a created checkout keeps its tab from the start
    await worktreeStore.setPinned(worktreeId, true).catch(() => {});
    // Prepare the fresh checkout, then open what the operator chose: `terminal` gives it its idle
    // shell, `agent` adds the Project's last-used kind (the launch path adopts that idle shell
    // once it is up, else starts the agent's own session), and `empty` opens nothing — the pin
    // alone keeps its tab. Setup runs once here in every mode (a no-op when unconfigured) and
    // blocks until it finishes; a setup failure never fails the creation but does gate the
    // agent, so none starts into a half-prepared worktree. A fork pull request's code never runs
    // setup (and the service already refused an agent for it). The creation stands regardless:
    // any failure past this point is a setupError and/or launchError, never a non-201.
    let agentId: string | undefined;
    let launchError: string | undefined;
    let setupError: string | undefined;
    if (worktree === undefined) {
      launchError = 'The worktree was created, but it could not be resolved to prepare or open it.';
    } else {
      const setup = outcome.fork === true ? { ok: true as const } : await stackCommands.runSetup(worktree);
      if (!setup.ok) {
        setupError = 'The worktree was created, but its setup command failed.';
        // the operator sees a generic banner; the host log (kept only on failure) carries the output
        if (setup.log !== undefined) console.error(`[worktrees] setup failed for ${worktreeId}; see ${setup.log}`);
      }
      if (open === 'terminal' || (open === 'agent' && !setup.ok)) {
        // a Terminal, or an Agent whose setup failed, gets the idle shell alone
        if (!await launch.startWorktreeShell(worktree)) launchError = 'The worktree was created, but its shell could not be started.';
      } else if (open === 'agent') {
        await launch.startWorktreeShell(worktree);
        const before = new Set((await discovery.dashboard()).agents.map(agent => agent.id));
        // report the agent when it appears, but never fail the creation on a slow launch
        if (await launch.launch(worktreeId)) agentId = (await waitForAgent(before, inWorktree(worktreeId)))?.id;
        else launchError = 'The worktree was created, but the agent could not be started.';
      }
    }
    discovery.invalidateWorktrees();
    await dashboardUpdates.refresh().catch(() => undefined);
    return reply.code(201).send({ worktreeId, ...(agentId === undefined ? {} : { agentId }), ...(launchError === undefined ? {} : { launchError }), ...(setupError === undefined ? {} : { setupError }) });
  });
  // the session + socket of a Place's live Agent, so a new Console shell or Agent opens beside it
  // (an Agent adopted into the operator's own session lives wherever, so it is resolved from
  // discovery, never by session name). The scan is forced: a restart closes its Agent and
  // relaunches inside the dashboard cache window, and a cached Agent's session may be gone.
  const placeAgentSession = async (placeId: string): Promise<TmuxSession | undefined> => {
    const agent = (await discovery.dashboard(true)).agents.find(candidate => candidate.placeId === placeId);
    if (agent === undefined) return undefined;
    const target = await discovery.target(agent.id);
    return target === undefined ? undefined : { socket: target.socket, session: agentTmuxSession(target.agent) };
  };
  // shape one Worktree pane for the wire: its id, session, role/name markers (a Stack
  // process's pane is named for its process) and the busy flag for a Console shell, and
  // whether it is a live Agent's own pane (the picker disables it). `agentIds` holds Agent
  // ids, which are `${fingerprint}:${paneId}` — the same key this rebuilds from the pane, so
  // a pane backing a live Agent is matched.
  const worktreePaneView = (pane: Pane, agentIds: ReadonlySet<string>) => {
    const name = pane.paneName ?? pane.processName;
    return {
      paneId: pane.paneId, session: pane.sessionId, ...(pane.sessionName ? { sessionName: pane.sessionName } : {}),
      // the pane's tmux window, so the picker can disable every pane sharing a window with an
      // open Terminal (one Size claim per window, the invariant the socket's claim relies on)
      ...(pane.windowId ? { window: pane.windowId } : {}),
      ...(pane.role ? { role: pane.role } : {}), ...(name ? { name } : {}),
      command: pane.command, path: pane.path, title: pane.title,
      agent: agentIds.has(`${pane.socket.fingerprint}:${pane.paneId}`),
      ...(pane.role === 'shell' ? { busy: launch.consoleShellBusy(pane) } : {})
    };
  };
  // list every pane the console may stream for a Place (its Agent's session, its Console
  // shells, idle landing shells), a read behind the read guard (spec, Console shells)
  app.get('/api/worktrees/:id/panes', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request, reply) => {
    controlled(request);
    const place = await resolvePlace((request.params as { id: string }).id);
    if (place === undefined) return reply.code(404).send({ error: 'place unavailable' });
    const [panes, dashboard] = await Promise.all([launch.placePanes(place), discovery.dashboard()]);
    // every live Agent's pane, whatever its Place: the Place pane socket refuses them all
    const agentIds = new Set(dashboard.agents.map(agent => agent.id));
    return { panes: panes.map(pane => worktreePaneView(pane, agentIds)) };
  });
  // open a Console shell at the Place: beside its live Agent, else the session holding its
  // Console shells, else a fresh console session named for the Place (spec, Console shells)
  app.post('/api/worktrees/:id/shells', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    const browserSession = controlled(request, true);
    const place = await resolvePlace((request.params as { id: string }).id);
    if (place === undefined) return reply.code(404).send({ error: 'place unavailable' });
    const { name, editor, file, line, objectToken, binding, settingsSource } = body(request);
    if (name !== undefined && (typeof name !== 'string' || name.length > 120 || name.includes('\0') || /[\r\n]/u.test(name))) return reply.code(400).send({ error: 'invalid terminal name' });
    // a key binding's Terminal: the browser names the binding, and its command comes from config
    if (binding !== undefined) {
      const { table, key } = (binding !== null && typeof binding === 'object' ? binding : {}) as { table?: unknown; key?: unknown };
      if (typeof table !== 'string' || typeof key !== 'string' || Object.keys(binding as object).length !== 2 || name !== undefined || editor !== undefined || file !== undefined || line !== undefined || objectToken !== undefined || settingsSource !== undefined) return reply.code(400).send({ error: 'invalid key binding' });
      const resolved = terminalBindingCommand(config.keys, table, key);
      if (resolved === undefined) return reply.code(400).send({ error: 'no terminal is bound to that key' });
      const bindingId = `${table} ${key}`;
      // reuse focuses the binding's Terminal (tagged with it) while it runs; its pane closes when the command exits
      const running = resolved.reuse ? (await launch.placeConsoleShells(place)).find(pane => pane.keyBinding === bindingId && pane.dead !== true) : undefined;
      if (running !== undefined) return reply.code(200).send({ paneId: running.paneId, reused: true });
      const paneId = await launch.createConsoleShell(place, terminalProgramName(resolved.command), resolved.command, bindingId);
      if (paneId === undefined) return reply.code(500).send({ error: 'could not open a terminal' });
      await dashboardUpdates.refresh().catch(() => undefined);
      return reply.code(201).send({ paneId });
    }
    if (editor !== undefined && typeof editor !== 'boolean') return reply.code(400).send({ error: 'invalid editor flag' });
    // accept Files capabilities only for configured-editor launches
    if (objectToken !== undefined && (editor !== true || typeof objectToken !== 'string')) return reply.code(400).send({ error: 'invalid editor file selection' });
    // keep capability launches distinct from legacy Place-relative file and line launches
    if (objectToken !== undefined && (file !== undefined || line !== undefined)) return reply.code(400).send({ error: 'invalid editor file selection' });
    const sourceSelection = settingsSource !== null && typeof settingsSource === 'object' && !Array.isArray(settingsSource) ? settingsSource as Record<string, unknown> : undefined;
    // accept only one exact revision-bound settings source selection
    if (settingsSource !== undefined && (sourceSelection === undefined || Object.keys(sourceSelection).length !== 2 || !Object.hasOwn(sourceSelection, 'sourceId') || !Object.hasOwn(sourceSelection, 'revisionId') || typeof sourceSelection.sourceId !== 'string' || sourceSelection.sourceId.length < 1 || sourceSelection.sourceId.length > 64 || /[\0\r\n]/u.test(sourceSelection.sourceId) || typeof sourceSelection.revisionId !== 'string' || sourceSelection.revisionId.length < 1 || sourceSelection.revisionId.length > 128 || /[\0\r\n]/u.test(sourceSelection.revisionId))) return reply.code(400).send({ error: 'invalid settings source selection' });
    // keep installed settings authority distinct from every browser-selected file capability
    if (settingsSource !== undefined && (editor !== true || file !== undefined || line !== undefined || objectToken !== undefined || binding !== undefined)) return reply.code(400).send({ error: 'invalid settings source selection' });
    // the Editor button: a shell that runs the configured editor first, named for its program
    if (editor === true && config.editor === undefined) return reply.code(400).send({ error: 'no editor is configured' });
    // the guided review's jump to a line: a file inside the Place, opened at that line
    if ((file !== undefined || line !== undefined) && editor !== true) return reply.code(400).send({ error: 'a file opens only in the editor' });
    if (file !== undefined && !isPlaceRelativeFile(file)) return reply.code(400).send({ error: 'invalid file' });
    if (line !== undefined && (file === undefined || !Number.isSafeInteger(line) || (line as number) < 1)) return reply.code(400).send({ error: 'invalid line' });
    let selectedFile = file as string | undefined;
    // resolve opaque Files authority only after authentication, control and input validation
    if (typeof objectToken === 'string') {
      try { selectedFile = await hostFiles.editorFile(place, browserSession, objectToken); }
      catch (error) {
        // preserve stable public Files failures without exposing backend details
        if (error instanceof HostFilesError) return reply.code(error.statusCode).send({ error: error.message });
        // collapse broker transport failures to the existing unavailable response
        if (error instanceof HostFilesTransportError) return reply.code(503).send({ error: 'host files bridge is unavailable' });
        throw error;
      }
    }
    // resolve only the current installed settings source after fixed input checks
    if (sourceSelection !== undefined) {
      try { selectedFile = await settings.editorFile(sourceSelection.sourceId as string, sourceSelection.revisionId as string); }
      catch (error) {
        // publish only bounded settings failure codes
        if (error instanceof SettingsError) return reply.code(error.statusCode).send({ error: error.code });
        throw error;
      }
      // prevent a controller takeover during source inspection from launching the editor
      controlled(request, true);
    }
    const command = editor === true ? editorCommand(config.editor ?? '', selectedFile, line as number | undefined) : '';
    const paneId = await launch.createConsoleShell(place, typeof name === 'string' ? name : command === '' ? '' : basename(command.split(/\s+/u)[0]!), command);
    if (paneId === undefined) return reply.code(500).send({ error: 'could not open a terminal' });
    await dashboardUpdates.refresh().catch(() => undefined);
    return reply.code(201).send({ paneId });
  });
  // rename a Console shell (writes `@rac_pane_name`); membership is enforced by finding the
  // pane among the Place's own Console shells
  app.patch('/api/worktrees/:id/panes/:paneId', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    controlled(request, true);
    const { id, paneId } = request.params as { id: string; paneId: string };
    const place = await resolvePlace(id);
    if (place === undefined) return reply.code(404).send({ error: 'place unavailable' });
    const name = body(request).name;
    if (typeof name !== 'string' || name.length > 120 || name.includes('\0') || /[\r\n]/u.test(name)) return reply.code(400).send({ error: 'invalid terminal name' });
    const shell = (await launch.placeConsoleShells(place)).find(candidate => candidate.paneId === paneId);
    if (shell === undefined) return reply.code(404).send({ error: 'terminal unavailable' });
    if (!await tmux.renamePaneName(shell.socket, shell.paneId, name)) return reply.code(500).send({ error: 'could not rename the terminal' });
    await dashboardUpdates.refresh().catch(() => undefined);
    return reply.code(204).send();
  });
  // End a Console shell (kill-pane). A busy shell (its foreground command is not the login
  // shell) returns 409 `busy` unless `?confirm=1`, so the client can confirm first (spec)
  app.delete('/api/worktrees/:id/panes/:paneId', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    controlled(request, true);
    const { id, paneId } = request.params as { id: string; paneId: string };
    const place = await resolvePlace(id);
    if (place === undefined) return reply.code(404).send({ error: 'place unavailable' });
    const confirm = (request.query as { confirm?: unknown }).confirm; const confirmed = confirm === '1' || confirm === 'true';
    const shell = (await launch.placeConsoleShells(place)).find(candidate => candidate.paneId === paneId);
    if (shell === undefined) return reply.code(404).send({ error: 'terminal unavailable' });
    if (!confirmed && launch.consoleShellBusy(shell)) return reply.code(409).send({ error: 'the terminal is busy', busy: true });
    if (!await tmux.close(shell.socket, shell.paneId)) return reply.code(500).send({ error: 'could not end the terminal' });
    await dashboardUpdates.refresh().catch(() => undefined);
    return reply.code(204).send();
  });
  // the runtime blockers that refuse a Remove, named for the 409: a live Agent in the
  // Worktree, or a running stack operation there. `fresh` forces a live pane scan before a
  // destructive removal so an Agent that started within the discovery cache window is never
  // missed (CONTRIBUTING: validate immediately before a destructive operation).
  const worktreeRemovalBlockers = async (worktree: Worktree, fresh = false): Promise<string[]> => {
    const blockers: string[] = [];
    // a Review run's Agent also reads the checkout, so it blocks too, named for what it is
    // an Ask's Agent waiting for a follow-up is closed by the Remove itself
    const idleKept = interactiveRunner.idleKeptAgents();
    const running = (await discovery.dashboard(fresh)).agents.filter(agent => agent.worktreeId === worktree.id && !idleKept.has(agent.id));
    if (worktreeAgents(running, worktree.id).length > 0) blockers.push('a running agent');
    else if (running.length > 0) blockers.push('a Review run');
    if (await stackCommands.sessionRunning(worktree)) blockers.push('a running stack command');
    return blockers;
  };
  // why a Remove is refused right now, if it is: a runtime blocker, or an open Console shell,
  // so a removal cannot pull the directory out from under the operator's shell — the reason the
  // launcher row shows (spec, Console shells). Always a fresh scan, as it guards the removal.
  const worktreeRemovalRefusal = async (worktree: Worktree): Promise<string | undefined> => {
    const blockers = await worktreeRemovalBlockers(worktree, true);
    if (blockers.length > 0) return `cannot remove the worktree while ${blockers.join(' and ')} ${blockers.length === 1 ? 'is' : 'are'} running`;
    if ((await launch.placeConsoleShells(worktree)).length > 0) return 'End the open terminals before removing this worktree';
    return undefined;
  };
  // delete every record a Worktree leaves behind, keyed by its wire id: the pin and last-used
  // kind and the saved review tour with its Code review — so a removed (then possibly
  // recreated-at-the-same-path) Worktree leaves no stale trace. Queued prompts and history
  // belong to its Agents and are retired with them.
  // Project-scoped notes and console-named conversations are shared and deliberately retained.
  // Shared by Remove (one Worktree) and Prune (each orphaned record).
  const deleteWorktreeRecords = async (worktreeId: string): Promise<void> => {
    codeReviews.supersedeWorktree(worktreeId);
    void asks.supersedeWorktree(worktreeId, 'all');
    await Promise.all([
      worktreeStore.delete(worktreeId).catch(() => {}),
      reviewStore.invalidate(worktreeId).catch(() => {}),
      changeAskStore.forget(worktreeId).catch(() => {})
    ]);
  };
  // after a Prune, delete the console records whose path git now lists nowhere for this
  // Project — the orphaned-record half of the stale set discovery counts (ADR 0003)
  const pruneOrphanRecords = async (projectId: string): Promise<void> => {
    const listed = new Set((await discovery.worktrees(true)).filter(worktree => worktree.projectId === projectId).map(worktree => worktree.path));
    const orphans = (await worktreeStore.keys().catch(() => [] as string[])).filter(key => { if (projectIdOf(key) !== projectId) return false; const path = worktreePathOf(key); return path !== undefined && !listed.has(path); });
    await Promise.all(orphans.map(key => deleteWorktreeRecords(key)));
  };
  // expose fresh deletion facts for one branch in a worktree's repository
  app.get('/api/worktrees/:id/branch-removal', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    controlled(request);
    const branch = (request.query as { branch?: unknown }).branch;
    // validate the branch before repository lookup
    if (typeof branch !== 'string' || branch.length === 0 || branch.length > 255) return reply.code(400).send({ error: 'invalid branch name' });
    const id = (request.params as { id: string }).id;
    const worktree = configuredWorktree(id);
    // require a configured repository context
    if (worktree === undefined) return await nonWorktreeReply(id, reply);
    const result = await worktreeManagement.branchRemoval(worktree.projectId, branch);
    // surface fresh git refusals
    if (!result.ok) return reply.code(result.status).send({ error: result.error });
    return result.facts;
  });
  // delete one local branch behind fresh checkout, remote, and merge guards
  app.delete('/api/worktrees/:id/branch', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    controlled(request, true);
    const { branch, discardUnpushed } = body(request);
    // validate every destructive input
    if (typeof branch !== 'string' || branch.length === 0 || branch.length > 255) return reply.code(400).send({ error: 'invalid branch name' });
    // restrict the acknowledgement to a boolean
    if (discardUnpushed !== undefined && typeof discardUnpushed !== 'boolean') return reply.code(400).send({ error: 'invalid discardUnpushed flag' });
    const id = (request.params as { id: string }).id;
    const worktree = configuredWorktree(id);
    // require a configured repository context
    if (worktree === undefined) return await nonWorktreeReply(id, reply);
    const result = await worktreeManagement.deleteBranchGuarded(worktree.projectId, branch, discardUnpushed === true);
    // preserve the branch on every guard failure
    if (!result.ok) return reply.code(result.status).send({ error: result.error });
    await cleanup.scan().catch(() => undefined);
    await dashboardUpdates.refresh().catch(() => undefined);
    return reply.code(204).send();
  });
  // the linked Worktrees whose pull request merged or closed at or past their checked-out head,
  // which the launcher offers to Remove. It asks GitHub, so it is read on demand, off the dashboard.
  app.get('/api/worktrees/closed-pull-requests', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async request => {
    controlled(request);
    return { worktrees: await worktreeManagement.closedPullRequestWorktrees(discovery.worktreesNow()) };
  });
  // the fresh facts the Remove dialog decides with, plus the runtime blockers and the running
  // Stack process a Remove would stop (a GET is a read, so it never mutates and stays off the
  // 10/min mutation budget)
  app.get('/api/worktrees/:id/removal', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    controlled(request);
    const id = (request.params as { id: string }).id;
    const worktree = configuredWorktree(id);
    if (worktree === undefined) return await nonWorktreeReply(id, reply);
    const result = await worktreeManagement.removal(worktree);
    if (!result.ok) return reply.code(result.status).send({ error: result.error });
    const [blockers, stopsProcesses] = await Promise.all([worktreeRemovalBlockers(worktree), stackCommands.runningProcesses(worktree)]);
    return { ...result.facts, blockers, stopsProcesses };
  });
  // remove one linked Worktree: refused on Main, on a locked checkout, while an Agent or a
  // stack session runs there, and on a dirty tree unless discardChanges was ticked. A running
  // Stack process is no blocker; it is stopped first. Order: stop the Stack process → kill the
  // idle shells → git worktree remove → delete records → optional branch delete → invalidate
  // → refresh (ADR 0003). A branch-delete failure is reported, never undone.
  app.delete('/api/worktrees/:id', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    controlled(request, true);
    const requestBody = body(request);
    const { discardChanges, deleteBranch } = requestBody;
    if (discardChanges !== undefined && typeof discardChanges !== 'boolean') return reply.code(400).send({ error: 'invalid discardChanges flag' });
    if (deleteBranch !== undefined && typeof deleteBranch !== 'boolean') return reply.code(400).send({ error: 'invalid deleteBranch flag' });
    const id = (request.params as { id: string }).id;
    const worktree = configuredWorktree(id);
    if (worktree === undefined) return await nonWorktreeReply(id, reply);
    if (worktree.main) return reply.code(409).send({ error: 'the main worktree cannot be removed' });
    if (worktree.locked) return reply.code(409).send({ error: 'Locked worktrees cannot be removed' });
    // the Agents kept for an Ask's follow-ups go first, so they do not refuse the Remove
    await asks.supersedeWorktree(worktree.id, 'all');
    const refusal = await worktreeRemovalRefusal(worktree);
    if (refusal !== undefined) return reply.code(409).send({ error: refusal });
    const facts = await worktreeManagement.removal(worktree);
    if (!facts.ok) return reply.code(facts.status).send({ error: facts.error });
    // a dirty tree needs the explicit discard; an unpushed one only warns, never blocks
    if (facts.facts.dirtyCount > 0 && discardChanges !== true) return reply.code(409).send({ error: 'the worktree has uncommitted changes; tick "Discard uncommitted changes" to remove it' });
    // the Stack process stays stopped until the checkout is gone: nothing can Start it meanwhile.
    // Its Stop can take seconds, so the refusals are checked again once it has stopped.
    const removed = await stackCommands.stopForRemoval(worktree, async () => {
      const late = await worktreeRemovalRefusal(worktree);
      if (late !== undefined) return { ok: false, status: 409, error: late } as const;
      await launch.killWorktreeShells(worktree);
      return await worktreeManagement.removeCheckout(worktree, { force: discardChanges === true });
    });
    if (removed === 'busy') return reply.code(409).send({ error: 'stack operation already running' });
    if (removed === false) return reply.code(500).send({ error: 'could not stop the stack process' });
    if (!removed.ok) return reply.code(removed.status).send({ error: removed.error });
    await deleteWorktreeRecords(worktree.id);
    let branchDeleted: boolean | undefined;
    let branchDeleteError: string | undefined;
    // deleting the branch is the operator's explicit decision — the dialog warns first when it
    // is neither pushed nor merged, so a request that still asks for it is honoured
    if (deleteBranch === true && facts.facts.branch !== undefined) {
      const outcome = await worktreeManagement.deleteBranch(worktree, facts.facts.branch);
      if (outcome.ok) branchDeleted = true; else branchDeleteError = outcome.error;
    }
    discovery.invalidateWorktrees();
    await dashboardUpdates.refresh().catch(() => undefined);
    return { removed: true, ...(branchDeleted === undefined ? {} : { branchDeleted }), ...(branchDeleteError === undefined ? {} : { branchDeleteError }) };
  });
  // clear git's prunable entries and the console's orphaned records for one Project, both
  // explicit and never automatic (ADR 0003)
  app.post('/api/projects/:id/worktrees/prune', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    controlled(request, true);
    const projectId = (request.params as { id: string }).id;
    const outcome = await worktreeManagement.prune(projectId);
    if (!outcome.ok) return reply.code(outcome.status).send({ error: outcome.error });
    await pruneOrphanRecords(projectId);
    discovery.invalidateWorktrees();
    await dashboardUpdates.refresh().catch(() => undefined);
    return reply.code(204).send();
  });
  app.post('/api/worktrees/:id/commands/:action', async (request, reply) => { controlled(request, true); const id = (request.params as { id: string }).id; if (configuredWorktree(id) === undefined) return await nonWorktreeReply(id, reply, { missing: { error: 'stack command unavailable' } }); const action = (request.params as { action: string }).action; if (!(stackActions as readonly string[]).includes(action)) return reply.code(404).send({ error: 'stack command unavailable' }); const result = await stackCommands.start(id, action as StackAction); if (result === 'busy') return reply.code(409).send({ error: 'stack operation already running' }); return result === false ? reply.code(404).send({ error: 'stack command unavailable' }) : reply.code(202).send(); });
  app.get('/api/worktrees/:id/commands/log', async (request, reply) => {
    controlled(request, false);
    const id = (request.params as { id: string }).id;
    if (configuredWorktree(id) === undefined) return await nonWorktreeReply(id, reply, { missing: { error: 'stack log unavailable' } });
    const log = await stackCommands.log(id);
    // report stacks without retained output separately
    if (log === undefined) return reply.code(404).send({ error: 'stack log unavailable' });
    return log;
  });
  // Start, Stop or Restart one Stack process of the Worktree, leaving the others alone; a name it
  // does not configure, or a one-shot action, has no route
  app.post('/api/worktrees/:id/processes/:name/:action', async (request, reply) => {
    controlled(request, true);
    const { id, name, action } = request.params as { id: string; name: string; action: string };
    const worktree = configuredWorktree(id);
    if (worktree === undefined) return await nonWorktreeReply(id, reply, { missing: { error: 'stack command unavailable' } });
    if (!Object.hasOwn(worktree.commands?.processes ?? {}, name) || !(processActions as readonly string[]).includes(action)) return reply.code(404).send({ error: 'stack command unavailable' });
    const result = await stackCommands.start(id, action as StackAction, name);
    if (result === 'busy') return reply.code(409).send({ error: 'stack operation already running' });
    return result === false ? reply.code(500).send({ error: 'stack command failed' }) : reply.code(202).send();
  });
  // a Stack process's recent output, read from its pane, beside its state
  app.get('/api/worktrees/:id/processes/:name/output', async (request, reply) => {
    controlled(request, false);
    const { id, name } = request.params as { id: string; name: string };
    if (configuredWorktree(id) === undefined) return await nonWorktreeReply(id, reply, { missing: { error: 'process output unavailable' } });
    const output = await stackCommands.processOutput(id, name);
    if (output === undefined) return reply.code(404).send({ error: 'process output unavailable' });
    if (output === 'unavailable') return reply.code(503).send({ error: 'tmux unavailable' });
    return output;
  });
  // the Stack panel's Clear: empty a Stack process's pane so its output starts fresh
  app.delete('/api/worktrees/:id/processes/:name/output', async (request, reply) => {
    controlled(request, true);
    const { id, name } = request.params as { id: string; name: string };
    if (configuredWorktree(id) === undefined) return await nonWorktreeReply(id, reply, { missing: { error: 'process output unavailable' } });
    const cleared = await stackCommands.clearProcessOutput(id, name);
    if (cleared === undefined) return reply.code(404).send({ error: 'process output unavailable' });
    if (cleared === 'unavailable') return reply.code(503).send({ error: 'tmux unavailable' });
    return reply.code(204).send();
  });
  app.post('/api/agents/launch', async (request, reply) => {
    controlled(request, true);
    const kind = requestedKind(request);
    // reject an unknown kind before any handoff
    if (kind.invalid) return reply.code(400).send({ error: 'invalid agent kind' });
    const before = new Set((await discovery.dashboard()).agents.map(agent => agent.id));
    if (!await launch.launchHome(kind.kind)) return reply.code(409).send({ error: 'Could not start a new agent session.' });
    const scratch = await launch.scratchPlace();
    const agent = await waitForAgent(before, atPlace(scratch.id));
    // report a true timeout
    if (!agent) return reply.code(504).send({ error: `The new session started, but Codex did not become ready within ${launchReadyTimeoutSeconds} seconds.` });
    return reply.code(201).send({ agentId: agent.id });
  });
  // Open folder (ADR 0014): open any folder as a Workspace by launching an Agent at its Place,
  // opening a Console shell there, or pinning it; then record it as recent. A first launch in a
  // folder may stop on the agent's trust prompt, which is reported as needing the operator.
  app.post('/api/folders/open', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    controlled(request, true);
    const { path, action } = body(request);
    const kind = requestedKind(request);
    if (action !== 'agent' && action !== 'terminal' && action !== 'empty') return reply.code(400).send({ error: 'invalid action' });
    if (kind.invalid) return reply.code(400).send({ error: 'invalid agent kind' });
    const folder = await resolveFolderPath(path, launch.agentHome());
    if ('error' in folder) return reply.code(400).send({ error: folder.error });
    const place = await discovery.openFolder(folder.path);
    if (place === undefined) return reply.code(409).send({ error: 'That folder could not be opened.' });
    let opened: { agentId?: string; paneId?: string; needsOperator?: string };
    if (action === 'agent') {
      const before = new Set((await discovery.dashboard()).agents.map(agent => agent.id));
      if (!await launch.launchAt(place, kind.kind)) return reply.code(409).send({ error: 'Could not start an agent in that folder.' });
      await openedFolders.record(folder.path).catch(() => undefined);
      const agent = await waitForAgent(before, atPlace(place.id));
      if (agent === undefined) return reply.code(504).send({ error: `The session started, but the agent did not become ready within ${launchReadyTimeoutSeconds} seconds.` });
      // a short look for a blocking first screen; an agent still starting is left to start
      const readiness = await waitForReadiness(agent, openFolderReadinessAttempts);
      if (readiness.state === 'blocked' && await discovery.target(agent.id, true) === undefined) return reply.code(409).send({ error: 'The agent closed as it started.' });
      opened = { agentId: agent.id, ...(readiness.state === 'blocked' ? { needsOperator: readiness.reason } : {}) };
    } else if (action === 'terminal') {
      const paneId = await launch.createConsoleShell(place, '');
      if (paneId === undefined) return reply.code(500).send({ error: 'could not open a terminal' });
      opened = { paneId };
    } else {
      await worktreeStore.setPinned(place.id, true);
      discovery.invalidateWorktrees();
      // the store refuses a key it cannot hold, such as one past its size limits
      if ((await worktreeStore.pins())[place.id] !== true) return reply.code(409).send({ error: 'Could not pin that folder.' });
      opened = {};
    }
    if (action !== 'agent') await openedFolders.record(folder.path).catch(() => undefined);
    await dashboardUpdates.refresh().catch(() => undefined);
    return reply.code(201).send({ placeId: place.id, ...opened });
  });
  // the recently opened folders that still exist, newest first
  app.get('/api/folders/recent', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async request => { controlled(request); return { folders: await openedFolders.list() }; });
  // forget one recent folder; its Place and anything running there are left alone
  app.post('/api/folders/forget', async (request, reply) => {
    controlled(request, true);
    const { path } = body(request);
    if (typeof path !== 'string') return reply.code(400).send({ error: 'invalid path' });
    await openedFolders.forget(path);
    return reply.code(204).send();
  });
  app.post('/api/agents/:id/tickets', async (request, reply) => { const s = controlled(request, true); const kind = body(request).kind; if (kind !== 'pane') return reply.code(400).send({ error: 'invalid ticket type' }); const target = await discovery.target((request.params as { id: string }).id); if (!target) return reply.code(404).send({ error: 'target unavailable' }); return { ticket: tickets.mint(s.id, 'pane', target.agent.id).id }; });
  // a `pane` ticket for a Place target (a Console shell or another pane at the Place); the
  // Place counterpart of the Agent ticket route, so `/ws/pane/:id` streams either (spec)
  app.post('/api/worktrees/:id/tickets', async (request, reply) => { const s = controlled(request, true); const kind = body(request).kind; if (kind !== 'pane') return reply.code(400).send({ error: 'invalid ticket type' }); const id = (request.params as { id: string }).id; if (await resolvePlace(id) === undefined) return reply.code(404).send({ error: 'place unavailable' }); return { ticket: tickets.mint(s.id, 'pane', id).id }; });
  // renew and check the single-browser control lease on an interval; close the socket the
  // moment the lease is lost. The one periodic tick a pane socket keeps (its live frame and
  // Size claim are event-driven), and the dashboard socket's heartbeat, are the same thing.
  const leaseHeartbeat = (socket: { close: (code: number) => void }, sessionId: string, ms: number) =>
    setInterval(() => { if (!control.active(sessionId)) socket.close(1008); }, ms);
  app.get('/ws/dashboard', { websocket: true }, async (socket, request) => {
    try {
      const s = controlled(request, false);
      const ticket = String(request.headers['sec-websocket-protocol'] ?? '').split(',').map(value => value.trim())[1];
      if (!tickets.consume(ticket, s.id, 'dashboard', 'dashboard')) throw new Error();
      const send = (value: DashboardPayload) => {
        if (!control.active(s.id)) return socket.close(1008);
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ v: 1, type: 'dashboard', dashboard: value }));
      };
      const unsubscribe = dashboardUpdates.subscribe(send);
      const lease = leaseHeartbeat(socket, s.id, 5_000);
      socket.on('close', () => { clearInterval(lease); unsubscribe(); });
      void dashboardUpdates.refresh().catch(() => {});
    } catch { socket.close(1008); }
  });
  // The Pane stream (ADR 0008, spec "The pane socket"): one WebSocket per shown pane
  // delivers the pane's raw bytes as binary frames — the seed first, then live `%output`
  // over the shared control-mode client — and carries input, sizing, flow-control acks and
  // the Agent-pane derive as JSON frames. Keyed by an Agent; `?pane=%N` streams any pane of
  // its tmux session (the Agent's own by default). This is the only pane viewer: the browser's
  // streamed terminal (xterm 6.0) consumes it for the Agent Panel and every Console shell.
  app.get('/ws/pane/:id', { websocket: true }, async (socket, request) => {
    try {
      const s = controlled(request, false);
      const ticket = String(request.headers['sec-websocket-protocol'] ?? '').split(',').map(x => x.trim())[1];
      const id = (request.params as { id: string }).id;
      if (!tickets.consume(ticket, s.id, 'pane', id)) throw new Error();
      // Buffer client frames from the instant the socket is up: ws drops any 'message' that
      // arrives before a listener is attached, and the browser sends its first (and, until a
      // resize, only) `viewport` right on open — while the target/membership resolution below
      // still awaits (a Worktree pane spawns `list-panes`). Losing that one frame means no
      // size, no seed, a blank pane that still takes input. `handleRaw` buffers until setup
      // swaps in the real processor and replays what queued.
      const earlyFrames: unknown[] = [];
      let handleRaw: (raw: unknown) => void = raw => { earlyFrames.push(raw); };
      socket.on('message', (raw: unknown) => handleRaw(raw));
      // Resolve the pane target: an Agent (default pane = the Agent's own, membership = every
      // pane of its tmux session, derive + mutation lock on its own pane) or a Place (an
      // explicit pane required, membership = the Place's pane set — every pane of every
      // session holding a pane at the Place, plus its Console shells — raw bytes, no derive, no
      // lock). Both mint a `pane` ticket bound to their id (spec, The pane socket).
      const requestedPane = (request.query as { pane?: unknown }).pane;
      // A snapshot miss is a Place, or an Agent launched since the last scan: only an id that
      // names no Place pays for the forced scan, so a Terminal never waits on one.
      let agentTarget = await discovery.snapshotTarget(id);
      const place = agentTarget === undefined ? await resolvePlace(id) : undefined;
      if (agentTarget === undefined && place === undefined) agentTarget = await discovery.target(id);
      let socketRef: SocketRef;
      let session: string;
      let pane: string;
      let isAgentPane = false;
      let agent: Agent | undefined;
      if (agentTarget !== undefined) {
        agent = agentTarget.agent;
        socketRef = agentTarget.socket;
        session = agentTmuxSession(agentTarget.agent);
        pane = agentTarget.agent.paneId;
        // the Agent's own pane by default; a requested pane must belong to its session
        if (typeof requestedPane === 'string' && requestedPane !== '') {
          if (!/^%\d+$/u.test(requestedPane) || !(await tmux.sessionPaneIds(socketRef, session)).includes(requestedPane)) throw new Error();
          pane = requestedPane;
        }
        isAgentPane = pane === agentTarget.agent.paneId;
      } else {
        if (typeof requestedPane !== 'string' || !/^%\d+$/u.test(requestedPane)) throw new Error();
        if (place === undefined) throw new Error();
        const member = (await launch.placePanes(place)).find(candidate => candidate.paneId === requestedPane);
        if (member === undefined) throw new Error();
        // A live Agent's own pane is reachable through the Place set (its cwd is at the
        // Place), but it must be streamed only through its Agent target so input takes the
        // mutation lock and a lone Ctrl+C routes through queued-prompt cancellation. Refuse it
        // here (the picker lists it disabled, from the same snapshot), so the Place path only
        // ever drives raw panes.
        if (await discovery.snapshotTarget(`${member.socket.fingerprint}:${member.paneId}`) !== undefined) throw new Error();
        socketRef = member.socket;
        session = member.sessionId;
        pane = requestedPane;
      }
      // the browser may have disconnected during the awaits above (target/membership lookups);
      // bail before spawning/subscribing so a control client and lease are never left dangling
      if (socket.readyState !== socket.OPEN) return;
      const paneClient = paneStream.get(socketRef, session);
      const captureVia = (depth: number) => paneClient.capture(pane, depth);
      const adapter = agent === undefined ? undefined : adapterFor(agent.kind);
      // the Agent's derive (question/metadata) rides the Agent's own pane only, and only for
      // an Adapter with Turns or a question parser (Codex/OMX, not Claude)
      const derives = isAgentPane && (adapter?.turns !== undefined || adapter?.questions?.parse !== undefined);
      // One Size claim per window, keyed by window id resolved over the connection: every
      // caller awaits windowKeyReady first (see the INVARIANT below).
      let windowKey = pane;
      const windowKeyReady = paneClient.windowId(pane).then(w => { if (w !== undefined) windowKey = w; }).catch(() => { /* keep the pane-id fallback */ });
      let paneViewport: ReturnType<typeof paneViewports.acquire> | undefined;
      // INVARIANT: every caller must `await windowKeyReady` before the first call, so the
      // memoised claim is keyed by the window id, not the pane-id fallback.
      const viewportLease = () => paneViewport ??= paneViewports.acquire(
        `${socketRef.fingerprint}:${windowKey}`,
        () => tmux.size(socketRef, pane),
        (nextCols, nextRows) => tmux.resize(socketRef, pane, nextCols, nextRows),
        () => tmux.unpinWindowSize(socketRef, pane)
      );
      // gate every outbound frame on the control lease, like /ws/dashboard's send: a browser
      // that lost control (a take-control handoff) must stop receiving pane bytes at once,
      // not only when the lease heartbeat next fires
      const sendFrame = (value: unknown) => { if (!control.active(s.id)) return socket.close(1008); if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(value)); };
      const sendBinary = (bytes: Buffer) => { if (!control.active(s.id)) return socket.close(1008); if (socket.readyState === socket.OPEN) socket.send(bytes); };
      // report the pane's ACTUAL size, so a smaller attached terminal the coordinator yields
      // to is the grid the browser conforms to (Sizing, ADR 0008)
      const reportSize = async () => { const size = await tmux.size(socketRef, pane); if (size !== undefined) sendFrame({ type: 'size', cols: size.cols, rows: size.rows }); };
      let cols = 120;
      let rows = 36;
      let seedDepth = 2_000;
      let viewportEstablished = false;
      let reclamping = false;
      // Flow control: drop-while-behind + reseed, and the control pipe is never paused (spec).
      const highWatermark = 256 * 1024;
      const lowWatermark = 64 * 1024;
      let unacked = 0;
      let dropped = false;
      // `seeding` covers a seed Capture in flight: %output that arrives then landed before the
      // reply's end, so it is already in the seed and is dropped — the browser applies the seed
      // and then only bytes after it (spec). KNOWN LIMITATION: a post-`%end` %output delivered
      // in the *same* read chunk as the reply is dropped too (its onOutput fires synchronously
      // before the microtask that clears `seeding`); rare because the capture reply spans many
      // chunks, and only corrected by the next reseed (%pause, flow-control recovery, reconnect).
      let seeding = true;
      let seeded = false;
      const forward = (bytes: Buffer) => {
        if (seeding) return;
        if (unacked >= highWatermark) { dropped = true; return; }
        unacked += bytes.length;
        sendBinary(bytes);
      };
      const reseed = async () => {
        // a fresh seed re-establishes the whole screen, so the pre-reseed in-flight count is
        // void: reset it (and clear a lingering drop) so backpressure restarts from the seed
        seeding = true;
        unacked = 0;
        dropped = false;
        const seed = await paneClient.seed(pane, seedDepth);
        if (socket.readyState !== socket.OPEN) { seeding = false; return; }
        sendBinary(seed);
        seeding = false;
      };
      const seedOnce = () => { if (seeded || socket.readyState !== socket.OPEN) return; seeded = true; void reseed(); };
      // the Agent-pane derive: a quiet window after %output takes one deep Capture, feeding the
      // question and Turn parsers; question/metadata go out only on change, at subscribe, and on
      // the on-demand request (Captures and the derive, ADR 0008)
      let lastParseInput: string | undefined;
      let lastQuestion: InlineQuestion | undefined;
      let lastQuestionKey = '';
      let lastMetadataKey = '';
      let deriving = false;
      let deriveQueued = false;
      let forceQueued = false;
      const runDerive = async (force = false) => {
        if (!derives) return;
        if (deriving) { deriveQueued = true; forceQueued ||= force; return; }
        deriving = true;
        try {
          // never derive for a browser that has lost the control lease
          if (!control.active(s.id)) return socket.close(1008);
          const captured = await tmux.captureWindow(socketRef, pane, rows, captureVia);
          if (captured === undefined) return;
          // reveal native follow-up questions from live chrome, not isolated assistant text
          if (adapter?.questions?.queued !== undefined) {
            await prompts.openQueuedQuestion(id, captured.text, () => control.active(s.id) && socket.readyState === socket.OPEN).catch(() => false);
          }
          const parseInput = captured.latestAgentMessage ?? captured.text;
          if (parseInput !== lastParseInput) { lastParseInput = parseInput; lastQuestion = adapter?.questions?.parse?.(parseInput); }
          const question = lastQuestion;
          const metadata = { message: captured.latestAssistantMessage ?? '', overflow: captured.latestAssistantMessageOverflows === true };
          const questionKey = JSON.stringify(question ?? null);
          const metadataKey = JSON.stringify(metadata);
          if (socket.readyState !== socket.OPEN) return;
          if (force || questionKey !== lastQuestionKey) { lastQuestionKey = questionKey; sendFrame({ type: 'question', question: question ?? null }); }
          if (force || metadataKey !== lastMetadataKey) { lastMetadataKey = metadataKey; sendFrame({ type: 'metadata', metadata }); }
        } finally {
          deriving = false;
          if (deriveQueued) { deriveQueued = false; const queued = forceQueued; forceQueued = false; void runDerive(queued); }
        }
      };
      let quietTimer: ReturnType<typeof setTimeout> | undefined;
      const armDerive = () => {
        if (quietTimer !== undefined || socket.readyState !== socket.OPEN) return;
        quietTimer = setTimeout(() => { quietTimer = undefined; void runDerive(); }, logQuietWindowMs);
      };
      // re-clamp on a layout / attached-client change, and check pane liveness: a gone pane
      // ends the stream with "pane closed" (session death arrives as onExit instead). Liveness
      // is a `#{window_id}` read over the CONTROL connection, not a spawned `tmux.size`: a gone
      // pane yields no window id, while a transient spawn hiccup in the sizing read must not be
      // misread as death and tear down a live stream.
      const reclamp = async () => {
        if (reclamping) return;
        reclamping = true;
        try {
          await windowKeyReady;
          if (!control.active(s.id)) return socket.close(1008);
          if (await paneClient.windowId(pane) === undefined) { sendFrame({ type: 'exit', reason: 'pane closed' }); return socket.close(1000); }
          if (!viewportEstablished) return;
          const ensured = await viewportLease().ensure(cols, rows);
          if (!ensured.ok) return socket.close(1011);
          // report the pane's actual size only when it moved (a layout change may leave it put)
          if (ensured.resized) { const after = await tmux.size(socketRef, pane); if (after !== undefined) sendFrame({ type: 'size', cols: after.cols, rows: after.rows }); }
        } finally {
          reclamping = false;
        }
      };
      // Seed only after this task has reported the size, so the browser always gets its
      // `size` before the seed bytes (the client buffers only a small pre-size window and
      // silently drops a large seed that arrives first — a blank pane). Chaining the seed on
      // schedule()'s promise is wrong: a superseded viewport's promise fulfils via the
      // early-return path without ever reporting a size, firing the seed ahead of the winning
      // viewport's size when a mount-time viewport burst coalesces into one read.
      const viewport = new LatestViewportScheduler(
        async (nextCols, nextRows) => { await windowKeyReady; const resized = await viewportLease().resize(nextCols, nextRows); await reportSize(); if (resized) seedOnce(); return resized; },
        () => {}
      );
      const unsubscribePane = paneClient.subscribe(pane, {
        ...(derives ? { onActivity: armDerive } : {}),
        onOutput: forward,
        onReseed: () => { sendFrame({ type: 'reseed' }); void reseed(); },
        onResize: () => { void reclamp(); },
        onClipboard: (text: string) => sendFrame({ type: 'clipboard', text }),
        // the session ended or the control client was lost; forward the reason and let the browser reconnect
        onExit: (reason: string) => { sendFrame({ type: 'exit', reason }); socket.close(1011); }
      });
      // route input to the pane byte-exact; the Agent's own pane takes the mutation lock and
      // routes a lone Ctrl+C through queued-prompt cancellation
      // a refused keystroke ends the stream unless a pane mode (a picker) refused it: the
      // stream is fine then, and reconnecting would only loop until the mode is left
      const refused = async () => { if (await tmux.heldPaneMode(socketRef, pane).catch(() => undefined) === undefined) socket.close(1011); };
      const handleInput = async (bytes: Buffer): Promise<void> => {
        if (!isAgentPane) { if (!await paneClient.sendInput(pane, bytes)) await refused(); return; }
        const release = prompts.beginAgentMutation(id);
        // a restart reservation holds the lock; refuse with a policy close (1008), not 1011
        if (release === undefined) { socket.close(1008); return; }
        const isInterrupt = bytes.length === 1 && bytes[0] === 0x03;
        try {
          const ok = isInterrupt
            ? await prompts.cancel(id).then(outcome => outcome === 'not-working' ? paneClient.sendInput(pane, bytes) : outcome === 'ok')
            : await paneClient.sendInput(pane, bytes);
          if (!ok) await refused();
        } finally {
          release();
        }
      };
      const lease = leaseHeartbeat(socket, s.id, config.pollIntervalMs);
      const processFrame = (raw: unknown) => {
        try {
          const frame = JSON.parse(String(raw));
          if (typeof frame?.type !== 'string') throw new Error();
          if (frame.type === 'viewport') {
            const bounded = boundedViewport(frame);
            if (bounded === undefined) throw new Error();
            if (Number.isInteger(frame.scrollback) && frame.scrollback >= 1 && frame.scrollback <= 5_000) seedDepth = frame.scrollback;
            ({ cols, rows } = bounded);
            viewportEstablished = true;
            void viewport.schedule({ cols, rows, history: 0, onFailure: () => socket.close(1011) });
            return;
          }
          if (frame.type === 'input') {
            if (!control.active(s.id)) throw new Error();
            if (typeof frame.data !== 'string' || !/^[A-Za-z0-9_-]*$/.test(frame.data)) throw new Error();
            const bytes = Buffer.from(frame.data, 'base64url');
            if (!bytes.length || bytes.length > 65_536 || bytes.toString('base64url') !== frame.data) throw new Error();
            void handleInput(bytes).catch(() => socket.close(1011));
            return;
          }
          if (frame.type === 'ack') {
            if (!Number.isInteger(frame.bytes) || frame.bytes < 0) throw new Error();
            unacked = Math.max(0, unacked - frame.bytes);
            // recovered from a drop: clear the browser and reseed to the correct screen
            if (dropped && unacked < lowWatermark) { dropped = false; sendFrame({ type: 'reseed' }); void reseed(); }
            return;
          }
          if (frame.type === 'metadata') {
            if (derives) void runDerive(true);
            return;
          }
          throw new Error();
        } catch { socket.close(1008); }
      };
      // Setup is done: process anything that queued during it (in arrival order), then send
      // every later frame straight through. No `await` runs between here and the swap, so no
      // frame can slip past unbuffered.
      for (const raw of earlyFrames.splice(0)) processFrame(raw);
      handleRaw = processFrame;
      socket.on('close', () => { clearInterval(lease); if (quietTimer !== undefined) clearTimeout(quietTimer); unsubscribePane(); if (paneViewport !== undefined) void paneViewport.release(); });
      // carry the derive once at subscribe, before any %output
      if (derives) void runDerive(true);
    } catch { socket.close(1008); }
  });
  // close owned Files transport and existing background services on shutdown
  // close both viewer-owned streams and server-owned dashboard connections
  app.addHook('onClose', async () => { buttonActions.close(); scheduler.stop(); reviewJobs.close(); codeReviews.close(); asks.close(); await hostFiles.close(); await accounts.close(); await paneViewports.restoreAll(); paneStream.closeAll(); tmux.closeCommands?.(); dashboardUpdates.close(); });
  // expose the scheduler on the instance (index.ts starts it; the HTTP-seam tests tick it)
  app.decorate('scheduler', scheduler);
  return app;
}
