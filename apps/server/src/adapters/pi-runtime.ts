import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gte, valid } from 'semver';
import { hostHolderRuntime, verifyHostPiNode } from './host-runtime.js';

export { verifyHostPiNode } from './host-runtime.js';

const piPackage = '@earendil-works/pi-coding-agent';
const runtimeFiles = ['adapters/pi-extension.js', 'adapters/ask-user.js', 'adapters/conductor-role.js', 'adapters/pi-sandbox.js', 'git/overrides.js', 'transports/holder.js', 'watches/sandboxed-command.js'];
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

// compare an installed dependency with its bundled minimum
const meetsMinimumVersion = (installed: unknown, minimum: unknown): installed is string => typeof installed === 'string' && typeof minimum === 'string' && valid(installed) !== null && valid(minimum) !== null && gte(installed, minimum);

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
  // the host copy must meet every dependency minimum the sandbox extension uses
  for (const name of dependencies) {
    // read only package metadata when proving the installed version
    const version = (root: string): unknown => (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: unknown }).version;
    const minimum = version(local.packageRoot(name));
    const installed = version(hostPackage(name));
    // never run a bridged Pi below the console's dependency minimum
    if (!meetsMinimumVersion(installed, minimum)) throw new Error(`Pi host bridge dependency mismatch: ${name}; the host must install at least the bundled version`);
    fingerprint.update(name).update(installed);
  }
  // compare the complete helper import closure with this console's compiled build
  for (const name of runtimeFiles) {
    let matches = false;
    try { matches = readFileSync(join(local.modules, name)).equals(readFileSync(join(hostModules, name))); } catch { /* an absent build is not runnable */ }
    // every helper must match before a host process gets console access
    if (!matches) throw new Error(`Pi host bridge build mismatch: ${name}; build @rac/server on the host from the deployed revision`);
    fingerprint.update(name).update(readFileSync(join(hostModules, name)));
  }
  // reuse only the generic holder proof after every pi-specific check
  const holderRuntime = hostHolderRuntime(env, { modules: local.modules }, runtimeFiles.filter(name => name !== 'transports/holder.js'))!;
  return { node, cli: join(hostPackage(piPackage), 'dist/bundle/cli.js'), extension: join(hostModules, 'adapters/pi-extension.js'), holder: holderRuntime.holder, command: join(hostModules, 'watches/sandboxed-command.js'), fingerprint: fingerprint.digest('hex') };
}
