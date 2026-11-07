import { useCallback, useEffect, useRef, useState } from 'react';

type Request = (url: string, init?: RequestInit) => Promise<Response>;

export type DavoMessage = {
  id: string;
  sequence: number;
  kind: 'user' | 'assistant' | 'status' | 'choice';
  text: string;
  createdAt: string;
  expiresAt: string;
  requestId?: string;
};

export type DavoPendingChoice = {
  requestId: string;
  choiceId: string;
  kind: 'agent_question' | 'davo_continuation_choice';
  question: string;
  options: string[];
};

export type DavoConversationSnapshot = {
  conversationId: string;
  generation: number;
  revision: string;
  retainedFrom: string;
  serverNow: string;
  retentionCutoffAt: string;
  nextSequence: number;
  hasMore: boolean;
  pendingChoices: DavoPendingChoice[];
  messages: DavoMessage[];
};

export type DavoConversation = {
  snapshot?: DavoConversationSnapshot;
  messages: DavoMessage[];
  loading: boolean;
  loadingOlder: boolean;
  error?: string;
  refresh: () => Promise<DavoConversationSnapshot | undefined>;
  loadOlder: () => Promise<void>;
};

const pollMilliseconds = 2_500;

// retain server-owned Davo history only in memory
export function useDavoConversation(request: Request): DavoConversation {
  const [snapshot, setSnapshot] = useState<DavoConversationSnapshot>();
  const [messages, setMessages] = useState<DavoMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string>();
  const current = useRef<DavoConversationSnapshot | undefined>(undefined);
  const offset = useRef(0);
  const inFlight = useRef<Promise<DavoConversationSnapshot | undefined> | undefined>(undefined);

  // remove rows whose server deadline elapsed
  const purge = useCallback(() => {
    const serverNow = Date.now() + offset.current;
    setMessages(rows => rows.filter(row => Date.parse(row.expiresAt) > serverNow));
    const snapshot = current.current;
    // scrub expired metadata from the retained projection too
    if (snapshot !== undefined) {
      const messages = snapshot.messages.filter(row => Date.parse(row.expiresAt) > serverNow);
      current.current = { ...snapshot, messages };
      setSnapshot(state => state === undefined ? undefined : { ...state, messages });
    }
  }, []);

  // fetch and merge the newest retained page
  const refresh = useCallback(async (): Promise<DavoConversationSnapshot | undefined> => {
    // share one refresh across polling and receipts
    if (inFlight.current !== undefined) return inFlight.current;
    const operation = (async () => {
      try {
        const response = await request('/api/davo/conversation?limit=100', { cache: 'no-store' });
        // surface only a safe history error
        if (!response.ok) throw new Error('Davo history is unavailable.');
        const parsed = conversationFrom(await response.json());
        // reject malformed history projections
        if (parsed === undefined) throw new Error('Davo history returned an invalid response.');
        offset.current = Date.parse(parsed.serverNow) - Date.now();
        const retained = unexpired(parsed.messages, offset.current);
        const sanitized = { ...parsed, messages: retained };
        const previous = current.current;
        current.current = sanitized;
        setSnapshot(sanitized);
        setMessages(rows => previous === undefined || previous.conversationId !== parsed.conversationId || previous.generation !== parsed.generation
          ? retained
          : unexpired(mergeMessages(rows, retained), offset.current));
        setError(undefined);
        return sanitized;
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : 'Davo history is unavailable.');
        return undefined;
      } finally {
        setLoading(false);
        inFlight.current = undefined;
      }
    })();
    inFlight.current = operation;
    return operation;
  }, [request]);

  // page backward without resetting newer rows
  const loadOlder = useCallback(async () => {
    const oldest = messages[0];
    // stop when no older page exists
    if (oldest === undefined || current.current?.hasMore !== true || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const response = await request(`/api/davo/conversation?beforeSequence=${oldest.sequence}&limit=100`, { cache: 'no-store' });
      // retain current rows after paging failures
      if (!response.ok) throw new Error('Older Davo history is unavailable.');
      const parsed = conversationFrom(await response.json());
      // reject stale or malformed pages
      if (parsed === undefined || parsed.conversationId !== current.current?.conversationId || parsed.generation !== current.current.generation) return;
      offset.current = Date.parse(parsed.serverNow) - Date.now();
      const retained = unexpired(parsed.messages, offset.current);
      current.current = { ...parsed, messages: mergeMessages(retained, current.current.messages) };
      setSnapshot(state => state === undefined ? { ...parsed, messages: retained } : { ...state, hasMore: parsed.hasMore, serverNow: parsed.serverNow, retentionCutoffAt: parsed.retentionCutoffAt, messages: mergeMessages(retained, state.messages) });
      setMessages(rows => unexpired(mergeMessages(retained, rows), offset.current));
      setError(undefined);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Older Davo history is unavailable.');
    } finally {
      setLoadingOlder(false);
    }
  }, [loadingOlder, messages, request]);

  useEffect(() => {
    void refresh();
    const poll = window.setInterval(() => void refresh(), pollMilliseconds);
    const expiry = window.setInterval(purge, 30_000);
    // stop all in-memory timers on unmount
    return () => {
      window.clearInterval(poll);
      window.clearInterval(expiry);
    };
  }, [purge, refresh]);

  return { snapshot, messages, loading, loadingOlder, error, refresh, loadOlder };
}

