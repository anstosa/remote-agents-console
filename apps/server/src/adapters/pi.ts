import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { piClient, piEfforts } from '../transports/pi.js';
import { locatePiSession, piConversationName, piConversationSummaries, validPiSessionId } from './pi-conversations.js';
import { staticPolicy } from './pi-sandbox.js';
import type { StructuredAdapter } from './types.js';

const piPackage = '@earendil-works/pi-coding-agent';

/**
 * The pinned Pi's CLI from the server's own dependencies (ADR 0017). The package exports no
 * `package.json` and no CommonJS entry to resolve, so its directory is found on the module paths.
 */
function piRoot(): string {
  const roots = createRequire(import.meta.url).resolve.paths(piPackage) ?? [];
  const root = roots.map(directory => join(directory, piPackage)).find(directory => existsSync(join(directory, 'package.json')));
  if (root === undefined) throw new Error(`${piPackage} is not installed`);
  return root;
}
const piProgram = (): string => join(piRoot(), 'dist', 'bundle', 'cli.js');
// the pinned Pi's package and version, read once
let pinnedVersion: string | undefined;
const piPinned = (): { package: string; version: string } | undefined => {
  try { pinnedVersion ??= (JSON.parse(readFileSync(join(piRoot(), 'package.json'), 'utf8')) as { version?: unknown }).version as string; } catch { return undefined; }
  return typeof pinnedVersion === 'string' ? { package: piPackage, version: pinnedVersion } : undefined;
};

// the RAC Pi extension beside this module, compiled in a build, its source otherwise (Pi loads both)
const extension = (): string => {
  const compiled = fileURLToPath(new URL('./pi-extension.js', import.meta.url));
  return existsSync(compiled) ? compiled : compiled.replace(/\.js$/u, '.ts');
};

// the tools declared to the model: Pi's defaults, the search tools the path policy covers, and the
// RAC extension's `ask_user`
const tools = 'read,bash,edit,write,grep,find,ls,ask_user';
// a Worktree's own skills and prompt templates, passed explicitly because `--no-approve` keeps
// every other trust-gated `.pi/` resource (settings, extensions, MCP servers) out
const projectResources = (cwd: string): string[] => [['--skill', '.pi/skills'], ['--skill', '.agents/skills'], ['--prompt-template', '.pi/prompts']]
  .flatMap(([flag, path]) => existsSync(join(cwd, path!)) ? [flag!, join(cwd, path!)] : []);

/**
 * The Pi Adapter: structured-only (ADR 0002 amendment). Pi is never recognised in a pane, so it
 * has no `recognizes` match and no pane members; the console drives `pi --mode rpc` through the
 * Pi client, with the RAC extension always loaded. Its program is the console's own Node, which
 * runs the pinned CLI. A resume names the session file (or continues the latest) and no model,
 * since `--model` would override the model the Conversation was on.
 *
 * RAC's Pi loads only what the console vets (ADR 0004 amendment): `-ne` drops the operator's
 * extensions, packages and Pi's built-ins (so no `mcp.json` server starts), `--offline` stops
 * startup package installs and downloads, and `--no-approve` skips the Worktree's `.pi/` settings.
 * A Sandboxed launch points the extension at the rendered `sandbox.json` (an empty path fails
 * it closed); the extension adds the Pi state directory, the Worktree and its git directory.
 */
export const piAdapter = {
  kind: 'pi',
  launch: ({ cwd, sandboxed, files, nonce = '', resume, continue: latest, models }) => ({
    args: [
      piProgram(), '--mode', 'rpc', '-ne', '-e', extension(), '--offline', '--no-approve', '--tools', tools, ...projectResources(cwd),
      ...(models === undefined || models.allowed.length === 0 ? [] : ['--models', models.allowed.join(',')]),
      ...(resume !== undefined ? ['--session', resume] : latest === true ? ['--continue'] : models?.start === undefined ? [] : ['--model', models.start.model, ...(models.start.effort === undefined ? [] : ['--thinking', models.start.effort])])
    ],
    env: { RAC_LAUNCH_NONCE: nonce, ...(sandboxed ? { RAC_SANDBOX_POLICY: files?.['sandbox.json'] ?? '' } : {}) }
  }),
  client: piClient,
  steers: true,
  pinned: piPinned,
  efforts: piEfforts,
  conversations: { validId: validPiSessionId, list: piConversationSummaries, readName: piConversationName, locate: locatePiSession },
  sandbox: true,
  // the static policy: the kind's sandbox lists as the sandbox runtime takes them (none: no
  // network, no writes beyond what the extension adds), and the extra environment names commands get
  files: ({ sandbox: settings = { allowedDomains: [], deniedDomains: [], allowWrite: [], denyWrite: [], denyRead: [], env: [] } }) => ({ 'sandbox.json': JSON.stringify(staticPolicy(settings), null, 2) })
} satisfies StructuredAdapter;
