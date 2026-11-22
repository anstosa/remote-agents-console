import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { access, constants } from 'node:fs/promises';
import { compact, createBashToolDefinition, createCodemodeExtension, createEditToolDefinition, createLocalBashOperations, createMcpExtension, createReadToolDefinition, createWriteToolDefinition, detectSupportedImageMimeTypeFromFile, getAgentDir, VERSION, type BashOperations, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { askUser, askUserReply } from './ask-user.js';
import { conductorHandoff, conductorPrompt } from './conductor-role.js';
import { commandEnv, fileOperations, pathRefusal, sessionPolicyFrom, type SandboxPolicy } from './pi-sandbox.js';

/**
 * The RAC Pi extension, loaded into every Pi the console launches (ADR 0017). Pi loads it
 * itself (`-e`), so it imports nothing from the console but the Pi-free sandbox policy, `ask_user`
 * and the Conductor's role texts: the status key is the Pi client's `piReportStatusKey`, and a
 * dialog's title has the shape the Pi client's `dialogTitle` reads.
 *
 * At process startup it sends the launch report: that it loaded, whether the sandbox is engaged,
 * Pi's version, and the launch's nonce. the workspace URL guidance occupies one stable system
 * section. The console dispatches nothing to the Agent until the report arrives. It shows the
 * sandbox state on the Agent's status line, and refuses `!` commands: RAC offers none for Pi.
 *
 * It ships `ask_user`, the Agent's way to ask the operator. Pi's dialog requests carry no tool
 * call, so every dialog this extension raises names its tool call in its title.
 *
 * A Sandboxed launch (`RAC_SANDBOX_POLICY` names the rendered policy) arms the sandbox at every
 * session start (ADR 0004): `bash` runs each command through the sandbox runtime with an
 * allowlisted environment, and one `tool_call` handler refuses file-tool paths the policy denies,
 * for calls a script makes as for the model's own; `read`, `write` and `edit` check again the file
 * they opened, since a command running beside them can swap a link. It fails closed: when the runtime cannot
 * start, `bash` refuses with the reason and the path policy still applies.
 *
 * Launched as the Conductor (`RAC_ROLE`, ADR 0018), it adds Pi's MCP support with no configured
 * servers (the operator's `mcp.json` ones stay off) and code mode without `models`, and gives the
 * model the console's role prompt. The console hands over its MCP endpoint and token once, through
 * the `rac-console` command (the Pi client's `piConsoleCommand`), which Pi runs at once and keeps out
 * of the Conversation; the token stays in this process, never in a command's environment.
 *
 * The Conductor's compactions are its handoff to itself: Pi's own summarizer runs with the
 * Conductor's instructions, and the console's state, when the console sent it (the Pi client's
 * `compact`), is appended to the summary as written and dropped from it before the next one.
 */
export default function rac(pi: ExtensionAPI): void {
  const policyFile = process.env.RAC_SANDBOX_POLICY;
  const nonce = process.env.RAC_LAUNCH_NONCE ?? '';
  const responseUrlInstructions = process.env.RAC_RESPONSE_URL_INSTRUCTIONS ?? '';

  pi.on('user_bash', () => ({ result: { output: 'The console runs no ! commands for Pi; open a Terminal instead.', exitCode: 1, cancelled: false, truncated: false } }));

  // keep workspace URLs in one stable system section
  if (responseUrlInstructions !== '') {
    pi.on('before_agent_start', event => { event.systemPromptOptions.sections.rac_workspace_urls = responseUrlInstructions; });
  }

  const conductor = process.env.RAC_ROLE === 'conductor';
  if (conductor) {
    createMcpExtension({ loadConfig: () => ({ servers: [], errors: [], autoEnableCodemode: false }) })(pi);
    createCodemodeExtension({ models: false })(pi);
    pi.on('before_agent_start', event => { event.systemPromptOptions.sections.rac_conductor = conductorPrompt({ codeMode: true }); });
    pi.on('session_before_compact', async (event, ctx) => {
      if (ctx.model === undefined) return undefined;
      const { instructions, state } = compactRequest(event.customInstructions);
      const focus = [
        conductorHandoff,
        ...instructions === undefined ? [] : [`The operator asks of this summary: ${instructions}`],
        ...state === undefined ? [] : [`The console will append its state, below, to the summary as it is: do not repeat it, but say what each item in it is for.\n\n${state}`]
      ].join('\n\n');
      const previous = event.preparation.previousSummary;
      const preparation = previous === undefined ? event.preparation : { ...event.preparation, previousSummary: withoutState(previous) };
      try {
        const result = await compact(preparation, ctx.model, undefined, undefined, focus, event.signal, pi.getThinkingLevel(), (model, context, options) => ctx.modelRegistry.streamSimple(model, context, options));
        return { compaction: state === undefined ? result : { ...result, summary: `${result.summary}\n\n${stateOpen}\n${state}\n${stateClose}` } };
      } catch (error) {
        if (event.signal.aborted) return { cancel: true };
        ctx.ui.notify(`The Conductor's summary failed, so Pi's own is used: ${error instanceof Error ? error.message : String(error)}`, 'warning');
        return undefined;
      }
    });
  }
  // registered for every Pi, so the access can never reach a model as a prompt; taken once, by the Conductor only
  let consoleGiven = false;
  pi.registerCommand('rac-console', {
    description: 'Used by the console only',
    async handler(args, ctx) {
      if (!conductor || consoleGiven) { ctx.ui.notify('The console\'s access is given once, to the Conductor only.', 'error'); return; }
      const { url, token } = JSON.parse(args) as { url?: unknown; token?: unknown };
      if (typeof url !== 'string' || typeof token !== 'string') throw new Error('the console access is malformed');
      consoleGiven = true;
      pi.registerMcpServer('rac', { url, headers: { Authorization: `Bearer ${token}` }, exposure: 'direct', description: 'The Remote Agent Console: its Agents, Worktrees, Stack processes, reviews and files' });
      // the console takes the access as given only once this says so (Pi answers `handled` either way)
      ctx.ui.setStatus('rac-console', 'ready');
    }
  });

  // the session's policy (unset until known: every file tool is refused meanwhile) and why its
  // runtime is not running, if it is not
  let policy: SandboxPolicy | undefined;
  let cwd = process.cwd();
  let failure: string | undefined = 'the sandbox has not started';
  let tempDir: string | undefined;
  if (policyFile !== undefined) {
    // `bash` shells out as Pi's own does, but wrapped by the runtime and with only the allowed environment
    const local = createLocalBashOperations({ shellPath: '/bin/bash' });
    const operations: BashOperations = {
      async exec(command, cwd, options) {
        if (failure !== undefined || policy === undefined) throw new Error(`Sandboxed commands are refused: ${failure ?? 'no policy'}`);
        const wrapped = await SandboxManager.wrapWithSandbox(command, '/bin/bash', undefined, options.signal);
        try { return await local.exec(wrapped, cwd, { ...options, env: commandEnv(options.env ?? process.env, policy.env) }); } finally { SandboxManager.cleanupAfterCommand(); }
      }
    };
    // one at a time with the model's other tools; a command running beside a file tool anyway (a
    // Watch's, or code mode's nested `bash`) meets the file tools' own checks
    pi.registerTool({ ...createBashToolDefinition(process.cwd(), { operations }), executionMode: 'sequential' });
    const files = fileOperations(() => policy === undefined ? undefined : { policy, cwd });
    pi.registerTool(createReadToolDefinition(process.cwd(), { operations: { readFile: files.readFile, access: path => access(path, constants.R_OK), detectImageMimeType: path => files.read(path, detectSupportedImageMimeTypeFromFile) } }));
    pi.registerTool(createWriteToolDefinition(process.cwd(), { operations: { writeFile: files.writeFile, mkdir: files.mkdir } }));
    pi.registerTool(createEditToolDefinition(process.cwd(), { operations: { readFile: files.readFile, writeFile: files.writeFile, access: path => access(path, constants.R_OK | constants.W_OK) } }));
    pi.on('tool_call', (event, ctx) => {
      if (policy === undefined) return { block: true, reason: `The sandbox policy is not loaded: ${failure}` };
      const reason = pathRefusal(event.toolName, event.input as Record<string, unknown>, ctx.cwd, policy);
      return reason === undefined ? undefined : { block: true, reason };
    });
  }

  pi.on('session_start', async (event, ctx) => {
    if (policyFile !== undefined) {
      try {
        if (tempDir !== undefined) rmSync(tempDir, { recursive: true, force: true });
        tempDir = mkdtempSync(join(tmpdir(), 'rac-pi-'));
        cwd = ctx.cwd;
        policy = sessionPolicyFrom(policyFile, { cwd: ctx.cwd, stateDir: getAgentDir(), tempDir }, process.env);
        // the runtime points each command's TMPDIR here
        process.env.CLAUDE_CODE_TMPDIR = tempDir;
        await SandboxManager.initialize({ network: policy.network, filesystem: policy.filesystem });
        failure = undefined;
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`The sandbox did not start, so commands are refused: ${failure}`, 'error');
      }
    }
    // the status line's sandbox state, kept current across sessions
    ctx.ui.setStatus('rac-sandbox', policyFile === undefined ? 'not sandboxed' : failure === undefined ? 'sandboxed' : 'sandbox not running: commands refused');
    if (event.reason !== 'startup') return;
    const sandbox = policyFile === undefined ? { engaged: false, reason: 'not sandboxed' } : failure === undefined ? { engaged: true } : { engaged: false, reason: failure };
    ctx.ui.setStatus('rac-launch', JSON.stringify({ loaded: true, sandbox, version: VERSION, nonce }));
  });

  pi.on('session_shutdown', async () => {
    if (policyFile === undefined) return;
    if (failure === undefined) await SandboxManager.reset().catch(() => undefined);
    failure = 'the session has ended';
    if (tempDir !== undefined) rmSync(tempDir, { recursive: true, force: true });
  });

  pi.registerTool({
    name: askUser.name,
    label: 'Ask the operator',
    description: askUser.description,
    promptSnippet: 'Ask the operator a question and wait for the answer',
    // plain JSON Schema: TypeBox is Pi's own dependency, not the console's
    parameters: askUser.parameters as never,
    executionMode: 'sequential',
    async execute(toolCallId, params: { question: string; choices?: string[] }, signal, _onUpdate, ctx) {
      const title = JSON.stringify({ rac: 'dialog', toolCallId, text: params.question });
      const answer = params.choices !== undefined && params.choices.length > 0
        ? await ctx.ui.select(title, params.choices, { signal })
        : await ctx.ui.input(title, undefined, { signal });
      return { content: [{ type: 'text', text: askUserReply(params.choices, answer) }], details: { answered: answer !== undefined } };
    }
  });
}

// the console's state as appended to a Conductor's summary
const stateOpen = '<rac-console-state>';
const stateClose = '</rac-console-state>';
const withoutState = (summary: string): string => summary.replace(/\n*<rac-console-state>[\s\S]*?<\/rac-console-state>\n*/gu, '\n\n').trim();
// a compaction's instructions: the console's state and the operator's instructions, as the Pi
// client's `compact` sends them, or plain instructions
const compactRequest = (given: string | undefined): { instructions?: string; state?: string } => {
  if (given === undefined) return {};
  try {
    const parsed = JSON.parse(given) as { rac?: unknown; state?: unknown; instructions?: unknown } | null;
    if (parsed?.rac === 'compact' && typeof parsed.state === 'string') return { state: parsed.state, ...(typeof parsed.instructions === 'string' ? { instructions: parsed.instructions } : {}) };
  } catch { /* plain instructions */ }
  return { instructions: given };
};
