import { createHash } from 'node:crypto';
import type { NativeReplySuggestionSource, ReplySuggestionMessage } from './types.js';
import { replySuggestionPrompt } from './prompt.js';
import { replySuggestionSchema } from './validation.js';

export const nativeTimeoutMs = 20_000;
export const nativeFinalOutputBytes = 8 * 1_024;
export const nativeProtocolOutputBytes = 1024 * 1024;
export const nativeStderrBytes = 64 * 1024;
export const nativeRequestBytes = 128 * 1024;
export const expectedCodexVersion = 'codex-cli 0.169.0';
export const expectedClaudeVersion = '2.1.311 (Claude Code)';

// hash stable policy material for stale-route fences
export const nativePolicyGeneration = createHash('sha256').update(JSON.stringify([
  replySuggestionPrompt, replySuggestionSchema, nativeTimeoutMs, nativeFinalOutputBytes,
  expectedCodexVersion, expectedClaudeVersion, 'native-reply-policy-v1'
])).digest('hex');

// quote one trusted string for generated toml
function tomlString(value: string): string {
  return JSON.stringify(value);
}

// copy only bounded authored conversation messages into inert data
export function nativeConversation(messages: readonly ReplySuggestionMessage[]): string | undefined {
  const value = `${replySuggestionPrompt}\n<conversation_json>${JSON.stringify(messages.map(message => ({ role: message.role, text: message.text })))}</conversation_json>`;
  return Buffer.byteLength(value, 'utf8') <= 64 * 1024 ? value : undefined;
}

// build the exact capability-neutral Codex config after native feature discovery
export function codexConfig(source: NativeReplySuggestionSource, catalog: string, features: readonly string[]): string | undefined {
  const effort = source.model.effort;
  // exact model and effort are mandatory
  if (source.nativeModel.provider !== 'openai' || source.nativeModel.id !== source.model.model || effort === undefined || !/^[A-Za-z0-9._-]{1,100}$/u.test(source.nativeModel.id) || !/^[A-Za-z0-9_-]{1,32}$/u.test(effort) || features.length !== 215 || new Set(features).size !== features.length) return undefined;
  return `model = ${tomlString(source.nativeModel.id)}
model_provider = "openai"
model_reasoning_effort = ${tomlString(effort)}
model_catalog_json = ${tomlString(catalog)}
project_doc_max_bytes = 0
web_search = "disabled"
approval_policy = "never"
sandbox_mode = "read-only"
developer_instructions = ${tomlString(replySuggestionPrompt)}
include_permissions_instructions = false
include_apps_instructions = false
include_collaboration_mode_instructions = false
include_environment_context = false
include_environment_context_time = false
check_for_update_on_startup = false
cli_auth_credentials_store = "file"

[analytics]
enabled = false

[feedback]
enabled = false

[features]
${[...features].sort().map(feature => `${tomlString(feature)} = false`).join('\n')}

[tools.experimental_request_user_input]
enabled = false

[tools.update_plan]
enabled = false

[skills]
include_instructions = false

[cloud.skills]
enabled = false
`;
}

