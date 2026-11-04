import type { AgentKind, LaunchInput, LaunchSpec } from '../adapters/types.js';
import type { ModelSetting } from '../transports/structured.js';
import type { LaunchSecurityManifest, NativeLaunchSecurity } from './options-types.js';

/** one native launch after semantic overrides are compiled. */
export type NativeLaunchChoice = { model?: ModelSetting; security?: NativeLaunchSecurity };
/** installed native features proven for every launch mode shown by a card. */
export type NativeLaunchCapabilities = Partial<Record<'model' | 'effort' | 'filesystem' | 'approvals' | 'bypass' | 'permissions', true>>;

type OwnedFlag = { names: readonly string[]; value: 'none' | 'one' };

const codexModel: OwnedFlag = { names: ['-m', '--model'], value: 'one' };
const codexFilesystem: OwnedFlag = { names: ['-s', '--sandbox'], value: 'one' };
const codexApprovals: OwnedFlag = { names: ['-a', '--ask-for-approval'], value: 'one' };
const codexBypass: OwnedFlag = { names: ['--dangerously-bypass-approvals-and-sandbox'], value: 'none' };
const codexAutoReview: OwnedFlag = { names: ['--approve-for-me'], value: 'none' };
const codexOpaquePreset: OwnedFlag = { names: ['--full-auto', '--yolo'], value: 'none' };
const claudeModel: OwnedFlag = { names: ['--model'], value: 'one' };
const claudeEffort: OwnedFlag = { names: ['--effort'], value: 'one' };
const claudePermissions: readonly OwnedFlag[] = [
  { names: ['--permission-mode'], value: 'one' },
  { names: ['--dangerously-skip-permissions'], value: 'none' }
];

// parse one generic native configuration key
function configKey(value: string | undefined): string | undefined {
  return value === undefined ? undefined : /^\s*([A-Za-z0-9_.-]+)\s*=/u.exec(value)?.[1];
}

// read one attached generic native configuration value
function attachedConfig(argument: string): string | undefined {
  if (argument.startsWith('--config=')) return argument.slice('--config='.length);
  if (argument.startsWith('-c=') || argument.startsWith('-c') && argument.length > 2) return argument.slice(argument.startsWith('-c=') ? 3 : 2);
  return undefined;
}

// recognize one owned flag and any attached value
function ownedFlag(argument: string, flags: readonly OwnedFlag[]): { flag: OwnedFlag; attached: boolean } | undefined {
  // scan bounded native flags
  for (const flag of flags) {
    // accept exact or equals form
    for (const name of flag.names) {
      // match one separate flag
      if (argument === name) return { flag, attached: false };
      // match long equals forms
      if (argument.startsWith(`${name}=`)) return { flag, attached: true };
      // match short attached forms
      if (/^-[A-Za-z]$/u.test(name) && argument.startsWith(name) && argument.length > name.length) return { flag, attached: true };
    }
  }
  return undefined;
}

// remove only native axes the semantic choice owns
function withoutOwned(args: readonly string[], flags: readonly OwnedFlag[], configKeys: ReadonlySet<string>): string[] {
  const kept: string[] = [];
  // consume flags and their separate values
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    // preserve the literal tail after the native delimiter
    if (argument === '--') return [...kept, ...args.slice(index)];
    // remove only explicitly owned generic config keys
    if (argument === '-c' || argument === '--config') {
      const value = args[index + 1];
      const key = configKey(value);
      if (key !== undefined && configKeys.has(key)) { index += 1; continue; }
      // remove malformed generic selectors when model configuration is owned
      if (configKeys.size > 0 && (value === undefined || value.startsWith('-'))) continue;
    }
    const config = configKey(attachedConfig(argument));
    // remove attached owned config values
    if (config !== undefined && configKeys.has(config)) continue;
    const owned = ownedFlag(argument, flags);
    if (owned === undefined) { kept.push(argument); continue; }
    // consume a separate owned value
    if (owned.flag.value === 'one' && !owned.attached && args[index + 1] !== undefined && !args[index + 1]!.startsWith('-')) index += 1;
  }
  return kept;
}

// detect a coupled configured shortcut before normalization
function hasOwned(args: readonly string[], flags: readonly OwnedFlag[]): boolean {
  // inspect only native options before the literal tail
  for (const argument of args) {
    if (argument === '--') return false;
    if (ownedFlag(argument, flags) !== undefined) return true;
  }
  return false;
}

