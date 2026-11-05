import { describe, expect, it } from 'vitest';
import { IntegrationControlService } from '../src/integrations/control/index.js';

const secret = 'server-secret-used-only-for-owner-derivation';

describe('IntegrationControlService', () => {
  it('binds mutations and an ephemeral bearer to one exact browser voice lease', () => {
    let owner: string | undefined = 'browser-a';
    let now = 1_000;
    const service = new IntegrationControlService(() => owner, () => now, 100, secret);

    expect(service.authorizeMutation()).toEqual({ ok: false, code: 'voice_mode_required' });
    const first = service.startVoiceLease('browser-a', 'voice-session-123456789');
    expect(first).toMatchObject({ stableOwnerKey: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u), leaseKey: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u), expiresAt: 1_100 });
    if (first === undefined) throw new Error('lease unavailable');
    expect(service.authenticateRealtimeBearer(first.bearer)).toMatchObject({ authentication: 'realtime', stableOwnerKey: first.stableOwnerKey, leaseKey: first.leaseKey });
    expect(service.controllerPresent(first.stableOwnerKey)).toBe(true);
    expect(service.authorizeMutation(first.leaseKey)).toEqual({ ok: true, leaseKey: first.leaseKey });
    expect(service.authorizeMutation('different-lease')).toEqual({ ok: false, code: 'voice_lease_changed' });
    expect(service.heartbeatVoice('browser-a', 'voice-session-123456789')).toBe(true);
    service.stopVoice('browser-a', 'voice-session-123456789');
    expect(service.authenticateRealtimeBearer(first.bearer)).toBeUndefined();
    expect(service.controllerPresent(first.stableOwnerKey)).toBe(true);
    expect(service.authorizeMutation()).toEqual({ ok: false, code: 'voice_mode_required' });
    expect(service.startVoiceLease('browser-a', 'voice-session-123456789')).toBeUndefined();

    now += 101;
    const replacement = service.startVoiceLease('browser-a', 'voice-session-987654321');
    expect(replacement?.stableOwnerKey).toBe(first.stableOwnerKey);
    expect(replacement?.leaseKey).not.toBe(first.leaseKey);
    expect(service.authenticateRealtimeBearer(first.bearer)).toBeUndefined();
    owner = 'browser-b';
    expect(service.controllerPresent(first.stableOwnerKey)).toBe(false);
    expect(service.authorizeMutation(replacement?.leaseKey)).toEqual({ ok: false, code: 'browser_control_changed' });
    expect(service.authenticateRealtimeBearer(replacement?.bearer ?? '')).toBeUndefined();
  });

  it('revokes an ephemeral bearer after a failed controller heartbeat', () => {
    let owner: string | undefined = 'browser-a';
    const service = new IntegrationControlService(() => owner, Date.now, 25_000, secret);
    const lease = service.startVoiceLease('browser-a', 'voice-session-123456789');
    if (lease === undefined) throw new Error('lease unavailable');
    owner = 'browser-b';
    expect(service.heartbeatVoice('browser-a', 'voice-session-123456789')).toBe(false);
    owner = 'browser-a';
    expect(service.authenticateRealtimeBearer(lease.bearer)).toBeUndefined();
    expect(service.authorizeMutation(lease.leaseKey)).toEqual({ ok: false, code: 'voice_mode_required' });
  });
});
