import { launchTransport, structuredAdapterFor } from '../../adapters/registry.js';
import type { ValidatedConfig } from '../../config/schema.js';
import type { Place } from '../../places/places.js';
import type { StructuredAgents } from '../../transports/structured-agents.js';
import type { IntegrationPrincipal } from '../auth/index.js';
import type { AddInput, CreatedWorktree } from '../../worktrees/management.js';
import { integrationToolByName } from './catalog.js';
import { legacyOutput } from './legacy-output.js';
import { developerFailure, developerSuccess, developerTool, type DeveloperResult, type DeveloperTool } from './developer-tool.js';

export type DeveloperWorkerDependencies = {
  config: ValidatedConfig;
  structured: Pick<StructuredAgents, 'launch' | 'agent' | 'workerOwner' | 'ownedWorkers'>;
  resolvePlace: (id: string, principal: IntegrationPrincipal) => Promise<Place | undefined>;
  close: (id: string) => Promise<boolean>;
  createWorktree: (projectId: string, input: AddInput, open: 'empty', issue?: number) => Promise<CreatedWorktree>;
};

// retain the existing tool payload and v1 envelope while adding only the Davo audience
function davoLegacy(name: string, execute: DeveloperTool['execute']): DeveloperTool {
  const legacy = integrationToolByName.get(name)!;
  const output = legacyOutput(name);
  return developerTool({ ...legacy, audiences: ['realtime'], contractVersion: 'v1', output: output.output, dataSchema: { ...output.dataSchema, $defs: output.definitions }, openWorld: legacy.annotations.openWorldHint, execute });
}

// manage first-class stable-owner workers without pretending Davo is a Conductor Agent
export function createWorkerTools(deps: DeveloperWorkerDependencies): DeveloperTool[] {
  let spawning = Promise.resolve<unknown>(undefined);
  return [
    davoLegacy('spawn_agent', async (input, principal) => {
      const operation = spawning.then(async (): Promise<DeveloperResult> => {
        const place = await deps.resolvePlace(input.worktree_id as string, principal);
        const owner = principal.stableOwnerKey;
        // the owner comes only from the current authenticated Davo principal
        if (place === undefined || owner === undefined || principal.leaseKey === undefined) return developerFailure('not_found', 'Worker Place not found.');
        const enabled = deps.config.conductor?.spawnKinds ?? ['pi'];
        const kind = input.kind as 'pi' | 'claude' | 'codex' | undefined ?? (enabled.includes('pi') ? 'pi' : enabled[0]);
        // explicit kind requests never fall back to another runtime
        if (kind === undefined || !enabled.includes(kind)) return developerFailure('capability_not_supported', 'The requested worker kind is not configured.');
        const allowed = deps.config.adapters[kind]?.allowedModels;
        const model = typeof input.model === 'string' ? input.model : undefined;
        // explicit choices require the same configured allowlist as existing workers
        if (model !== undefined && !(allowed ?? []).some(entry => entry.model === model)) return developerFailure('invalid_request', 'The worker model is not allowed.');
        // an explicitly empty policy never inherits a native model default
        if (allowed?.length === 0) return developerFailure('capability_not_supported', 'The worker has no configured Allowed model.');
        const workers = await deps.structured.ownedWorkers(owner);
        // retain the configured live/starting worker budget per stable owner
        if (workers.filter(agent => agent.structured?.lifecycle === 'live' || agent.structured?.lifecycle === 'starting').length >= (deps.config.conductor?.maxWorkers ?? 4)) return developerFailure('capacity', 'The worker limit has been reached.', true);
        // workers are structured Agents: a kind its config launches in a pane is not offered here
        if (launchTransport(kind, deps.config.adapters) !== 'structured') return developerFailure('capability_not_supported', 'The requested worker kind does not launch over the structured Transport here.');
        const id = await deps.structured.launch(place, kind, { sandboxed: structuredAdapterFor(kind)?.sandbox === true, workerOwner: { kind: 'davo', id: owner }, ...(model === undefined ? {} : { model: { model } }) });
        return id === undefined ? developerFailure('operation_failed', 'The worker could not start.', true) : developerSuccess({ agent_id: id });
      });
      spawning = operation.then(() => undefined, () => undefined);
      return await operation;
    }),
    davoLegacy('close_agent', async (input, principal) => {
      const owner = principal.stableOwnerKey;
      // another owner's worker and an arbitrary operator Agent are equally unavailable
      if (owner === undefined || await deps.structured.workerOwner(input.agent_id as string) !== owner) return developerFailure('not_found', 'Worker not found.');
      return await deps.close(input.agent_id as string) ? developerSuccess({ closed: true }) : developerFailure('operation_failed', 'The worker could not close.', true);
    }),
    davoLegacy('create_worktree', async (input, principal) => {
      const place = await deps.resolvePlace(input.worktree_id as string, principal);
      // Worktree creation is restricted to a current configured repository Project
      if (place?.kind !== 'worktree' || !deps.config.projects.some(project => project.id === place.projectId && project.mode === 'repository')) return developerFailure('not_found', 'Repository Place not found.');
      const mode = input.mode as 'new' | 'existing' | 'pull-request';
      // mode-dependent keys are validated before calling the existing Add flow
      if (mode === 'pull-request' ? !Number.isInteger(input.number) || input.branch !== undefined || input.base !== undefined || input.issue !== undefined : (mode !== 'new' && mode !== 'existing') || typeof input.branch !== 'string' || input.number !== undefined || mode === 'existing' && input.base !== undefined) return developerFailure('invalid_request', 'Invalid Worktree creation mode.');
      const add: AddInput = mode === 'pull-request' ? { mode, number: input.number as number } : { mode, branch: input.branch as string, ...(input.base === undefined ? {} : { base: input.base as string }) };
      const result = await deps.createWorktree(place.projectId, add, 'empty', input.issue as number | undefined);
      // refuse failed Add results without fabricating a Worktree identity
      if (!result.ok) return developerFailure('operation_failed', result.error, result.status >= 500);
      return developerSuccess({ worktree_id: result.worktreeId, ...(result.setupError === undefined ? {} : { setup_error: result.setupError }), ...(result.fetchError === undefined ? {} : { fetch_error: result.fetchError }), ...(result.launchError === undefined ? {} : { launch_error: result.launchError }) });
    })
  ];
}