/** refuse partial native presets that cannot preserve the inherited axis. */
export function nativeSecurityProblem(kind: AgentKind, args: readonly string[], security: NativeLaunchSecurity): string | undefined {
  // other runtimes have no Codex shortcut grammar
  if (kind !== 'codex' && kind !== 'omx') return undefined;
  const filesystem = security.filesystem !== undefined && security.filesystem !== 'inherit';
  const approvals = security.approvals !== undefined && security.approvals !== 'inherit';
  // explicit replacement of both axes needs no inherited preset
  if (security.bypass === 'dangerous' || filesystem === approvals) return undefined;
  // legacy presets have no proven independent inherited-axis mapping
  if (hasOwned(args, [codexOpaquePreset])) return 'coupled_native_preset';
  // automatic review cannot be recreated from an approval enum
  if (filesystem && !approvals && hasOwned(args, [codexAutoReview])) return 'coupled_native_preset';
  return undefined;
}

// detect an explicit generic setting for an untouched native axis
function hasConfigKey(args: readonly string[], key: string): boolean {
  // inspect only options before a literal prompt tail
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--') return false;
    const value = argument === '-c' || argument === '--config' ? args[++index] : attachedConfig(argument);
    if (configKey(value) === key) return true;
  }
  return false;
}

// compile proven Codex/OMX semantic flags
function codexOptions(choice: NativeLaunchChoice, configured: { bypass: boolean; autoReview: boolean; filesystem: boolean; approvals: boolean }): string[] {
  const flags: string[] = [];
  // emit the selected model and Effort together
  if (choice.model !== undefined) {
    flags.push('--model', choice.model.model);
    if (choice.model.effort !== undefined) flags.push('-c', `model_reasoning_effort=${choice.model.effort}`);
  }
  const security = choice.security ?? {};
  // coupled bypass replaces both restrictive axes
  if (security.bypass === 'dangerous') return [...flags, '--dangerously-bypass-approvals-and-sandbox'];
  if (security.filesystem !== undefined && security.filesystem !== 'inherit') flags.push('--sandbox', security.filesystem);
  // preserve the untouched approval half of a configured bypass
  if (configured.bypass && !configured.approvals && security.filesystem !== undefined && security.filesystem !== 'inherit' && (security.approvals === undefined || security.approvals === 'inherit')) flags.push('--ask-for-approval', 'never');
  if (security.approvals !== undefined && security.approvals !== 'inherit') flags.push('--ask-for-approval', security.approvals);
  // automatic review uses workspace-write rather than full-access bypass
  if (configured.autoReview && !configured.filesystem && security.approvals !== undefined && security.approvals !== 'inherit' && (security.filesystem === undefined || security.filesystem === 'inherit')) flags.push('--sandbox', 'workspace-write');
  // preserve the untouched filesystem half of a configured bypass
  if (configured.bypass && !configured.filesystem && security.approvals !== undefined && security.approvals !== 'inherit' && (security.filesystem === undefined || security.filesystem === 'inherit')) flags.push('--sandbox', 'danger-full-access');
  return flags;
}

// compile proven Claude semantic flags
function claudeOptions(choice: NativeLaunchChoice): string[] {
  const flags: string[] = [];
  // emit supported model settings
  if (choice.model !== undefined) {
    flags.push('--model', choice.model.model);
    if (choice.model.effort !== undefined) flags.push('--effort', choice.model.effort);
  }
  const permissions = choice.security?.permissions;
  // keep bypass atomic
  if (permissions === 'bypassPermissions') flags.push('--dangerously-skip-permissions');
  else if (permissions !== undefined && permissions !== 'inherit') flags.push('--permission-mode', permissions);
  return flags;
}

// retain console-owned Claude settings arguments
function claudeSettings(adapterArgs: readonly string[]): string[] {
  const kept: string[] = [];
  // copy only settings pairs
  for (let index = 0; index < adapterArgs.length; index += 1) {
    if (adapterArgs[index] !== '--settings' || adapterArgs[index + 1] === undefined) continue;
    kept.push('--settings', adapterArgs[index + 1]!);
    index += 1;
  }
  return kept;
}

