import { inheritedHomeEnvironment } from '../places/launch-home.js';
import { claudeConfigDir } from './claude-conversations.js';
import { codexHome } from './codex-conversations.js';
import { piAgentDir } from './pi-conversations.js';
import type { AgentKind } from './types.js';

const stores: Partial<Record<AgentKind, { selectors: readonly [string, ...string[]]; directory: (env: NodeJS.ProcessEnv) => string }>> = {
  codex: { selectors: ['CODEX_HOME'], directory: codexHome },
  omx: { selectors: ['CODEX_HOME'], directory: codexHome },
  claude: { selectors: ['RAC_CLAUDE_CONFIG_DIR', 'CLAUDE_CONFIG_DIR'], directory: claudeConfigDir },
  pi: { selectors: ['PI_CODING_AGENT_DIR'], directory: piAgentDir },
};

// resolve the current launch profile's readable store, never another conversation's credentials
export function conversationEnvironment(kind: AgentKind, configured: Record<string, string> = {}, home?: string, defaultHome?: string, observer: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment = inheritedHomeEnvironment(configured, home ?? defaultHome ?? observer.HOME);
  // the host Pi runtime owns its same-path state selector
  if (kind === 'pi' && observer.RAC_HOST_TMUX_DIR !== undefined && observer.PI_CODING_AGENT_DIR !== undefined) {
    return { ...environment, PI_CODING_AGENT_DIR: observer.PI_CODING_AGENT_DIR };
  }
  const store = stores[kind];
  const standardHome = defaultHome ?? observer.HOME;
  // only the bridged default profile has an installation-provided observer mapping
  if (observer.RAC_HOST_TMUX_DIR === undefined || store === undefined || store.selectors.some(selector => configured[selector] !== undefined) || environment.HOME !== standardHome) return environment;
  // the default profile may be mounted at a different path in the observing container
  return { ...environment, [store.selectors[0]]: store.directory(observer) };
}
