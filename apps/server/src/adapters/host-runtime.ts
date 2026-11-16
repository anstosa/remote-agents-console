import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, tmuxFormatLiteral } from '../tmux/command.js';

export type HostHolderRuntime = { node: string; holder: string; modules: string; fingerprint: string };
export type HostRuntimeSources = { modules: string };

const holderFile = 'transports/holder.js';

// verify one configured node through the host tmux namespace
async function verifyNode(node: string, env: NodeJS.ProcessEnv, command: typeof run, writeRoots: readonly string[], label: string): Promise<string> {
  // quote trusted configuration before passing it through the host shell
  const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
  // never guess the home used by an authored write root
  if (env.HOME === undefined && writeRoots.some(root => root === '~' || root.startsWith('~/'))) throw new Error(`${label} requires HOME to resolve writable roots`);
  // resolve home-relative roots exactly as the host policy does
  const roots = writeRoots.map(root => root === '~' ? env.HOME! : root.startsWith('~/') ? join(env.HOME!, root.slice(2)) : root);
  // glob write roots cannot prove an immutable executable boundary
  if (roots.some(root => /[*?\[]/u.test(root))) throw new Error(`${label} requires non-glob writable roots around its Node runtime`);
  const inspect = `set -eu
node=$(/usr/bin/readlink -e -- ${quote(node)})
test "$(/usr/bin/stat -Lc '%h' -- "$node")" = 1
# canonicalize each writable root before any node execution
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
  // reject hard-link aliases and writable canonical targets before executing any node code
  if (result.code !== 0 || canonical === undefined || !isAbsolute(canonical) || !/^[a-f0-9]{64}$/u.test(digest ?? '') || version === null || Number(version[1]) < 22 || Number(version[1]) === 22 && Number(version[2]) < 19) throw new Error(`${label} requires single-link Node.js >=22.19.0 outside writable Places and sandbox roots (observed ${version?.[0] ?? 'unavailable'}; exit ${result.code}${result.timedOut === true ? ', timed out' : ''}: ${`${result.stdout}${result.stderr}`.trim().slice(-500)})`);
  return createHash('sha256').update(JSON.stringify([canonical, digest, observed])).digest('hex');
}

// verify a generic host node without any adapter dependency
export async function verifyHostNode(node: string, env: NodeJS.ProcessEnv = process.env, command: typeof run = run, writeRoots: readonly string[] = []): Promise<string> {
  return await verifyNode(node, env, command, writeRoots, 'Host bridge');
}

// preserve pi's existing diagnostics and verification contract
export async function verifyHostPiNode(node: string, env: NodeJS.ProcessEnv = process.env, command: typeof run = run, writeRoots: readonly string[] = []): Promise<string> {
  return await verifyNode(node, env, command, writeRoots, 'Pi host bridge');
}

// prove the generic holder and requested helper closure match the deployed host build
export function hostHolderRuntime(env: NodeJS.ProcessEnv = process.env, sources?: HostRuntimeSources, additionalFiles: readonly string[] = []): HostHolderRuntime | undefined {
  // native launches continue using the server's own runtime
  if (env.RAC_HOST_TMUX_DIR === undefined) return undefined;
  const node = env.RAC_HOST_NODE_BIN?.trim();
  const repo = env.RAC_HOST_REPOSITORY?.trim();
  // bridge paths must have the same absolute spelling in both namespaces
  if (node === undefined || !isAbsolute(node) || repo === undefined || !isAbsolute(repo)) throw new Error('Host bridge requires absolute RAC_HOST_NODE_BIN and RAC_HOST_REPOSITORY');
  const localModules = sources?.modules ?? fileURLToPath(new URL('../', import.meta.url));
  const hostModules = join(repo, 'apps/server/dist');
  const files = [holderFile, ...additionalFiles];
  const fingerprint = createHash('sha256').update(JSON.stringify([node, repo]));
  // compare every unique, module-relative helper with the local compiled build
  for (const name of new Set(files)) {
    const normalized = relative('.', name);
    // helper paths cannot escape either deployed module root
    if (isAbsolute(name) || normalized === '..' || normalized.startsWith('../')) throw new Error(`Host bridge helper path is not module-relative: ${name}`);
    let local: Buffer | undefined;
    let host: Buffer | undefined;
    try {
      local = readFileSync(join(localModules, normalized));
      host = readFileSync(join(hostModules, normalized));
    } catch { /* an absent build is not runnable */ }
    // every helper must match before a host process gets console access
    if (local === undefined || host === undefined || !local.equals(host)) throw new Error(`Host bridge build mismatch: ${normalized}; build @rac/server on the host from the deployed revision`);
    fingerprint.update(normalized).update(host);
  }
  return { node, holder: join(hostModules, holderFile), modules: hostModules, fingerprint: fingerprint.digest('hex') };
}