/** compile one complete native argv, with operator conflicts removed before canonical flags. */
export function compileNativeLaunch(kind: AgentKind, input: LaunchInput, operatorArgs: readonly string[], choice: NativeLaunchChoice | undefined, adapterSpec: LaunchSpec): LaunchSpec {
  // structured Pi owns its separate launch grammar
  if (kind === 'pi' || choice === undefined) return { ...adapterSpec, args: [...adapterSpec.args, ...operatorArgs] };
  if (kind === 'codex' || kind === 'omx') {
    const security = choice.security ?? {};
    // preparation must reject unrepresentable presets before any side effect
    if (nativeSecurityProblem(kind, operatorArgs, security) !== undefined) throw Object.assign(new Error('launch_option_unsupported'), { statusCode: 409, code: 'launch_option_unsupported' });
    const filesystemOwned = security.filesystem !== undefined && security.filesystem !== 'inherit';
    const approvalsOwned = security.approvals !== undefined && security.approvals !== 'inherit';
    const dangerousBypass = security.bypass === 'dangerous';
    const bypassFlags: OwnedFlag[] = [codexBypass, ...(kind === 'omx' ? [{ names: ['--madmax'], value: 'none' as const }] : [])];
    const configuredBypass = hasOwned(operatorArgs, bypassFlags);
    const configuredAutoReview = hasOwned(operatorArgs, [codexAutoReview]);
    const configuredFilesystem = hasOwned(operatorArgs, [codexFilesystem]) || hasConfigKey(operatorArgs, 'sandbox_mode');
    const configuredApprovals = hasOwned(operatorArgs, [codexApprovals]) || hasConfigKey(operatorArgs, 'approval_policy');
    const owned: OwnedFlag[] = [];
    // own only explicitly selected axes
    if (choice.model !== undefined) owned.push(codexModel, ...(kind === 'omx' ? [{ names: ['--high', '--xhigh'], value: 'none' as const }] : []));
    if (filesystemOwned || dangerousBypass) owned.push(codexFilesystem);
    if (approvalsOwned || dangerousBypass) owned.push(codexApprovals);
    if (filesystemOwned || approvalsOwned || dangerousBypass) owned.push(...bypassFlags, codexAutoReview, codexOpaquePreset);
    const configKeys = new Set<string>();
    // own generic model selectors with the model axis
    if (choice.model !== undefined) {
      configKeys.add('model');
      configKeys.add('model_reasoning_effort');
    }
    // own generic native security selectors with their semantic axes
    if (filesystemOwned || dangerousBypass) configKeys.add('sandbox_mode');
    if (approvalsOwned || dangerousBypass) configKeys.add('approval_policy');
    const operatorTail = withoutOwned(operatorArgs, owned, configKeys);
    const options = codexOptions(choice, { bypass: configuredBypass, autoReview: configuredAutoReview, filesystem: configuredFilesystem, approvals: configuredApprovals });
    // place options before resume positionals
    if (kind === 'omx') {
      if (input.mode === 'continue') return { ...adapterSpec, args: ['--direct', 'resume', ...options, '--last', ...operatorTail] };
      if (input.mode === 'resume' && input.conversationId !== undefined) return { ...adapterSpec, args: ['--direct', 'resume', ...options, input.conversationId, ...operatorTail] };
      return { ...adapterSpec, args: ['--direct', ...options, ...operatorTail] };
    }
    if (input.mode === 'continue') return { ...adapterSpec, args: ['resume', ...options, '--last', ...operatorTail] };
    if (input.mode === 'resume' && input.conversationId !== undefined) return { ...adapterSpec, args: ['resume', ...options, input.conversationId, ...operatorTail] };
    return { ...adapterSpec, args: [...options, ...operatorTail] };
  }
  if (kind === 'claude') {
    const permissionsOwned = choice.security?.permissions !== undefined && choice.security.permissions !== 'inherit';
    const owned = [...(choice.model === undefined ? [] : [claudeModel, claudeEffort]), ...(permissionsOwned ? claudePermissions : [])];
    const operatorTail = withoutOwned(operatorArgs, owned, new Set());
    const options = claudeOptions(choice);
    const settings = claudeSettings(adapterSpec.args);
    // preserve mode grammar and injected settings
    if (input.mode === 'continue') return { ...adapterSpec, args: ['--continue', ...options, ...settings, ...operatorTail] };
    if (input.mode === 'resume' && input.conversationId !== undefined) return { ...adapterSpec, args: ['--resume', input.conversationId, ...options, ...settings, ...operatorTail] };
    return { ...adapterSpec, args: [...options, ...settings, ...operatorTail] };
  }
  return { ...adapterSpec, args: [...adapterSpec.args, ...operatorArgs] };
}

