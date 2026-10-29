import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { createBashToolDefinition, createLocalBashOperations, getAgentDir, VERSION, type BashOperations, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { commandEnv, pathRefusal, sessionPolicy, type SandboxPolicy } from './pi-sandbox.js';

/**
 * The RAC Pi extension, loaded into every Pi the console launches (ADR 0017). Pi loads it
 * itself (`-e`), so it imports nothing from the console but the Pi-free sandbox policy: the status
 * key is the Pi client's `piReportStatusKey`, and a dialog's title has the shape the Pi client's
 * `dialogTitle` reads.
 *
 * At process startup it sends the launch report: that it loaded, whether the sandbox is engaged,
 * Pi's version, and the launch's nonce. The console dispatches nothing to the Agent until the
 * report arrives. It shows the sandbox state on the Agent's status line, and refuses `!` commands:
 * RAC offers none for Pi.
 *
 * It ships `ask_user`, the Agent's way to ask the operator. Pi's dialog requests carry no tool
 * call, so every dialog this extension raises names its tool call in its title.
 *
 * A Sandboxed launch (`RAC_SANDBOX_POLICY` names the rendered policy) arms the sandbox at every
 * session start (ADR 0004): `bash` runs each command through the sandbox runtime with an
 * allowlisted environment, and one `tool_call` handler refuses file-tool paths the policy denies,
 * for calls a script makes as for the model's own. It fails closed: when the runtime cannot
 * start, `bash` refuses with the reason and the path policy still applies.
 */
export default function rac(pi: ExtensionAPI): void {
  const policyFile = process.env.RAC_SANDBOX_POLICY;
  const nonce = process.env.RAC_LAUNCH_NONCE ?? '';

  pi.on('user_bash', () => ({ result: { output: 'The console runs no ! commands for Pi; open a Terminal instead.', exitCode: 1, cancelled: false, truncated: false } }));

  // the session's policy (unset until known: every file tool is refused meanwhile) and why its
  // runtime is not running, if it is not
  let policy: SandboxPolicy | undefined;
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
    // one at a time with the other tools, so no command can swap a file between the path policy's
    // check and a file tool's use of it
    pi.registerTool({ ...createBashToolDefinition(process.cwd(), { operations }), executionMode: 'sequential' });
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
        const git = gitDirs(ctx.cwd);
        // what the policy protects in a repository's own git directory must exist to be protected in
        // place (a deny on a missing path leaves a placeholder that git stumbles on): `.` is the
        // `commondir` git takes when there is none, and the folders are empty
        if (git.git !== undefined && git.git.dir === git.git.commonDir) {
          if (!existsSync(join(git.git.dir, 'commondir'))) writeFileSync(join(git.git.dir, 'commondir'), '.\n', { flag: 'wx' });
          for (const folder of ['hooks', 'info', 'modules', 'worktrees', 'remotes', 'branches']) mkdirSync(join(git.git.dir, folder), { recursive: true });
        }
        policy = sessionPolicy(JSON.parse(readFileSync(policyFile, 'utf8')) as SandboxPolicy, { cwd: ctx.cwd, stateDir: getAgentDir(), ...git, tempDir, ...tmuxSocket() });
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
    name: 'ask_user',
    label: 'Ask the operator',
    description: 'Ask the operator a question and wait for the answer. Offer choices when the answer is one of a few options; otherwise the operator types an answer. Ask instead of guessing when a decision is theirs.',
    promptSnippet: 'Ask the operator a question and wait for the answer',
    // plain JSON Schema: TypeBox is Pi's own dependency, not the console's
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question, on its own' },
        choices: { type: 'array', items: { type: 'string' }, description: 'The answers to choose from, when there are a few' }
      },
      required: ['question'],
      additionalProperties: false
    } as never,
    executionMode: 'sequential',
    async execute(toolCallId, params: { question: string; choices?: string[] }, signal, _onUpdate, ctx) {
      const title = JSON.stringify({ rac: 'dialog', toolCallId, text: params.question });
      const answer = params.choices !== undefined && params.choices.length > 0
        ? await ctx.ui.select(title, params.choices, { signal })
        : await ctx.ui.input(title, undefined, { signal });
      const text = answer === undefined ? 'The operator dismissed the question without answering.' : answer;
      return { content: [{ type: 'text', text }], details: { answered: answer !== undefined } };
    }
  });
}

// the checkout's git directory and git's common directory (the same one outside a linked Worktree)
function gitDirs(cwd: string): { git?: { dir: string; commonDir: string } } {
  try {
    const [dir, commonDir] = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 }).trim().split('\n');
    return dir === undefined || dir === '' || commonDir === undefined || commonDir === '' ? {} : { git: { dir, commonDir } };
  } catch { return {}; }
}
// the socket of the tmux server Pi's holder runs in (`TMUX` is `<socket>,<pid>,<session>`)
function tmuxSocket(): { tmuxSocket?: string } {
  const socket = process.env.TMUX?.split(',')[0];
  return socket === undefined || socket === '' ? {} : { tmuxSocket: socket };
}
