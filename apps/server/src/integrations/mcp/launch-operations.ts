import { randomBytes } from 'node:crypto';
import type { Agent } from '../../domain/models.js';
import type { LaunchOptionsContext, LaunchOptionsService } from '../../launch/options.js';
import type { AgentKind, LaunchKindManifest, LaunchSelectionTarget, PreparedLaunchChoice } from '../../launch/options-types.js';
import type { IntegrationPrincipal } from '../auth/index.js';
import { developerFailure, developerSuccess } from './developer-tool.js';
import type { AgentToolPorts } from './agent-tools.js';

export type DeveloperManualLaunch = { target: LaunchSelectionTarget; choice: PreparedLaunchChoice; context: LaunchOptionsContext };
export type DeveloperLaunchDependencies = {
  options: Pick<LaunchOptionsService, 'list'>;
  resolve: (input: Record<string, unknown>, principal: IntegrationPrincipal) => Promise<{ target: LaunchSelectionTarget; context: LaunchOptionsContext }>;
  prepare: (target: LaunchSelectionTarget, raw: Record<string, unknown>) => Promise<DeveloperManualLaunch>;
  launch: (prepared: DeveloperManualLaunch) => Promise<Agent | undefined>;
  conductorKinds: readonly string[];
  now?: () => number;
};
type Option = { owner: string; leaseKey?: string; input: Record<string, unknown>; target: LaunchSelectionTarget; context: LaunchOptionsContext; expiresAt: number; kinds: LaunchKindManifest[] };

// project the existing launch manifests without leaking host paths or provider configuration
function projectKind(value: LaunchKindManifest): Record<string, unknown> {
  const policy = value.modelPolicy;
  return { kind: value.kind, options_revision: value.optionsRevision, model_policy: { state: policy.state, allowed: policy.allowed, default_selection: policy.defaultSelection, ...(policy.currentModel === undefined ? {} : { current_model: policy.currentModel }), ...(policy.currentEffort === undefined ? {} : { current_effort: policy.currentEffort }), catalog: policy.catalog.map(({ defaultEffort, ...model }) => ({ ...model, ...(defaultEffort === undefined ? {} : { default_effort: defaultEffort }) })), catalog_status: policy.catalogStatus, ...(policy.message === undefined ? {} : { message: policy.message }) }, security: value.security };
}

