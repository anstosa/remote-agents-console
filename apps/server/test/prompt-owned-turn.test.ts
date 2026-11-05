import { describe, expect, it, vi } from 'vitest';
import { PromptService, type TurnTransport } from '../src/prompts/service.js';

// isolate phase identity while retaining the real ownership-aware PromptService dispatch
function fixture() {
  const service = new PromptService({} as never, {} as never);
  let current = { promptId: 'mine', sender: { from: 'conductor' } };
  service.inFlight = () => current;
  return { service, replace: () => { current = { promptId: 'operator', sender: { from: 'operator' } }; } };
}

describe('exact dispatched-Turn ownership', () => {
  // an asynchronous transport lookup must not move authorization onto the next Turn
  it.each(['steer', 'cancel'] as const)('refuses %s after the owned Turn is replaced during lookup', async operation => {
    const { service, replace } = fixture();
    const effect = vi.fn(async () => 'ok');
    service.transportFor = async () => { replace(); return { steer: effect, interrupt: effect } as never; };
    const expected = { promptId: 'mine', from: 'conductor' };
    const outcome = operation === 'steer' ? await service.steer('target', 'hello', expected) : await service.cancel('target', undefined, expected);
    expect(outcome).toBe(operation === 'steer' ? 'refused' : 'not-working');
    expect(effect).not.toHaveBeenCalled();
    expect(service.beginAgentMutation('target')).toBeTypeOf('function');
  });
  // the transport repeats identity validation immediately at its final side-effect boundary
  it.each(['steer', 'cancel'] as const)('fences %s across a second await inside the transport', async operation => {
    const { service, replace } = fixture();
    const effect = vi.fn();
    const transport = {
      // simulate target loading before the transport's final guard
      steer: async (_id: string, _text: string, guard?: () => boolean) => { await Promise.resolve(); replace(); if (!guard?.()) return 'refused'; effect(); return 'sent'; },
      // simulate target loading before the interrupt's final guard
      interrupt: async (_id: string, _returned?: unknown, guard?: () => boolean) => { await Promise.resolve(); replace(); if (!guard?.()) return 'not-working'; effect(); return 'ok'; }
    } as TurnTransport;
    service.transportFor = async () => transport;
    const expected = { promptId: 'mine', from: 'conductor' };
    const outcome = operation === 'steer' ? await service.steer('target', 'hello', expected) : await service.cancel('target', undefined, expected);
    expect(outcome).not.toBe(operation === 'steer' ? 'sent' : 'ok');
    expect(effect).not.toHaveBeenCalled();
  });
});
