import { describe, expect, it, vi } from 'vitest';
import { createSessionOperations, type SessionOperationDependencies } from '../src/integrations/mcp/session-operations.js';
import type { IntegrationPrincipal } from '../src/integrations/auth/index.js';

const conductor: IntegrationPrincipal = { authentication: 'conductor', subjectId: 'conductor', audience: 'local', scopes: ['prompts:write'] };
const davo: IntegrationPrincipal = { authentication: 'realtime', subjectId: 'owner', stableOwnerKey: 'owner', leaseKey: 'lease', audience: 'local', scopes: ['prompts:write'] };
// isolate real port behavior from process and host transport side effects
function fixture(overrides: Partial<SessionOperationDependencies> = {}) {
  const submit = vi.fn(async () => 'prompt-id');
  const answer = vi.fn(async () => true);
  const steer = vi.fn(async () => 'sent' as const);
  const deps: SessionOperationDependencies = { resolveAgent: async (_principal, id) => ({ agent: { id, kind: 'claude', transport: 'tmux', attention: 'finished', home: '/test' } as never }), conversations: async () => [{ id: 'conversation', kind: 'claude', name: 'Name', lastActiveAt: 1000, current: false }], switchConversation: async () => true, forgetConversation: async () => true, prompts: { submitFrom: submit, inFlight: () => ({ promptId: 'prompt', sender: { from: 'conductor' } }), steer, answerQuestion: answer }, owner: principal => ({ namespace: principal.authentication === 'conductor' ? 'conductor' : 'davo', principalOwnerKey: principal.subjectId }), transfers: { download: async () => ({ offset: 0, bytes: 4, data_base64: Buffer.from('body').toString('base64'), eof: true, object_digest: 'digest' }) } as never, ...overrides };
  return { ports: createSessionOperations(deps), submit, answer, steer };
}

describe('developer session operation guards', () => {
  // a Conductor's approval authority never expands just because a callback is reachable
  it('refuses Conductor question answers and relays exact primitive answer forms for Davo', async () => {
    const { ports, answer } = fixture();
    expect(await ports.relay_agent_question_answer!({ agent_id: 'target', question_id: 'question', index: 2 }, conductor)).toMatchObject({ ok: false });
    expect(answer).not.toHaveBeenCalled();
    expect(await ports.relay_agent_question_answer!({ agent_id: 'target', question_id: 'question', index: 2 }, davo)).toMatchObject({ ok: true, value: { relayed: 'index' } });
    expect(answer).toHaveBeenLastCalledWith('target', 'question', 2);
    await ports.relay_agent_question_answer!({ agent_id: 'target', question_id: 'question', text: 'exact answer' }, davo);
    expect(answer).toHaveBeenLastCalledWith('target', 'question', 'exact answer');
    await ports.relay_agent_question_answer!({ agent_id: 'target', question_id: 'question', dismiss: true }, davo);
    expect(answer).toHaveBeenLastCalledWith('target', 'question', { dismiss: true });
  });
  // owning a visible target is not equivalent to having dispatched its current Turn
  it('requires the Conductor to own the current dispatched Turn before steering', async () => {
    const { ports, steer } = fixture({ prompts: { submitFrom: async () => 'id', inFlight: () => ({ promptId: 'prompt', sender: { from: 'other' } }), steer: vi.fn(async () => 'sent'), answerQuestion: async () => true } });
    expect(await ports.steer_agent!({ agent_id: 'target', text: 'hello' }, conductor)).toMatchObject({ ok: false });
    expect(steer).not.toHaveBeenCalled();
  });
  // a referenced upload is queued with its authentic sender and reconstructed content
  it('queues capabilities with attachments but rejects forged sizes and shell-mode prompts', async () => {
    const { ports, submit } = fixture();
    const input = { agent_id: 'target', prompt: 'Read this', attachments: [{ object_token: 'token', name: 'file.txt', size: 4 }] };
    expect(await ports.queue_prompt_with_attachments!(input, conductor)).toMatchObject({ ok: true, value: { prompt_id: 'prompt-id' } });
    expect(submit).toHaveBeenCalledWith('target', 'Read this', { from: 'conductor' }, [{ name: 'file.txt', data: Buffer.from('body').toString('base64') }]);
    expect(await ports.queue_prompt_with_attachments!({ ...input, attachments: [{ ...input.attachments[0], size: 3 }] }, conductor)).toMatchObject({ ok: false });
    expect(await ports.queue_prompt_with_attachments!({ ...input, prompt: '!rm -rf /' }, davo)).toMatchObject({ ok: false });
    expect(submit).toHaveBeenCalledTimes(1);
  });
  // conversation identity must come from the target's currently authorized source list
  it('does not switch or forget an unlisted conversation', async () => {
    const changed = vi.fn(async () => true);
    const { ports } = fixture({ switchConversation: changed, forgetConversation: changed });
    expect(await ports.switch_conversation!({ agent_id: 'target', conversation_id: 'foreign' }, conductor)).toMatchObject({ ok: false });
    expect(await ports.forget_conversation!({ agent_id: 'target', conversation_id: 'foreign' }, davo)).toMatchObject({ ok: false });
    expect(changed).not.toHaveBeenCalled();
    expect(await ports.forget_conversation!({ agent_id: 'target', conversation_id: 'conversation' }, davo)).toMatchObject({ ok: true, value: { provider_history_deleted: false } });
  });
});
