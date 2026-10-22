import { randomBytes, randomUUID } from 'node:crypto';
import { access, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ReviewRuns } from '../adapters/types.js';
import { run } from '../tmux/command.js';
import { MAX_REVIEW_GENERATED_BYTES } from '../review-tour/contracts.js';
import { runReviewProcess } from './process.js';
import { ReviewRunError, unavailable, type KindReviewRunner, type ReviewRunCapability, type ReviewRunRequest, type ReviewRunResult } from './runner.js';

// Runs one kind's headless Review runs (ADR 0010) from its Adapter's description: a child process
// with the prompt on stdin, in its own process group, bounded in time and output, given private
// files (its schema, a place for its reply) removed after. The description says which arguments
// and how to read the reply and its conversation. A run resumes the request's conversation, or starts one
// under an id the console chose, which a CLI that names its own conversations reports instead.
export class HeadlessReviewRunner implements KindReviewRunner {
  private capabilityResult?: Promise<ReviewRunCapability>;

  // `binary` is the kind's configured program; an empty string (nothing configured) reports
  // unavailable rather than spawning a bare name
  constructor(private readonly headless: ReviewRuns['headless'], private readonly binary: string) {}

  // verify the configured CLI surface once
  capability(): Promise<ReviewRunCapability> {
    this.capabilityResult ??= this.detectCapability();
    return this.capabilityResult;
  }

  // require a configured, absolute executable whose help lists every isolation and output flag,
  // and a persisted login where the CLI can report one
  private async detectCapability(): Promise<ReviewRunCapability> {
    if (!this.binary.startsWith('/')) return { available: false, reason: 'configuration_invalid' };
    const executable = await access(this.binary, constants.X_OK).then(() => true).catch(() => false);
    if (!executable) return { available: false, reason: 'generator_unavailable' };
    const { probe } = this.headless;
    const help = await run(this.binary, [...probe.help], undefined, 5_000).catch(() => undefined);
    if (help === undefined || help.code !== 0 || !probe.flags.every(flag => help.stdout.includes(flag))) return { available: false, reason: 'unsupported_cli' };
    if (probe.login !== undefined) {
      const login = await run(this.binary, [...probe.login], undefined, 5_000).catch(() => undefined);
      if (login === undefined || login.code !== 0) return { available: false, reason: 'authentication_required' };
    }
    return { available: true };
  }

  // run one generation and return its reply and conversation
  async run(request: ReviewRunRequest, signal: AbortSignal): Promise<ReviewRunResult> {
    const refused = unavailable(await this.capability());
    if (refused !== undefined) throw refused;
    const outputBytes = request.maxOutputBytes ?? MAX_REVIEW_GENERATED_BYTES;
    let root: string | undefined;
    try {
      root = await mkdtemp(join(tmpdir(), `rac-review-${randomBytes(4).toString('hex')}-`));
      await chmod(root, 0o700);
      const schema = request.reply.kind === 'json' ? request.reply.schema : undefined;
      const files = { ...(schema === undefined ? {} : { schema: join(root, 'schema.json') }), output: join(root, 'result.json') };
      if (files.schema !== undefined) await writeFile(files.schema, JSON.stringify(schema), { mode: 0o600 });
      const conversation = request.resume === undefined ? { create: randomUUID() } : { resume: request.resume };
      const command = this.headless.command({ workspace: request.workspace, conversation, ...(schema === undefined ? {} : { schema }), ...(request.model === undefined ? {} : { model: request.model }), ...(request.effort === undefined ? {} : { effort: request.effort }) }, files);
      const stdoutBytes = this.headless.stdoutBytes?.(outputBytes);
      const result = await runReviewProcess({ binary: this.binary, args: command.args, ...(command.cwd === undefined ? {} : { cwd: command.cwd }), stdin: request.prompt, timeoutMs: request.timeoutMs, ...(stdoutBytes === undefined ? {} : { maxStdoutBytes: stdoutBytes }) }, signal);
      const output = await readFile(files.output).catch(() => undefined);
      const reply = this.headless.result({ code: result.code, diagnostics: result.diagnostics, ...(stdoutBytes === undefined ? {} : { stdout: result.stdout, ...(result.overflowed ? { stdoutTruncated: true } : {}) }), ...(output === undefined ? {} : { output }) }, { outputBytes, text: request.reply.kind === 'text' });
      if (reply.ok) { const known = command.conversation ?? reply.conversation; return { value: reply.value, ...(known === undefined ? {} : { conversation: known }) }; }
      throw new ReviewRunError(reply.failure, reply.failure !== 'authentication_required');
    } catch (error) {
      // preserve typed failures; anything else (files the run could not be given, a spawn the OS refused) failed to run
      if (error instanceof ReviewRunError) throw error;
      throw new ReviewRunError('generation_failed', true);
    } finally {
      if (root !== undefined) await rm(root, { recursive: true, force: true });
    }
  }
}
