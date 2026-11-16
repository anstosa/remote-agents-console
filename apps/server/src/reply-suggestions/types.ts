import type { ModelSetting } from '../transports/structured.js';

/** one current-conversation message safe to copy into suggestion inference */
export type ReplySuggestionMessage = { id: string; role: 'user' | 'assistant'; text: string };

/** shared immutable conversation identity, never exposed to the browser */
export type ReplySuggestionSourceBase = {
  agentId: string;
  identity: string;
  sourceGeneration: number;
  processGeneration: number;
  runtimeGeneration: string;
  conversationId: string;
  model: ModelSetting;
  messages: readonly ReplySuggestionMessage[];
};

/** the existing managed pi source retains its exact physical route */
export type PiReplySuggestionSource = ReplySuggestionSourceBase & {
  kind: 'pi';
  transport: 'structured';
  nativeModel: { provider: string; id: string; api: string; baseUrl: string };
};

/** one native process and its own nonsecret login/profile selection */
export type NativeReplyScope = {
  kind: 'codex' | 'claude';
  program: string;
  home: string;
  configDir: string;
  process: { pid: number; startTime: string };
  fingerprint: string;
};

/** native cli mechanics stay private and cannot be selected by api callers */
export type NativeReplySuggestionSource = ReplySuggestionSourceBase & {
  kind: 'codex' | 'omx' | 'claude';
  transport: 'tmux' | 'structured';
  nativeModel: { provider: 'openai' | 'anthropic'; id: string };
  nativeScope: NativeReplyScope;
};

/** exhaustive vendor routing prevents cross-account or pi fallback */
export type ReplySuggestionSource = PiReplySuggestionSource | NativeReplySuggestionSource;