// retain short-lived owner-bound options and revalidate policy before every launch
export function createLaunchOperations(deps: DeveloperLaunchDependencies): AgentToolPorts {
  const options = new Map<string, Option>();
  const now = deps.now ?? Date.now;
  // stable owners isolate options while Davo consumption remains exact-lease-bound
  const owner = (principal: IntegrationPrincipal): string => `${principal.authentication}:${principal.stableOwnerKey ?? principal.subjectId}`;
  // expire before admission without evicting live options
  const prune = (): void => {
    // retain every unexpired option until consumed or expired
    for (const [id, option] of options) if (option.expiresAt <= now()) options.delete(id);
  };
  return {
    // options are observations, never authority to launch for the Conductor
    get_launch_options: async (input, principal) => {
      prune();
      // bounded options refuse saturation rather than dropping another owner's capability
      if (options.size >= 64) return developerFailure('capacity', 'Launch option capacity is full.', true);
      try {
        const resolved = await deps.resolve(input, principal);
        const response = await deps.options.list(resolved.context);
        const kinds = response.kinds.filter(kind => principal.authentication !== 'conductor' || deps.conductorKinds.includes(kind.kind));
        const id = randomBytes(18).toString('base64url');
        const expiresAt = now() + 120_000;
        const leaseKey = principal.authentication === 'realtime' ? principal.leaseKey : undefined;
        const result = { option_id: id, expires_at: new Date(expiresAt).toISOString(), ordinary_launch: leaseKey !== undefined, kinds: kinds.map(projectKind) };
        // fail closed when native catalogs exceed the bounded wire contract
        if (Buffer.byteLength(JSON.stringify(result)) > 48_000) return developerFailure('too_large', 'Launch options exceed the response limit.');
        options.set(id, { owner: owner(principal), ...(leaseKey === undefined ? {} : { leaseKey }), input: { ...input }, target: { ...resolved.target }, context: { ...resolved.context }, expiresAt, kinds });
        return developerSuccess(result);
      } catch { return developerFailure('target_changed', 'Launch options are unavailable.', true); }
    },
    // only the authenticated operator can consume an ordinary launch option
    launch_agent: async (input, principal) => {
      prune();
      const option = options.get(input.option_id as string);
      // do not disclose another owner's option or let the Conductor launch ordinarily
      if (principal.authentication !== 'realtime' || principal.leaseKey === undefined || option === undefined || option.owner !== owner(principal) || option.leaseKey !== principal.leaseKey) return developerFailure('not_found', 'Launch option not found.');
      const kind = option.kinds.find(item => item.kind === input.kind);
      // kind changes require a fresh server-observed option
      if (kind === undefined) return developerFailure('target_changed', 'Launch kind is unavailable.');
      let dispatched = false;
      try {
        const resolved = await deps.resolve(option.input, principal);
        // an unchanged revision never authorizes a different resolved target or host namespace
        if (JSON.stringify(resolved.target) !== JSON.stringify(option.target) || resolved.context.cwd !== option.context.cwd || resolved.context.hostCwd !== option.context.hostCwd || resolved.context.home !== option.context.home) return developerFailure('target_changed', 'Launch target changed; request fresh options.', true);
        const latest = (await deps.options.list(resolved.context)).kinds.find(item => item.kind === kind.kind);
        // revision binds model, effort, native security and the current configuration
        if (latest?.optionsRevision !== kind.optionsRevision) return developerFailure('target_changed', 'Launch options changed; request fresh options.', true);
        const security = { ...kind.security.defaults };
        const selectedControls = new Set<string>();
        // accept only unambiguous advertised native control values, never raw CLI flags
        for (const key of ['native_mode', 'security_mode'] as const) {
          const value = input[key];
          // omitted choices retain the server-advertised defaults
          if (value === undefined) continue;
          const controls = kind.security.controls.filter(control => control.options.some(choice => choice.id === value));
          // ambiguous or unsupported values do not fall back to a permissive mode
          if (controls.length !== 1) return developerFailure('invalid_request', 'The native security selection is ambiguous or unavailable.');
          // two request fields must not silently overwrite the same native control
          if (selectedControls.has(controls[0]!.id)) return developerFailure('invalid_request', 'The same native control was selected twice.');
          selectedControls.add(controls[0]!.id);
          security[controls[0]!.id] = value as string;
        }
        const prepared = await deps.prepare(resolved.target, { kind: kind.kind as AgentKind, ...(input.model === undefined ? {} : { model: input.model }), ...(input.effort === undefined ? {} : { effort: input.effort }), security, optionsRevision: kind.optionsRevision });
        // preparation must retain the same canonical target namespace
        if (prepared.context.cwd !== resolved.context.cwd || prepared.context.hostCwd !== resolved.context.hostCwd || prepared.context.home !== resolved.context.home) return developerFailure('target_changed', 'Launch target changed during preparation.', true);
        // consume before the first side effect so concurrent requests cannot share an option
        if (options.get(input.option_id as string) !== option || option.expiresAt <= now()) return developerFailure('target_changed', 'Launch option expired.');
        options.delete(input.option_id as string);
        dispatched = true;
        const agent = await deps.launch(prepared);
        return agent === undefined ? developerFailure('unknown_outcome', 'The launch may have started; inspect agents before retrying.', true) : developerSuccess({ agent_id: agent.id, kind: agent.kind, ...(agent.structured?.model?.id === undefined ? {} : { model: agent.structured.model.id }), ...(agent.structured?.model?.effort === undefined ? {} : { effort: agent.structured.model.effort }) });
      } catch { return dispatched ? developerFailure('unknown_outcome', 'The launch may have started; inspect agents before retrying.', true) : developerFailure('target_changed', 'Launch policy or target changed; request fresh options.', true); }
    }
  };
}
