import { execFile } from 'node:child_process';
import { constants, existsSync } from 'node:fs';
import { access, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { consoleRepositoryRoot, hostVisibleRepoRoot } from '../adapters/files.js';
import { resolveHostNodeBin } from '../host-files/broker.js';
import { run } from '../tmux/command.js';
import { environmentFallback } from './catalog.js';
import type { Installation, SettingsFallback } from './contracts.js';
import { atPath } from './patches.js';

export type PlaceholderRuntime = { hostNode?: string; hostPath?: string; timeZone?: string };
export type EnvironmentFallbackContext = { application: unknown; environment: Record<string, string>; running?: NodeJS.ProcessEnv; installation?: Installation; configPath?: string; checkout?: string; home?: string; cwd?: string; runtime?: PlaceholderRuntime };
const executeFile = promisify(execFile);

// inspect PATH without executing an arbitrary local executable
async function localNode(path: string): Promise<string | undefined> {
  // resolve only absolute search entries in the process namespace
  for (const directory of path.split(':')) {
    // relative paths cannot prove an executable outside the current directory
    if (!isAbsolute(directory)) continue;
    const candidate = join(directory, 'node');
    try { await access(candidate, constants.X_OK); return await realpath(candidate); } catch { /* try the next PATH entry */ }
  }
  return undefined;
}

// inspect only fixed runtime commands without launching a session or using drafts
export async function readPlaceholderRuntime(env: NodeJS.ProcessEnv = process.env, containerized = existsSync('/.dockerenv')): Promise<PlaceholderRuntime> {
  const socketDirectory = env.RAC_HOST_TMUX_DIR;
  const socket = socketDirectory === undefined ? undefined : join(socketDirectory, 'default');
  const explicitPath = env.RAC_HOST_PATH?.trim();
  const bridged = containerized || env.RAC_HOST_PROC !== undefined;
  const tmux = env.RAC_TMUX_BIN ?? '/usr/bin/tmux';
  // omitting RAC_HOST_PATH inherits tmux PATH rather than its own configured override
  const hostPath = socket === undefined ? bridged ? undefined : env.PATH : await run(tmux, ['-S', socket, 'show-environment', '-g', 'PATH'], undefined, 1_500).then(result => result.code === 0 && result.stdout.startsWith('PATH=') ? result.stdout.slice(5).trim() : undefined).catch(() => undefined);
  const hostNode = socket === undefined
    ? bridged ? undefined : await localNode(hostPath ?? '')
    : await resolveHostNodeBin({ hostNodeBin: '', hostPath: explicitPath, tmuxBinary: tmux, hostTmuxSocket: socket, startupTimeoutMs: 1_500 }).catch(() => undefined);
  // omit TZ in a fresh process so an explicit override cannot disguise the host default
  const timeZone = await executeFile(process.execPath, ['-p', 'Intl.DateTimeFormat().resolvedOptions().timeZone'], { env: {}, timeout: 1_500, maxBuffer: 4_096 }).then(result => result.stdout.trim() || undefined).catch(() => undefined);
  return { hostNode, hostPath, timeZone };
}

// keep values first and provenance strictly display-only
function from(value: string | number | undefined, source: string, absent = 'Unavailable'): SettingsFallback {
  return { value: `${value === undefined ? absent : value === '' ? 'Empty' : value} (from ${source})`, kind: 'derived' };
}

// resolve omission defaults from their actual owning source rather than symbolic labels
export function resolvedEnvironmentFallback(key: string, context: EnvironmentFallbackContext): SettingsFallback | undefined {
  const catalogued = environmentFallback(key, context.installation?.kind);
  // custom settings have no application-owned default
  if (catalogued === undefined) return undefined;
  const running = context.running ?? process.env;
  const home = context.home ?? homedir();
  const checkout = context.checkout ?? consoleRepositoryRoot();
  const cwd = context.cwd ?? process.cwd();
  // resolve only strings and numbers rather than serializing protected markers
  const application = (path: string[]): string | number | undefined => {
    const value = atPath(context.application, path);
    return typeof value === 'string' || typeof value === 'number' ? value : undefined;
  };
  // dependencies may be pending in the saved environment file
  const dependency = (name: string): string | undefined => context.environment[name] ?? running[name];
  const uid = dependency('RAC_HOST_UID') ?? String(process.getuid?.() ?? 0);
  // match the independently defined omission contract for each derived value
  switch (key) {
    case 'RAC_INSTANCE_STATUS_SECRET': return from('Hidden', 'RAC_SESSION_SECRET');
    case 'RAC_INTEGRATION_FEDERATION_SECRET': return from('Hidden', dependency('RAC_INSTANCE_STATUS_SECRET') ? 'RAC_INSTANCE_STATUS_SECRET' : 'RAC_SESSION_SECRET');
    case 'RAC_REALTIME_MCP_TOKEN': return from('Hidden', 'RAC_SESSION_SECRET');
    case 'RAC_GITHUB_TOKEN': return from('Hidden', 'GitHub CLI credentials');
    case 'RAC_CONFIG': return context.installation?.kind === 'compose' ? from(running.RAC_CONFIG ?? context.installation.sources.app?.serverPath, 'Compose environment') : catalogued;
    case 'RAC_CONFIG_WRITE_PATH': return from(dependency('RAC_CONFIG') ?? context.configPath ?? context.installation?.sources.app?.serverPath, 'RAC_CONFIG');
    case 'RAC_LISTEN_HOST': return from(application(['listen', 'host']) ?? '127.0.0.1', application(['listen', 'host']) === undefined ? 'built-in default' : 'Application Listen Host');
    case 'RAC_LISTEN_PORT': return from(application(['listen', 'port']) ?? 8787, application(['listen', 'port']) === undefined ? 'built-in default' : 'Application Listen Port');
    case 'TZ': return from(context.runtime?.timeZone, 'host time zone');
    case 'RAC_CODEX_BIN':
    case 'RAC_HOST_CODEX_BIN': return from(application(['adapters', 'codex', 'program']) as string | undefined, 'Application Codex Program', 'Not configured');
    case 'RAC_CLAUDE_BIN': return from(application(['adapters', 'claude', 'program']) as string | undefined, 'Application Claude Program', 'Not configured');
    case 'RAC_CLAUDE_CONFIG_DIR': return from(dependency('CLAUDE_CONFIG_DIR') ?? join(home, '.claude'), dependency('CLAUDE_CONFIG_DIR') === undefined ? 'HOME' : 'CLAUDE_CONFIG_DIR');
    case 'RAC_GH_HOSTS': return from(join(home, '.config/gh/hosts.yml'), 'server account home');
    case 'RAC_ADAPTER_FILES_DIR': {
      const root = hostVisibleRepoRoot({ ...running, RAC_HOST_REPOSITORY: dependency('RAC_HOST_REPOSITORY') });
      return from(root === undefined ? undefined : join(root, '.data/adapters'), 'RAC checkout');
    }
    case 'RAC_SERVER_CHECKOUT': return from(consoleRepositoryRoot(), 'server installation');
    case 'RAC_SERVER_ADMIN_STATUS_DIR': return from(join(checkout, '.data'), 'RAC checkout');
    case 'RAC_TEMP_PREVIEW_ORIGIN': return from(application(['publicOrigin']) as string | undefined, 'Application Public Origin');
    case 'RAC_HOST_PROC': return from('/proc', 'built-in discovery default');
    case 'RAC_HOST_TMUX_DIR': return from(running.RAC_HOST_TMUX_DIR, running.RAC_HOST_TMUX_DIR === undefined ? 'native socket discovery' : 'running host socket mount', 'Not mounted');
    case 'RAC_HOST_TMUX_SOURCE': return from(`/tmp/tmux-${uid}`, dependency('RAC_HOST_UID') === undefined ? 'process UID' : 'RAC_HOST_UID');
    case 'RAC_HOST_UNIX_SOCKETS': return from(join(dependency('RAC_HOST_PROC') ?? '/proc', 'net/unix'), dependency('RAC_HOST_PROC') === undefined ? 'built-in discovery default' : 'RAC_HOST_PROC');
    case 'RAC_HOST_UID': return from(process.getuid?.(), 'process UID; host Files requires an explicit UID');
    case 'RAC_HOST_NODE_BIN': return from(context.runtime?.hostNode, 'host PATH');
    case 'RAC_HOST_INTERACTIVE_SHELL': return from(dependency('RAC_INTERACTIVE_SHELL')?.trim() || '/usr/bin/zsh', dependency('RAC_INTERACTIVE_SHELL')?.trim() ? 'RAC_INTERACTIVE_SHELL' : 'built-in default');
    case 'RAC_HOST_PATH': return from(context.runtime?.hostPath, 'host tmux PATH');
    case 'RAC_HOST_REPOSITORY': return from(running.RAC_HOST_TMUX_DIR === undefined ? consoleRepositoryRoot() : undefined, 'RAC checkout', 'Not configured');
    case 'RAC_HOST_WORKSPACE': {
      const projects = atPath(context.application, ['projects']);
      const project = Array.isArray(projects) ? projects.find(candidate => candidate?.path === checkout) as Record<string, unknown> | undefined : undefined;
      const path = project?.hostPath ?? project?.path;
      return from(typeof path === 'string' ? path : undefined, 'Project Host Path / Path', 'Not mapped');
    }
    case 'HOST_UID': return from(1000, 'Docker bridge default');
    case 'HOST_TMUX_DIR': return from(running.RAC_HOST_TMUX_SOURCE, running.RAC_HOST_TMUX_SOURCE === undefined ? 'host HOME' : 'running host socket source');
    case 'HOST_TMUX_BIN': return from('/usr/bin/tmux', 'Docker bridge default');
    case 'RAC_FILE_FAVORITES_FILE': return from(join(checkout, '.data/file-favorites.json'), 'RAC checkout');
    case 'RAC_FILE_OPERATION_JOURNAL': return from(join(checkout, '.data/file-operation-journal.json'), 'RAC checkout');
    case 'COMPOSE_FILE': return from(context.installation?.compose?.files.join(':'), 'current installation');
    case 'COMPOSE_ENV_FILES': return from(context.installation?.compose?.envFiles.join(','), 'current installation');
    case 'COMPOSE_PROJECT_NAME': return from(context.installation?.compose?.projectName, 'current installation');
    case 'COMPOSE_PROFILES': return from(context.installation?.compose?.profiles.join(',') || 'None', 'current installation');
    case 'NODE_BIN': return from(process.execPath, 'server runtime');
    case 'RAC_ENV_FILE': return from(context.installation?.sources.env?.path, 'current installation');
  }
  // retain honest no-value states rather than fabricating an effective value
  if (catalogued.kind === 'derived') return catalogued;
  const value = catalogued.value.startsWith('.data/') ? resolve(cwd, catalogued.value) : catalogued.value;
  return { value: `${value} (from built-in default)`, kind: 'literal' };
}