// retain exposed model metadata while removing every model capability
export function codexCatalog(source: NativeReplySuggestionSource, model: Record<string, unknown>): object | undefined {
  const efforts = model.supportedReasoningEfforts;
  // require one exact fresh native catalog entry
  if ((model.id !== source.nativeModel.id && model.model !== source.nativeModel.id) || !Array.isArray(efforts) || !efforts.some(entry => entry !== null && typeof entry === 'object' && (entry as { reasoningEffort?: unknown }).reasoningEffort === source.model.effort)) return undefined;
  const supported = efforts.flatMap(entry => {
    // retain only valid effort metadata
    if (entry === null || typeof entry !== 'object') return [];
    const value = entry as { reasoningEffort?: unknown; description?: unknown };
    return typeof value.reasoningEffort === 'string' ? [{ effort: value.reasoningEffort, ...(typeof value.description === 'string' ? { description: value.description } : {}) }] : [];
  });
  return {
    models: [{
      slug: source.nativeModel.id,
      display_name: typeof model.displayName === 'string' ? model.displayName : source.nativeModel.id,
      description: typeof model.description === 'string' ? model.description : '',
      default_reasoning_level: typeof model.defaultReasoningEffort === 'string' ? model.defaultReasoningEffort : source.model.effort,
      supported_reasoning_levels: supported,
      shell_type: 'disabled', visibility: 'list', supported_in_api: true, priority: 1,
      ...(Array.isArray(model.additionalSpeedTiers) ? { additional_speed_tiers: model.additionalSpeedTiers } : {}),
      ...(Array.isArray(model.serviceTiers) ? { service_tiers: model.serviceTiers } : {}),
      ...(model.availableAccessPrograms !== undefined ? { available_access_programs: model.availableAccessPrograms } : {}),
      ...(model.availabilityNux !== undefined ? { availability_nux: model.availabilityNux } : {}),
      ...(model.upgrade !== undefined ? { upgrade: model.upgrade } : {}),
      model_messages: { instructions_template: replySuggestionPrompt },
      include_skills_usage_instructions: false,
      include_plugin_usage_instructions: false,
      include_apps_usage_instructions: false,
      default_reasoning_summary: 'none', support_verbosity: true, default_verbosity: 'low',
      apply_patch_tool_type: null,
      truncation_policy: { mode: 'tokens', limit: 10_000 },
      supports_image_detail_original: false,
      context_window: typeof model.contextWindow === 'number' ? model.contextWindow : 128_000,
      max_context_window: typeof model.contextWindow === 'number' ? model.contextWindow : 128_000,
      effective_context_window_percent: 95,
      experimental_supported_tools: [], input_modalities: ['text'],
      supports_search_tool: false, supports_experimental_context: false,
      use_responses_lite: true, supports_reasoning_effort_updates: false,
      node_repl_auto_review_required: false, node_repl_disabled: true, tool_mode: 'direct'
    }]
  };
}

// sanitize one exact native cache entry while preserving non-capability metadata
export function codexCachedCatalog(source: NativeReplySuggestionSource, model: Record<string, unknown>): object | undefined {
  const efforts = model.supported_reasoning_levels;
  // require the source model and effort in the native cache
  if (model.slug !== source.nativeModel.id || !Array.isArray(efforts) || !efforts.some(entry => entry !== null && typeof entry === 'object' && (entry as { effort?: unknown }).effort === source.model.effort)) return undefined;
  const sanitized = { ...model };
  // remove catalog-selected alternate capability routes
  for (const key of ['web_search_tool_type', 'web_search_provider', 'multi_agent_version', 'multi_agent_reasoning_effort']) delete sanitized[key];
  Object.assign(sanitized, {
    shell_type: 'disabled', apply_patch_tool_type: null, experimental_supported_tools: [],
    supports_search_tool: false, node_repl_auto_review_required: false, node_repl_disabled: true,
    tool_mode: 'direct', include_skills_usage_instructions: false,
    include_plugin_usage_instructions: false, include_apps_usage_instructions: false,
    model_messages: { instructions_template: replySuggestionPrompt }
  });
  return { models: [sanitized] };
}

// compose the proven no-tool, no-history native Claude invocation
export function claudeArguments(source: NativeReplySuggestionSource, mcpFile: string, sessionId: string): string[] | undefined {
  const effort = source.model.effort;
  // exact resolved native model and effort are mandatory
  if (source.nativeModel.provider !== 'anthropic' || effort === undefined || !/^[A-Za-z0-9._-]{1,100}$/u.test(source.nativeModel.id) || !/^[A-Za-z0-9._-]{1,100}$/u.test(source.model.model) || !/^[A-Za-z0-9_-]{1,32}$/u.test(effort) || !/^[0-9a-f-]{36}$/u.test(sessionId)) return undefined;
  return [
    '-p', '--safe-mode', '--tools', '', '--strict-mcp-config', '--mcp-config', mcpFile,
    '--permission-prompts', 'none', '--permission-mode', 'dontAsk', '--no-session-persistence',
    '--disable-slash-commands', '--no-chrome', '--prompt-suggestions', 'false', '--setting-sources', '',
    '--system-prompt', replySuggestionPrompt, '--system-prompt-snapshot', 'off', '--session-id', sessionId,
    '--model', source.nativeModel.id, '--effort', effort, '--output-format', 'stream-json', '--verbose'
  ];
}
