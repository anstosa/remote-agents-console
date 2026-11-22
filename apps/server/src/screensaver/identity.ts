import { createHash } from 'node:crypto';
import type { Agent } from '../domain/models.js';

export type ScreensaverPreviewMode = 'output' | 'response';
export type ScreensaverPreviewPublication = { identity: string; runtimeIdentity: string; mode: ScreensaverPreviewMode };

// bind the browser token to its published Place and display mode
export const screensaverPreviewIdentity = (agent: Pick<Agent, 'id' | 'transport' | 'placeId' | 'pane' | 'recoveryProcessKey' | 'conversationId'>, mode: ScreensaverPreviewMode): string => createHash('sha256').update(JSON.stringify([
  agent.id,
  agent.transport,
  agent.placeId ?? null,
  agent.pane?.socketFingerprint ?? null,
  agent.pane?.paneId ?? null,
  agent.recoveryProcessKey ?? null,
  agent.conversationId ?? null,
  mode
])).digest('base64url');

// bind transport reads only to runtime evidence available on the raw target
export const screensaverRuntimeIdentity = (agent: Pick<Agent, 'id' | 'transport' | 'pane' | 'recoveryProcessKey' | 'conversationId'>, mode: ScreensaverPreviewMode): string => createHash('sha256').update(JSON.stringify([
  agent.id,
  agent.transport,
  agent.pane?.socketFingerprint ?? null,
  agent.pane?.paneId ?? null,
  agent.recoveryProcessKey ?? null,
  agent.conversationId ?? null,
  mode
])).digest('base64url');

// issue one browser token and its raw runtime proof together
export const screensaverPreviewPublication = (agent: Pick<Agent, 'id' | 'transport' | 'placeId' | 'pane' | 'recoveryProcessKey' | 'conversationId'>, mode: ScreensaverPreviewMode): ScreensaverPreviewPublication => ({
  identity: screensaverPreviewIdentity(agent, mode),
  runtimeIdentity: screensaverRuntimeIdentity(agent, mode),
  mode
});

// recover the server-issued mode without trusting unenriched target attention
export const screensaverPreviewMode = (agent: Pick<Agent, 'id' | 'transport' | 'pane' | 'recoveryProcessKey' | 'conversationId'>, identity: string): ScreensaverPreviewMode | undefined => {
  if (screensaverRuntimeIdentity(agent, 'output') === identity) return 'output';
  if (screensaverRuntimeIdentity(agent, 'response') === identity) return 'response';
  return undefined;
};
