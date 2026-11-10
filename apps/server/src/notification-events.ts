import { createHash } from 'node:crypto';

type NotificationEventKind = 'question' | 'finished';
export type NotificationState = { eventEpoch: string; eventSequence: number };
export type NotificationEvent = {
  schemaVersion: 1;
  eventId: string;
  eventEpoch: string;
  eventSequence: number;
  entityId: string;
  generatedAt: number;
  kind: NotificationEventKind;
  agentId: string;
  tag: string;
  displayTag: string;
  url: string;
  worktreeId?: string;
};

const noControls = /^[^\u0000-\u001f\u007f]*$/u;
const safeEventId = /^[A-Za-z0-9._:-]{1,128}$/u;

// derive a bounded opaque suffix without exposing alert content
const identifierDigest = (value: string): string => createHash('sha256').update(value).digest('base64url').slice(0, 32);

// preserve ordinary agent ids while bounding malformed or oversized values
export function agentLogicalTag(agentId: string): string {
  const tag = `agent-status-${agentId}`;
  // hash only values that cannot satisfy the wire contract
  if (tag.length > 256 || !noControls.test(tag)) return `agent-status-${identifierDigest(agentId)}`;
  return tag;
}

// keep the strict display namespace separate from provider coalescing
function agentDisplayTag(tag: string): string {
  const displayTag = `rac-v1-${tag}`;
  // hash only tags whose prefixed form exceeds the display bound
  if (displayTag.length > 256 || !noControls.test(displayTag)) return `rac-v1-agent-${identifierDigest(tag)}`;
  return displayTag;
}

// retain valid source ids and replace unsafe ids with a stable opaque value
function boundedEventId(value: string): string {
  // reuse existing completion and question ids whenever they are wire-safe
  if (safeEventId.test(value)) return value;
  return identifierDigest(value);
}

// construct the exact flat event metadata shared by dashboard and push payloads
export function createAgentNotificationEvent(input: {
  agentId: string;
  eventId: string;
  eventEpoch: string;
  eventSequence: number;
  generatedAt: number;
  kind: NotificationEventKind;
  url: string;
  worktreeId?: string;
}): NotificationEvent {
  const tag = agentLogicalTag(input.agentId);
  const rawEntityId = `agent:${input.agentId}`;
  const entityId = rawEntityId.length <= 256 && noControls.test(rawEntityId) ? rawEntityId : `agent:${identifierDigest(input.agentId)}`;
  return {
    schemaVersion: 1,
    eventId: boundedEventId(input.eventId),
    eventEpoch: input.eventEpoch,
    eventSequence: input.eventSequence,
    entityId,
    generatedAt: input.generatedAt,
    kind: input.kind,
    agentId: input.agentId,
    tag,
    displayTag: agentDisplayTag(tag),
    url: input.url,
    ...(input.worktreeId === undefined ? {} : { worktreeId: input.worktreeId })
  };
}
