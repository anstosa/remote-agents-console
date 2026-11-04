import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, tmuxFormatLiteral } from '../tmux/command.js';

const piPackage = '@earendil-works/pi-coding-agent';
const runtimeFiles = ['adapters/pi-extension.js', 'adapters/pi-sandbox.js', 'git/overrides.js', 'transports/holder.js', 'watches/sandboxed-command.js'];
const dependencies = [piPackage, '@earendil-works/pi-codemode', '@anthropic-ai/sandbox-runtime'];

// locate a package without relying on its public exports
export function piPackageRoot(from: string = import.meta.url, name = piPackage): string {
  const roots = createRequire(from).resolve.paths(name) ?? [];
  // probe only this module's dependency resolution paths
  for (const directory of roots) {
    const root = join(directory, name);
    try { readFileSync(join(root, 'package.json')); return root; } catch { /* try the next resolution path */ }
  }
  throw new Error(`${name} is not installed`);
}

type HostPiRuntime = { node: string; cli: string; extension: string; holder: string; command: string; fingerprint: string };
type RuntimeSources = { modules: string; packageRoot: (name: string) => string };

// execute the configured Node on the host, never inside the container namespace
export async function verifyHostPiNode(node: string, env: NodeJS.ProcessEnv = process.env, command: typeof run = run, writeRoots: readonly string[] = []): Promise<string> {
  // quote trusted configuration before passing it through the host shell
  const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
  // never guess the home used by an authored write root
  if (env.HOME === undefined && writeRoots.some(root => root === '~' || root.startsWith('~/'))) throw new Error('Pi host bridge requires HOME to resolve writable roots');
  // resolve home-relative roots exactly as the host Pi policy does
  const roots = writeRoots.map(root => root === '~' ? env.HOME! : root.startsWith('~/') ? join(env.HOME!, root.slice(2)) : root);
  // glob write roots cannot prove an immutable executable boundary
  if (roots.some(root => /[*?\[]/u.test(root))) throw new Error('Pi host bridge requires non-glob writable roots around its Node runtime');
  const inspect = `set -eu
node=$(/usr/bin/readlink -e -- ${quote(node)})
test "$(/usr/bin/stat -Lc '%h' -- "$node")" = 1
# canonicalize each writable root before any Node execution
for root in ${roots.map(quote).join(' ')}; do
  root=$(/usr/bin/realpath -m -- "$root")
  test "$root" != /
  case "$node" in "$root"|"$root"/*) exit 125;; esac
done
digest=$(/usr/bin/sha256sum -- "$node")
printf '%s\\n%.64s\\n' "$node" "$digest"
exec "$node" -p 'process.versions.node'`;
  const result = await command(env.RAC_TMUX_BIN ?? '/usr/bin/tmux', ['-S', join(env.RAC_HOST_TMUX_DIR!, 'default'), 'run-shell', tmuxFormatLiteral(inspect)], undefined, 5_000);
  const [canonical, digest, observed] = result.stdout.trim().split('\n');
  const version = /^(\d+)\.(\d+)\.(\d+)$/u.exec(observed ?? '');
  // reject hard-link aliases and writable canonical targets before executing any Node code
  if (result.code !== 0 || canonical === undefined || !isAbsolute(canonical) || !/^[a-f0-9]{64}$/u.test(digest ?? '') || version === null || Number(version[1]) < 22 || Number(version[1]) === 22 && Number(version[2]) < 19) throw new Error(`Pi host bridge requires single-link Node.js >=22.19.0 outside writable Places and sandbox roots (observed ${version?.[0] ?? 'unavailable'}; exit ${result.code}${result.timedOut === true ? ', timed out' : ''}: ${`${result.stdout}${result.stderr}`.trim().slice(-500)})`);
  return createHash('sha256').update(JSON.stringify([canonical, digest, observed])).digest('hex');
}

// refuse incomplete or stale host runtimes rather than bypass the bridge's sandbox
export function hostPiRuntime(env: NodeJS.ProcessEnv = process.env, sources?: RuntimeSources): HostPiRuntime | undefined {
  // native launches continue using the server's own runtime
  if (env.RAC_HOST_TMUX_DIR === undefined) return undefined;
  const node = env.RAC_HOST_NODE_BIN?.trim();
  const repo = env.RAC_HOST_REPOSITORY?.trim();
  const state = env.PI_CODING_AGENT_DIR?.trim();
  // these paths must have the same absolute spelling on both sides of the bridge
  if (node === undefined || !isAbsolute(node) || repo === undefined || !isAbsolute(repo) || state === undefined || !isAbsolute(state)) throw new Error('Pi host bridge requires absolute RAC_HOST_NODE_BIN, RAC_HOST_REPOSITORY and same-path PI_CODING_AGENT_DIR');
  const local = sources ?? { modules: fileURLToPath(new URL('../', import.meta.url)), packageRoot: (name: string) => piPackageRoot(import.meta.url, name) };
  const hostModules = join(repo, 'apps/server/dist');
  const hostPackage = (name: string) => piPackageRoot(join(repo, 'apps/server/package.json'), name);
  const fingerprint = createHash('sha256').update(JSON.stringify([node, repo, state]));
  // the host copy must match every pinned dependency the sandbox extension uses
  for (const name of dependencies) {
    // read only package metadata when proving the installed pin
    const version = (root: string) => (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version;
    // never silently switch a bridged Pi to a different installed dependency
    if (version(local.packageRoot(name)) !== version(hostPackage(name))) throw new Error(`Pi host bridge dependency mismatch: ${name}; run pnpm install --frozen-lockfile on the host`);
    fingerprint.update(name).update(version(hostPackage(name)));
  }
  // compare the complete helper import closure with this console's compiled build
  for (const name of runtimeFiles) {
    let matches = false;
    try { matches = readFileSync(join(local.modules, name)).equals(readFileSync(join(hostModules, name))); } catch { /* an absent build is not runnable */ }
    // every helper must match before a host process gets console access
    if (!matches) throw new Error(`Pi host bridge build mismatch: ${name}; build @rac/server on the host from the deployed revision`);
    fingerprint.update(name).update(readFileSync(join(hostModules, name)));
  }
  return { node, cli: join(hostPackage(piPackage), 'dist/bundle/cli.js'), extension: join(hostModules, 'adapters/pi-extension.js'), holder: join(hostModules, 'transports/holder.js'), command: join(hostModules, 'watches/sandboxed-command.js'), fingerprint: fingerprint.digest('hex') };
}
