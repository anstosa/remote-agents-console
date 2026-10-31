import { createHmac, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { buttonSlotNames, type ButtonSlot, type ConfiguredButton } from '../config/buttons.js';
import { isReviewRun, type Agent } from '../domain/models.js';
import { placeHostRoot, type Place } from '../places/places.js';
import type { PromptService } from '../prompts/service.js';
import { validPrompt } from '../prompts/validation.js';
import { ConfiguredButtonCatalog } from './catalog.js';
import { guardedDirectoryCommand, type DirectoryExecutionLease, type HostCommandInput, type ShellActionResult } from './host-command-runner.js';

// share the server-owned action locator without accepting executable browser input
const buttonActionLocatorShape = {
  actionId: z.string().min(1).max(128),
  configRevision: z.string().min(1).max(128),
  placeId: z.string().min(1).max(4096).refine(value => !value.includes('\0'), 'NUL is forbidden'),
  slot: z.enum(buttonSlotNames),
  agentId: z.string().min(1).max(4096).optional(),
  filesDirectoryToken: z.string().min(1).max(16_384).optional(),
  // text a prompt button sends after its own prompt (the GitHub panel's picked Review threads)
  append: z.string().min(1).max(32_000).refine(value => !value.includes('\0'), 'NUL is forbidden').optional()
};
export const buttonActionInputSchema = z.object({
  requestId: z.string().regex(/^[A-Za-z0-9_-]{12,128}$/u),
  ...buttonActionLocatorShape
}).strict();
export const buttonActionDraftInputSchema = z.object(buttonActionLocatorShape).strict();
export type ButtonActionInput = z.infer<typeof buttonActionInputSchema>;
export type ButtonActionDraftInput = z.infer<typeof buttonActionDraftInputSchema>;
export type ButtonActionDraft = { kind: 'prompt'; text: string; placeId: string; agentId: string } | { kind: 'shell'; text: string; placeId: string };
export type ButtonOperation = { id: string; state: 'queued' | 'launching' | 'running' | 'complete' | 'failed' | 'interrupted'; phase?: string; error?: string; exitCode?: number; agentId?: string };
type StoredOperation = { operation: ButtonOperation; sessionId: string; guard: string; touchedAt: number; append?: string; promptRequestId?: string; agentKind?: Agent['kind'] };
type StartRecord = { fingerprint: string; promise: Promise<ButtonOperation>; operationId?: string; createdAt: number };
type ButtonActionDependencies = {
  resolvePlace(id: string): Promise<Place | undefined>;
  agents(): Promise<Agent[]>;
  launchAgent(place: Place): Promise<Agent | undefined>;
  prompts: Pick<PromptService, 'submitTracked' | 'requestStatus'>;
  observePrompt(agentId: string): Promise<void>;
  warn?(message: string): void;
  directoryLease(place: Place, sessionId: string, token: string): Promise<DirectoryExecutionLease>;
  shell: { execute(input: HostCommandInput): Promise<ShellActionResult>; close?(): void };
  now?: () => number;
};

// surface only bounded public failure codes
export class ButtonActionError extends Error {
  // carry the route status without leaking executable definitions
  constructor(readonly code: string, readonly statusCode = 409) { super(code); }
}

// distinguish active work from retained terminal summaries
const busy = (operation: ButtonOperation): boolean => ['queued', 'launching', 'running'].includes(operation.state);
// a prompt button's prompt, then any text the browser asked to follow it
function promptOf(definition: ConfiguredButton, append: string | undefined): string | undefined {
  if (!('agentPrompt' in definition.action)) {
    if (append !== undefined) throw new ButtonActionError('unexpected_prompt_text', 400);
    return undefined;
  }
  const prompt = append === undefined ? definition.action.agentPrompt : `${definition.action.agentPrompt}\n\n${append}`;
  if (!validPrompt(prompt)) throw new ButtonActionError('prompt_too_long', 400);
  return prompt;
}

// bind an Agent to its exact Place without selecting Review workers
const belongs = (agent: Agent, place: Place): boolean => !isReviewRun(agent) && (agent.placeId === place.id || agent.worktreeId === place.id);

// resolve trusted actions and project engine-owned outcomes onto one browser contract
export class ButtonActionService {
  private readonly operations = new Map<string, StoredOperation>();
  private readonly starts = new Map<string, StartRecord>();
  private readonly active = new Map<string, string>();
  private readonly launches = new Map<string, Promise<Agent | undefined>>();
  private readonly signingKey = randomBytes(32);
  private readonly now: () => number;
  private readonly warn: (message: string) => void;
  // suppress repeated diagnostics until this Agent's observation succeeds
  private readonly observerOutages = new Set<string>();
  private closed = false;

  // use injected engines so action state never becomes a second completion heuristic
  constructor(readonly catalog: ConfiguredButtonCatalog, private readonly deps: ButtonActionDependencies) {
    this.now = deps.now ?? Date.now;
    this.warn = deps.warn ?? console.warn;
  }

  // reserve a retry identity before any asynchronous validation or side effect
  async start(sessionId: string, input: ButtonActionInput): Promise<ButtonOperation> {
    this.prune();
    // reject stale boot/catalog identities before retry registration
    if (input.configRevision !== this.catalog.value.revision) throw new ButtonActionError('stale_button_configuration');
    // shutdown never launches new work
    if (this.closed) throw new ButtonActionError('server_stopped', 503);
    const key = `${sessionId}\0${input.requestId}`;
    const fingerprint = createHmac('sha256', this.signingKey).update(JSON.stringify(input)).digest('hex');
    const prior = this.starts.get(key);
    // identical same-boot retries recover the exact operation
    if (prior !== undefined) {
      // reuse of a request identity cannot retarget its action or context
      if (prior.fingerprint !== fingerprint) throw new ButtonActionError('request_id_conflict');
      const result = await prior.promise;
      return this.retainedStatus(sessionId, result.id);
    }
    // bound retained requests without evicting active work
    if (this.starts.size >= 1024) throw new ButtonActionError('button_action_limit', 429);
    const entry: StartRecord = { fingerprint, promise: Promise.resolve(undefined as never), createdAt: this.now() };
    entry.promise = this.prepare(sessionId, input).then(operation => { entry.operationId = operation.id; return operation; });
    this.starts.set(key, entry);
    try { return { ...await entry.promise }; }
    catch (error) {
      // failed preflight has no operation to recover
      if (this.starts.get(key) === entry) this.starts.delete(key);
      throw error;
    }
  }

  // resolve trusted action text for editing without starting the action itself
  async draft(sessionId: string, input: ButtonActionDraftInput): Promise<ButtonActionDraft> {
    // reject stale boot/catalog identities before resolving any trusted content
    if (input.configRevision !== this.catalog.value.revision) throw new ButtonActionError('stale_button_configuration');
    // shutdown never exposes a draft for work it cannot later coordinate
    if (this.closed) throw new ButtonActionError('server_stopped', 503);
    const place = await this.deps.resolvePlace(input.placeId);
    // only server-discovered Workspaces can resolve an action draft
    if (place === undefined) throw new ButtonActionError('place_unavailable', 404);
    const definition = this.catalog.resolve(place.projectId, input.slot, input.actionId, input.configRevision);
    // a locator must belong to this exact effective list
    if (definition === undefined) throw new ButtonActionError('button_unavailable', 404);
    const shell = 'shellCommand' in definition.action;
    const prompt = promptOf(definition, input.append);
    // Files authority applies only to Files shell buttons
    if (input.filesDirectoryToken !== undefined && (!shell || input.slot !== 'split:files')) throw new ButtonActionError('unexpected_files_context', 400);
    // a Files shell requires fresh directory authority even though the command is not executed
    if (shell && input.slot === 'split:files' && input.filesDirectoryToken === undefined) throw new ButtonActionError('files_context_required', 400);
    // preserve Files identity in the editable command without retaining lease authority
    if ('shellCommand' in definition.action) {
      const lease = input.slot === 'split:files' ? await this.deps.directoryLease(place, sessionId, input.filesDirectoryToken!) : undefined;
      // changed or expired Files authority cannot produce a trusted draft
      if (lease !== undefined && (!lease.current() || lease.expiresAt < this.now())) throw new ButtonActionError('files_context_changed');
      // asynchronous resolution cannot expose action text after shutdown
      if (this.closed) throw new ButtonActionError('server_stopped', 503);
      return { kind: 'shell', text: lease === undefined ? definition.action.shellCommand : guardedDirectoryCommand(definition.action.shellCommand, lease), placeId: place.id };
    }
    const agents = await this.deps.agents();
    let selected = input.agentId === undefined ? agents.find(agent => belongs(agent, place)) : agents.find(agent => agent.id === input.agentId && belongs(agent, place));
    // never redirect a selected Agent that disappeared or belongs elsewhere
    if (input.agentId !== undefined && selected === undefined) throw new ButtonActionError('agent_unavailable', 404);
    // launch only when no eligible existing Agent was selected
    if (selected === undefined) {
      try { selected = await this.launchForPlace(place); }
      catch { throw new ButtonActionError('agent_launch_failed'); }
    }
    // an in-flight launch cannot produce an editable target after shutdown
    if (this.closed) throw new ButtonActionError('server_stopped', 503);
    // unavailable normal launch choices fail without installing or choosing another profile
    if (selected === undefined) throw new ButtonActionError('agent_launch_failed');
    // a launch result cannot redirect a Workspace action into a different Place
    if (!belongs(selected, place)) throw new ButtonActionError('agent_launch_mismatch');
    // support only registered interactive prompt behaviors
    if (selected.kind !== 'codex' && selected.kind !== 'omx' && selected.kind !== 'claude') throw new ButtonActionError('agent_kind_unavailable');
    return { kind: 'prompt', text: prompt!, placeId: place.id, agentId: selected.id };
  }

  // read only this browser session's exact operation and delegate prompt observations
  async status(sessionId: string, id: string): Promise<ButtonOperation> {
    this.prune();
    const stored = this.operations.get(id);
    // do not disclose another controller's operation identity
    if (stored === undefined || stored.sessionId !== sessionId) throw new ButtonActionError('button_action_unavailable', 404);
    // completed shell or prompt results remain stable
    if (!busy(stored.operation) || stored.promptRequestId === undefined) return { ...stored.operation };
    const observerKey = stored.operation.agentId ?? stored.operation.id;
    try {
      // the prompt engine owns exact receipt and completion correlation
      if (stored.operation.agentId !== undefined) await this.deps.observePrompt(stored.operation.agentId);
    } catch {
      // log only the first failure until this Agent's observation succeeds
      if (!this.observerOutages.has(observerKey)) this.warn('[button-actions] prompt observation unavailable; retaining accepted action');
      this.observerOutages.add(observerKey);
      stored.operation.phase = 'reconnecting';
      throw new ButtonActionError('button_action_status_unavailable', 503);
    }
    this.observerOutages.delete(observerKey);
    // successful observation ends this operation's reconnect phase
    if (stored.operation.phase === 'reconnecting') delete stored.operation.phase;
    const request = this.deps.prompts.requestStatus(stored.promptRequestId);
    // an unresolvable tracked request is uncertainty rather than completion
    if (request === undefined) this.finish(stored, { state: 'interrupted', error: 'prompt_status_unavailable' });
    // Claude deliberately finishes button loading at actual submission
    else if (stored.agentKind === 'claude' && request.submitted) this.finish(stored, { state: 'complete', phase: 'submitted' });
    // Codex and OMX use their exact requested-turn terminal event
    else if (request.state === 'complete' || request.state === 'failed' || request.state === 'interrupted') this.finish(stored, { state: request.state, ...(request.error === undefined ? {} : { error: request.error }) });
    else stored.operation.state = request.state === 'queued' ? 'queued' : 'running';
    return { ...stored.operation };
  }

  // retain accepted work only for the bounded observer outage
  private async retainedStatus(sessionId: string, id: string): Promise<ButtonOperation> {
    try { return await this.status(sessionId, id); }
    catch (error) {
      // unrelated status failures keep their normal caller-visible behavior
      if (!(error instanceof ButtonActionError && error.code === 'button_action_status_unavailable' && error.statusCode === 503)) throw error;
      const stored = this.operations.get(id);
      // the bounded error is created only after exact owner lookup
      if (stored === undefined || stored.sessionId !== sessionId) throw error;
      return { ...stored.operation };
    }
  }

  // stop observers without replaying uncertain accepted requests
  close(): void {
    this.closed = true;
    this.deps.shell.close?.();
    // terminal summaries are explicit on graceful shutdown
    for (const stored of this.operations.values()) {
      // leave existing completed results intact
      if (busy(stored.operation)) this.finish(stored, { state: 'interrupted', error: 'server_stopped' });
    }
  }

  // validate immutable context before creating a process or sending a prompt
  private async prepare(sessionId: string, input: ButtonActionInput): Promise<ButtonOperation> {
    const place = await this.deps.resolvePlace(input.placeId);
    // only server-discovered Workspaces can execute an action
    if (place === undefined) throw new ButtonActionError('place_unavailable', 404);
    const definition = this.catalog.resolve(place.projectId, input.slot, input.actionId, input.configRevision);
    // a locator must belong to this exact effective list
    if (definition === undefined) throw new ButtonActionError('button_unavailable', 404);
    const shell = 'shellCommand' in definition.action;
    const prompt = promptOf(definition, input.append);
    // Files authority applies only to Files shell buttons
    if (input.filesDirectoryToken !== undefined && (!shell || input.slot !== 'split:files')) throw new ButtonActionError('unexpected_files_context', 400);
    // a Files shell never falls back to the Workspace directory
    if (shell && input.slot === 'split:files' && input.filesDirectoryToken === undefined) throw new ButtonActionError('files_context_required', 400);
    const lease = shell && input.slot === 'split:files' ? await this.deps.directoryLease(place, sessionId, input.filesDirectoryToken!) : undefined;
    const agents = shell ? [] : await this.deps.agents();
    const selected = input.agentId === undefined ? agents.find(agent => belongs(agent, place)) : agents.find(agent => agent.id === input.agentId && belongs(agent, place));
    // never redirect a selected Agent that disappeared or belongs elsewhere
    if (!shell && input.agentId !== undefined && selected === undefined) throw new ButtonActionError('agent_unavailable', 404);
    const guard = `${input.configRevision}\0${input.actionId}\0${place.id}\0${input.slot}`;
    let existing = this.active.get(guard);
    // stale projections must not strand a later controller behind already finished work
    if (existing !== undefined) {
      const previous = this.operations.get(existing);
      // refresh using the owner internally without disclosing its operation
      if (previous !== undefined) await this.retainedStatus(previous.sessionId, existing);
      existing = this.active.get(guard);
    }
    // repeat clicks recover owned work while other controllers get a non-disclosing refusal
    if (existing !== undefined) {
      const previous = this.operations.get(existing);
      // a controller change cannot duplicate or inspect the other browser's active action
      if (previous?.sessionId !== sessionId) throw new ButtonActionError('action_in_progress');
      // a repeat click joins the running prompt only when it would send the same text
      if (previous.append !== input.append) throw new ButtonActionError('action_in_progress');
      return this.retainedStatus(sessionId, existing);
    }
    // bound active and retained records without throwing work away
    if (this.operations.size >= 512 || this.active.size >= 128) throw new ButtonActionError('button_action_limit', 429);
    const operation: ButtonOperation = { id: randomBytes(24).toString('base64url'), state: 'queued' };
    const stored: StoredOperation = { operation, sessionId, guard, touchedAt: this.now(), ...(input.append === undefined ? {} : { append: input.append }) };
    this.operations.set(operation.id, stored);
    this.active.set(guard, operation.id);
    // execute only the captured definition and context after registration
    void this.execute(stored, definition, prompt, place, selected, lease).catch(() => this.finish(stored, { state: 'failed', error: 'button_action_failed' }));
    return { ...operation };
  }

  // delegate each action to its authoritative execution engine
  private async execute(stored: StoredOperation, definition: ConfiguredButton, prompt: string | undefined, place: Place, selected: Agent | undefined, lease: DirectoryExecutionLease | undefined): Promise<void> {
    // asynchronous preparation must not start work after shutdown
    if (this.closed) { this.finish(stored, { state: 'interrupted', error: 'server_stopped' }); return; }
    // shell input never comes from the browser
    if ('shellCommand' in definition.action) {
      stored.operation.state = 'running';
      const result = await this.deps.shell.execute({ command: definition.action.shellCommand, cwd: lease?.canonicalHostPath ?? placeHostRoot(place), ...(lease === undefined ? {} : { lease }) });
      this.finish(stored, result);
      return;
    }
    let agent = selected;
    // launch-first uses a single shared promise per Place
    if (agent === undefined) {
      stored.operation.state = 'launching';
      agent = await this.launchForPlace(place);
    }
    // an in-flight launch cannot submit new work after shutdown
    if (this.closed || !busy(stored.operation)) return;
    // unavailable normal launch choices fail without installing or choosing another profile
    if (agent === undefined) { this.finish(stored, { state: 'failed', error: 'agent_launch_failed' }); return; }
    // a launch result cannot redirect a Workspace action into a different Place
    if (!belongs(agent, place)) { this.finish(stored, { state: 'failed', error: 'agent_launch_mismatch' }); return; }
    // support only registered interactive prompt behaviors
    if (agent.kind !== 'codex' && agent.kind !== 'omx' && agent.kind !== 'claude') { this.finish(stored, { state: 'failed', error: 'agent_kind_unavailable' }); return; }
    stored.operation.agentId = agent.id;
    stored.agentKind = agent.kind;
    const submitted = await this.deps.prompts.submitTracked(agent.id, prompt!);
    // a late submission result cannot revive a shutdown operation
    if (this.closed || !busy(stored.operation)) return;
    // queue persistence or target failure never reports success
    if (submitted === undefined) { this.finish(stored, { state: 'failed', error: 'prompt_submission_failed' }); return; }
    stored.promptRequestId = submitted.requestId;
    stored.operation.state = 'queued';
    await this.retainedStatus(stored.sessionId, stored.operation.id);
  }

  // recheck for a newly available Agent before normal Workspace launch
  private async launchAtPlace(place: Place): Promise<Agent | undefined> {
    const existing = (await this.deps.agents()).find(agent => belongs(agent, place));
    // discovery may have outlived the server's launch authority
    if (this.closed) return undefined;
    return existing ?? await this.deps.launchAgent(place);
  }

  // share one normal Agent launch between execution and draft preparation
  private async launchForPlace(place: Place): Promise<Agent | undefined> {
    let launch = this.launches.get(place.id);
    // a second request joins the same launch rather than creating another Agent
    if (launch === undefined) {
      launch = this.launchAtPlace(place);
      this.launches.set(place.id, launch);
      // clear only this exact completed launch reservation
      void launch.finally(() => { if (this.launches.get(place.id) === launch) this.launches.delete(place.id); }).catch(() => undefined);
    }
    return await launch;
  }

  // record an engine-owned terminal result and release the global in-flight guard
  private finish(stored: StoredOperation, result: Partial<ButtonOperation> & Pick<ButtonOperation, 'state'>): void {
    // shutdown or another terminal path cannot be overwritten by late observations
    if (!busy(stored.operation)) return;
    Object.assign(stored.operation, result);
    stored.touchedAt = this.now();
    this.active.delete(stored.guard);
  }

  // evict only old terminal summaries and their retry records
  private prune(): void {
    const before = this.now() - 10 * 60_000;
    // active operations have no TTL
    for (const [id, stored] of this.operations) {
      // terminal results remain available for ten minutes
      if (!busy(stored.operation) && stored.touchedAt < before) this.operations.delete(id);
    }
    // retain every retry mapping whose operation still exists
    for (const [key, entry] of this.starts) {
      // no pending preflight is evicted
      if (entry.operationId !== undefined && !this.operations.has(entry.operationId)) this.starts.delete(key);
    }
  }
}