// merge exact message ids in sequence order
function mergeMessages(left: DavoMessage[], right: DavoMessage[]): DavoMessage[] {
  const merged = new Map(left.map(message => [message.id, message]));
  // prefer the newest server projection
  for (const message of right) merged.set(message.id, message);
  return [...merged.values()].sort((a, b) => a.sequence - b.sequence);
}

// remove expired rows using server-derived time
function unexpired(messages: DavoMessage[], serverOffset: number): DavoMessage[] {
  const now = Date.now() + serverOffset;
  return messages.filter(message => Date.parse(message.expiresAt) > now);
}

// validate one server conversation projection
function conversationFrom(value: unknown): DavoConversationSnapshot | undefined {
  // require all top-level retention fields
  if (!record(value) || typeof value.conversationId !== 'string' || !integer(value.generation) || typeof value.revision !== 'string' || typeof value.retainedFrom !== 'string' || typeof value.serverNow !== 'string' || typeof value.retentionCutoffAt !== 'string' || !integer(value.nextSequence) || typeof value.hasMore !== 'boolean' || !Array.isArray(value.pendingChoices) || !Array.isArray(value.messages)) return undefined;
  const pendingChoices: DavoPendingChoice[] = [];
  // validate every public choice descriptor
  for (const candidate of value.pendingChoices) {
    const choice = pendingChoiceFrom(candidate);
    // reject partial choice projections
    if (choice === undefined) return undefined;
    pendingChoices.push(choice);
  }
  const messages: DavoMessage[] = [];
  // validate every retained row
  for (const candidate of value.messages) {
    const message = messageFrom(candidate);
    // reject partial projections
    if (message === undefined) return undefined;
    messages.push(message);
  }
  return { conversationId: value.conversationId, generation: value.generation, revision: value.revision, retainedFrom: value.retainedFrom, serverNow: value.serverNow, retentionCutoffAt: value.retentionCutoffAt, nextSequence: value.nextSequence, hasMore: value.hasMore, pendingChoices, messages };
}

// validate one public audio-only choice descriptor
function pendingChoiceFrom(value: unknown): DavoPendingChoice | undefined {
  // require exact public fields and bounded string options
  if (!record(value) || typeof value.requestId !== 'string' || typeof value.choiceId !== 'string' || !['agent_question', 'davo_continuation_choice'].includes(String(value.kind)) || typeof value.question !== 'string' || !Array.isArray(value.options) || value.options.some(option => typeof option !== 'string')) return undefined;
  return { requestId: value.requestId, choiceId: value.choiceId, kind: value.kind as DavoPendingChoice['kind'], question: value.question, options: value.options as string[] };
}

// validate one retained chat row
function messageFrom(value: unknown): DavoMessage | undefined {
  // require one exact safe message
  if (!record(value) || typeof value.id !== 'string' || !integer(value.sequence) || !['user', 'assistant', 'status', 'choice'].includes(String(value.kind)) || typeof value.text !== 'string' || typeof value.createdAt !== 'string' || typeof value.expiresAt !== 'string' || value.requestId !== undefined && typeof value.requestId !== 'string') return undefined;
  return { id: value.id, sequence: value.sequence, kind: value.kind as DavoMessage['kind'], text: value.text, createdAt: value.createdAt, expiresAt: value.expiresAt, ...(value.requestId === undefined ? {} : { requestId: value.requestId }) };
}

// recognize nonnegative integers
function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

// recognize plain response objects
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
