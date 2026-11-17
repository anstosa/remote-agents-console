import type { AgentKind, LaunchSpec } from './types.js';

const instructionsVariable = 'RAC_RESPONSE_URL_INSTRUCTIONS';

// keep the workspace preference in stable process/session context rather than user queries
export function responseUrlEnvironment(origin?: string): Record<string, string> {
  const instructions = origin === undefined ? '' : [
    `The current workspace application's configured tunnel origin is ${origin}.`,
    'When sharing application URLs in responses, use that origin instead of a local/internal host and port. Preserve the path, query, and fragment.',
    'Do not change unrelated external URLs or addresses used for local commands and checks.'
  ].join('\n');
  return { [instructionsVariable]: instructions };
}

// quote fixed hook code without interpolating workspace data into a shell command
function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

// lifecycle-only output becomes additional context under the native hook trust boundary
const hookScript = [
  `const instructions = process.env.${instructionsVariable};`,
  '// an originless workspace must not inherit another workspace preference',
  'if (instructions) {',
  '  let input;',
  '  try { input = JSON.parse(require("node:fs").readFileSync(0, "utf8")); } catch { process.exit(0); }',
  '  const event = input.hook_event_name;',
  '  // never emit context from a per-query event',
  '  if (event === "SessionStart" || event === "SubagentStart") {',
  '    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: instructions } }));',
  '  }',
  '}'
].join('\n');
export const responseUrlSessionHookCommand = `node -e ${shellQuote(hookScript)}`;

// serialize one stable handler so different tunnel URLs do not require new hook trust
function codexHook(): string {
  return `{hooks=[{type="command",command=${JSON.stringify(responseUrlSessionHookCommand)},timeout=5,additionalContextLimit=1000}]}`;
}

// recognize only the exact application-owned hook, never arbitrary operator commands
export function isResponseUrlHookOverride(assignment: string): boolean {
  return ['SessionStart', 'SubagentStart'].some(event => assignment === `hooks.${event}=[${codexHook()}]`);
}

// identify only real configuration options before a literal native prompt tail
function configArgument(args: readonly string[], index: number): { value: string; valueIndex: number; prefix: string } | undefined {
  const argument = args[index]!;
  // preserve separate configuration values
  if (argument === '-c' || argument === '--config') return args[index + 1] === undefined ? undefined : { value: args[index + 1]!, valueIndex: index + 1, prefix: '' };
  // preserve supported attached configuration spellings
  for (const prefix of ['--config=', '-c=', '-c']) {
    // ignore the bare short flag handled above
    if (argument.startsWith(prefix) && argument.length > prefix.length) return { value: argument.slice(prefix.length), valueIndex: index, prefix };
  }
  return undefined;
}

// retain operator hook arrays rather than replacing another session-layer definition
function withCodexHooks(args: readonly string[]): string[] {
  const result = [...args];
  const events = ['SessionStart', 'SubagentStart'] as const;
  const overrides = new Map<string, { index: number; prefix: string; assignment: string; value: string }>();
  let tail = result.indexOf('--');
  // no literal prompt tail means every argument is a native option
  if (tail < 0) tail = result.length;
  // only the last same-layer override is effective in Codex
  for (let index = 0; index < tail; index += 1) {
    const config = configArgument(result, index);
    // unrelated native options remain untouched
    if (config === undefined) continue;
    const equal = config.value.indexOf('=');
    const key = config.value.slice(0, equal).trim();
    const unquotedKey = key.replaceAll('"', '').replaceAll("'", '');
    const targetedKey = unquotedKey === 'hooks' || events.some(event => unquotedKey === `hooks.${event}` || unquotedKey.startsWith(`hooks.${event}.`));
    // opaque parent/quoted overrides cannot safely be rewritten as event arrays
    if (equal >= 0 && targetedKey && !events.some(event => key === `hooks.${event}`)) {
      throw Object.assign(new Error('Workspace URL context cannot be combined with an opaque Codex hooks override; use event-array overrides or user/project hook configuration.'), { statusCode: 409, code: 'response_url_hook_conflict' });
    }
    // event arrays can be extended without parsing or rewriting their contents
    if (events.some(event => key === `hooks.${event}`)) overrides.set(key, { index: config.valueIndex, prefix: config.prefix, assignment: config.value.slice(0, equal + 1), value: config.value.slice(equal + 1) });
    // a separate value is not another command-line option
    if (config.valueIndex > index) index = config.valueIndex;
  }
  const added: string[] = [];
  // preserve operator handlers and append matching hooks from other config layers normally
  for (const event of events) {
    const key = `hooks.${event}`;
    const existing = overrides.get(key);
    // introduce a session-layer event only when the operator did not provide it
    if (existing === undefined) { added.push('-c', `${key}=[${codexHook()}]`); continue; }
    const opening = existing.value.search(/\S/u);
    // a hook definition must already be a TOML array to merge safely
    if (opening < 0 || existing.value[opening] !== '[') throw Object.assign(new Error('Workspace URL context requires Codex hook overrides to use arrays.'), { statusCode: 409, code: 'response_url_hook_conflict' });
    result[existing.index] = `${existing.prefix}${existing.assignment}${existing.value.slice(0, opening + 1)}${codexHook()},${existing.value.slice(opening + 1)}`;
  }
  return [...result.slice(0, tail), ...added, ...result.slice(tail)];
}

// run after model/security compilation so persistent context survives every launch choice
export function withCodexResponseUrlContext(kind: AgentKind, origin: string | undefined, spec: LaunchSpec): LaunchSpec {
  // other adapters own their context; an originless Codex launch installs no context hook
  if ((kind !== 'codex' && kind !== 'omx') || origin === undefined) return spec;
  return { ...spec, args: withCodexHooks(spec.args), env: { ...spec.env, ...responseUrlEnvironment(origin) } };
}