/** describe actual native execution controls without claiming RAC/MCP authority. */
export function nativeSecurityManifest(kind: AgentKind, capabilities: NativeLaunchCapabilities = {}): LaunchSecurityManifest {
  if (kind === 'pi') return {
    status: 'ready',
    controls: [{ id: 'sandbox', label: 'Tool sandbox', icon: 'shield', options: [
      { id: 'on', label: 'Sandbox on', risk: 'normal', detail: 'Allow bounded Worktree, temporary, and controlled Git writes.' },
      { id: 'off', label: 'Unsandboxed', risk: 'danger', detail: 'Run Pi tools without RAC tool confinement for this launch.' }
    ] }],
    defaults: { sandbox: 'on' },
    constraints: []
  };
  if ((kind === 'codex' || kind === 'omx') && capabilities.filesystem && capabilities.approvals && capabilities.bypass) return {
    status: 'ready',
    controls: [
      { id: 'filesystem', label: 'Filesystem', icon: 'file', options: [
        { id: 'inherit', label: 'Default', risk: 'normal', detail: 'Use the configured Codex sandbox.' },
        { id: 'read-only', label: 'Read only', risk: 'normal', detail: 'Allow reads without workspace writes.' },
        { id: 'workspace-write', label: 'Workspace write', risk: 'warning', detail: 'Allow writes inside the workspace.' },
        { id: 'danger-full-access', label: 'Full access', risk: 'danger', detail: 'Disable filesystem confinement.' }
      ] },
      { id: 'approvals', label: 'Approvals', icon: 'hand', options: [
        { id: 'inherit', label: 'Default', risk: 'normal', detail: 'Use the configured approval policy.' },
        { id: 'on-request', label: 'On request', risk: 'warning', detail: 'Let the Agent request elevated execution.' },
        { id: 'never', label: 'Never prompt', risk: 'danger', detail: 'Never request approval.' }
      ] },
      { id: 'bypass', label: 'Bypass', icon: 'warning', options: [
        { id: 'inherit', label: 'Default', risk: 'normal', detail: 'Use configured native behavior; inherited bypass state is not verified.' },
        { id: 'dangerous', label: 'Dangerous bypass', risk: 'danger', detail: 'Bypass both approvals and sandboxing.' }
      ] }
    ],
    defaults: { filesystem: 'inherit', approvals: 'inherit', bypass: 'inherit' },
    constraints: [{ when: { bypass: 'dangerous' }, disables: ['filesystem', 'approvals'], message: 'Dangerous bypass replaces filesystem and approval controls.' }]
  };
  if (kind === 'claude' && capabilities.permissions) return {
    status: 'partial',
    controls: [{ id: 'permissions', label: 'Permissions', icon: 'hand', options: [
      { id: 'inherit', label: 'Default', risk: 'normal', detail: 'Use the configured Claude permission mode.' },
      { id: 'default', label: 'Prompt', risk: 'normal', detail: 'Prompt according to Claude permissions.' },
      { id: 'acceptEdits', label: 'Accept edits', risk: 'warning', detail: 'Approve file edits automatically.' },
      { id: 'plan', label: 'Plan only', risk: 'normal', detail: 'Do not execute changes.' },
      { id: 'dontAsk', label: 'Do not ask', risk: 'danger', detail: 'Deny actions that require prompting.' },
      { id: 'bypassPermissions', label: 'Bypass permissions', risk: 'danger', detail: 'Skip Claude permission checks.' }
    ] }],
    defaults: { permissions: 'inherit' },
    constraints: [],
    message: 'Claude Bash sandbox discovery is unavailable; permission mode does not confine every hook, file tool, or MCP server.'
  };
  return { status: 'unsupported', controls: [], defaults: {}, constraints: [], message: 'Installed native execution controls could not be confirmed for this Agent.' };
}
