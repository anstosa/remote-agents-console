import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import type { AdapterLaunchConfig } from '../adapters/types.js';
import { run, tmuxFormatLiteral } from '../tmux/command.js';
import { hostCommand, hostInteractiveShellPath, interactiveShellBootstrap, interactiveShellPath } from '../tmux/interactive-shell.js';
import { serverCheckout } from '../workspaces/server-checkout.js';
import { inheritedHomeEnvironment } from '../places/launch-home.js';

export type OmxCatalogContext = { cwd: string; hostCwd?: string; home?: string };
export type OmxCatalogProbe = { version: 1; config: unknown; pages: unknown[]; args: string[]; capabilities: { model?: true; effort?: true }; identity?: string };
type ProbeDependencies = { command?: typeof run; environment?: NodeJS.ProcessEnv; checkout?: string };

const maxProbeBytes = 900 * 1024;
// quote only server-owned values used by the fixed helper invocation
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/** query metadata through the same shell and namespace as an OMX launch. */
export async function probeOmxCatalog(config: AdapterLaunchConfig, context: OmxCatalogContext, timeoutMs = 5_000, dependencies: ProbeDependencies = {}): Promise<OmxCatalogProbe> {
  return await probeNativeCatalog('omx', config, context, timeoutMs, dependencies);
}

/** query the configured host Codex without substituting the container binary. */
export async function probeCodexCatalog(config: AdapterLaunchConfig, context: OmxCatalogContext, timeoutMs = 5_000, dependencies: ProbeDependencies = {}): Promise<OmxCatalogProbe> {
  return await probeNativeCatalog('codex', config, context, timeoutMs, dependencies);
}

// share the bounded private transport while keeping each native context independent
async function probeNativeCatalog(kind: 'codex' | 'omx', config: AdapterLaunchConfig, context: OmxCatalogContext, timeoutMs: number, dependencies: ProbeDependencies): Promise<OmxCatalogProbe> {
  const env = dependencies.environment ?? process.env;
  const command = dependencies.command ?? run;
  const bridged = env.RAC_HOST_TMUX_DIR !== undefined;
  const checkout = dependencies.checkout ?? serverCheckout(env);
  const hostCheckout = env.RAC_HOST_REPOSITORY?.trim();
  const node = bridged ? env.RAC_HOST_NODE_BIN?.trim() : process.execPath;
  const environment = inheritedHomeEnvironment(config.env, context.home ?? (bridged ? undefined : env.HOME));
  const home = environment.HOME;
  const cwd = bridged ? context.hostCwd : context.cwd;
  // refuse namespace guesses before creating any temporary descriptor
  if (node === undefined || !isAbsolute(node) || home === undefined || !isAbsolute(home) || cwd === undefined || !isAbsolute(cwd) || bridged && (hostCheckout === undefined || !isAbsolute(hostCheckout))) throw new Error('omx_context_unavailable');
  const base = bridged ? join(checkout, '.data') : tmpdir();
  await mkdir(base, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(base, '.rac-model-discovery-'));
  const descriptor = join(directory, 'request.json');
  const hostDirectory = bridged ? join(hostCheckout!, '.data', basename(directory)) : directory;
  const hostDescriptor = join(hostDirectory, 'request.json');
  const helper = join(bridged ? hostCheckout! : checkout, 'scripts', 'discover-omx-models.mjs');
  const duration = Math.max(250, Math.min(timeoutMs, 10_000));
  try {
    // keep configured credentials out of process argv and shared output
    await writeFile(descriptor, JSON.stringify({ version: 1, kind, program: config.program, args: config.args, cwd, home, env: environment, timeoutMs: duration, expiresAt: Date.now() + duration }), { mode: 0o600, flag: 'wx' });
    const shell = bridged ? hostInteractiveShellPath() : interactiveShellPath();
    const invoke = `exec ${quote(node)} ${quote(helper)} --request ${quote(hostDescriptor)}`;
    const restored = bridged ? hostCommand(invoke, home, env.RAC_HOST_PATH?.trim()) : invoke;
    const bootstrap = interactiveShellBootstrap(restored, home, shell);
    const job = `cd -- ${quote(cwd)}\nexec ${quote(shell)} -lc ${quote(bootstrap)}`;
    // the host watchdog owns the entire job group, even if its tmux client exits
    const script = `exec /usr/bin/timeout --signal=TERM --kill-after=0.25s ${duration / 1000}s /bin/sh -c ${quote(job)}`;
    const result = bridged
      ? await command(env.RAC_TMUX_BIN ?? '/usr/bin/tmux', ['-S', join(env.RAC_HOST_TMUX_DIR!, 'default'), 'run-shell', tmuxFormatLiteral(script)], undefined, duration + 2_000)
      : await command('/bin/sh', ['-c', script], undefined, duration + 2_000);
    // never accept truncated metadata, shell diagnostics, or incomplete helpers
    if (result.code !== 0 || result.timedOut || result.stdoutTruncated || Buffer.byteLength(result.stdout) > maxProbeBytes) throw new Error('omx_discovery_unavailable');
    const value = JSON.parse(result.stdout) as Partial<OmxCatalogProbe>;
    // validate framing before the catalog parser handles native records
    if (value === null || value.version !== 1 || !Array.isArray(value.pages) || value.pages.length < 1 || value.pages.length > 10 || !Array.isArray(value.args) || value.args.length > 128 || !value.args.every(argument => typeof argument === 'string' && argument.length <= 16_384) || value.capabilities === null || typeof value.capabilities !== 'object' || Object.entries(value.capabilities).some(([key, flag]) => !['model', 'effort'].includes(key) || flag !== true)) throw new Error('omx_discovery_unavailable');
    return value as OmxCatalogProbe;
  } finally {
    // the helper also unlinks its input immediately; clean only this owned request
    await rm(directory, { recursive: true, force: true });
  }
}
