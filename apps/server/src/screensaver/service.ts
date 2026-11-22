import { stripAnsi } from '../adapters/capture-text.js';
import type { TerminalColorRange } from '../adapters/terminal-preview.js';
import type { Agent } from '../domain/models.js';
import type { PromptService, TurnTransport } from '../prompts/service.js';
import { screensaverShowsOutput, screensaverTailRows } from './contracts.js';
import { screensaverPreviewMode, screensaverPreviewPublication, type ScreensaverPreviewPublication } from './identity.js';

type ScreensaverAgentContent = {
  identity: string;
  kind: 'output' | 'response';
  text: string;
  available: boolean;
  colors?: TerminalColorRange[];
  truncated?: boolean;
};

type ScreensaverContentDependencies = {
  prompts: Pick<PromptService, 'transportFor'>;
  currentPublication?: (agentId: string) => ScreensaverPreviewPublication | undefined;
};

const maxContentBytes = 64 * 1024;

// keep only the newest complete UTF-8 suffix
const limitNewestText = (value: string, maxBytes: number): { text: string; truncated: boolean } => {
  const serialized = Buffer.from(value);
  // retain complete bounded values
  if (serialized.byteLength <= maxBytes) return { text: value, truncated: false };
  let start = serialized.byteLength - maxBytes;
  // skip any partial leading sequence
  while (start < serialized.byteLength && (serialized[start]! & 0xc0) === 0x80) start += 1;
  return { text: serialized.subarray(start).toString('utf8'), truncated: true };
};

// return bounded read-only content for one current Agent
export class ScreensaverContentService {
  // bind transport-neutral Agent reads
  constructor(private readonly dependencies: ScreensaverContentDependencies) {}

  // select live output only while the Agent is actively working
  async read(agentId: string, expectedIdentity: string): Promise<ScreensaverAgentContent | undefined> {
    const transport = await this.dependencies.prompts.transportFor(agentId);
    const agent = await transport.target(agentId).then(target => target?.agent).catch(() => undefined);
    const publication = this.dependencies.currentPublication === undefined
      ? agent === undefined ? undefined : screensaverPreviewPublication(agent, screensaverShowsOutput(agent) ? 'output' : 'response')
      : this.dependencies.currentPublication(agentId);
    // keep departed Agents distinct from temporarily unavailable content
    const mode = agent === undefined || publication === undefined ? undefined : screensaverPreviewMode(agent, publication.runtimeIdentity);
    if (agent === undefined || publication === undefined || mode !== publication.mode || publication.identity !== expectedIdentity) return undefined;
    const content = mode === 'output'
      ? await this.output(transport, agent, publication.runtimeIdentity)
      : await this.response(transport, agent, publication.runtimeIdentity);
    const current = await transport.target(agentId).then(target => target?.agent).catch(() => undefined);
    const currentPublication = this.dependencies.currentPublication === undefined
      ? current === undefined ? undefined : screensaverPreviewPublication(current, screensaverShowsOutput(current) ? 'output' : 'response')
      : this.dependencies.currentPublication(agentId);
    // discard bytes captured after a pane, conversation, or display mode handoff
    if (current === undefined || currentPublication?.identity !== expectedIdentity || currentPublication.runtimeIdentity !== publication.runtimeIdentity || screensaverPreviewMode(current, currentPublication.runtimeIdentity) !== mode) return undefined;
    return { identity: expectedIdentity, ...content };
  }

  // prefer a text preview over an interactive terminal frame
  private async output(transport: Pick<TurnTransport, 'previewOutput'>, agent: Pick<Agent, 'id'>, expectedIdentity: string): Promise<Omit<ScreensaverAgentContent, 'identity'>> {
    // transports without an adapter-owned safe boundary cannot expose raw panes
    const captured = await transport.previewOutput?.(agent.id, screensaverTailRows, expectedIdentity).catch(() => undefined);
    // represent a transient capture failure without stale content
    if (captured === undefined) return { kind: 'output', text: '', available: false };
    const limited = limitNewestText(captured.text, maxContentBytes);
    const cut = captured.text.length - limited.text.length;
    // keep range coordinates relative to the visible UTF-8 suffix
    const colors = captured.colors?.flatMap(range => range.to <= cut ? [] : [{ ...range, from: Math.max(0, range.from - cut), to: range.to - cut }]);
    return { kind: 'output', text: limited.text, available: true, ...(colors?.length ? { colors } : {}), ...(limited.truncated ? { truncated: true } : {}) };
  }

  // only accept an answer bound to the transport's current conversation
  private async response(transport: Pick<TurnTransport, 'previewAnswer'>, agent: Pick<Agent, 'id'>, expectedIdentity: string): Promise<Omit<ScreensaverAgentContent, 'identity'>> {
    const answer = await transport.previewAnswer?.(agent.id, expectedIdentity).catch(() => undefined);
    const text = answer === undefined ? '' : stripAnsi(answer);
    // a missing reply must not fall back to another conversation's pane scrollback or history
    if (!text.trim()) return { kind: 'response', text: '', available: false };
    const limited = limitNewestText(text, maxContentBytes);
    return { kind: 'response', text: limited.text, available: true, ...(limited.truncated ? { truncated: true } : {}) };
  }
}
