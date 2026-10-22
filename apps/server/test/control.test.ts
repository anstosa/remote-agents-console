import { describe, expect, it } from 'vitest';
import { ControlService } from '../src/auth/control.js';

// distinguish reserved ownership from an active connection lease
describe('ControlService', () => {
  // distinguish explicit first admission from passive session restoration
  it('keeps an unowned console inactive when initial admission is disabled', () => {
    const control = new ControlService();
    expect(control.connect('first')).toBe(false);
    expect(control.connect('first', false)).toBe(false);
    expect(control.ownerSessionId()).toBeUndefined();
    expect(control.connect('first', true)).toBe(true);
    expect(control.connect('first', false)).toBe(true);
    control.release('first');
    expect(control.connect('second', false)).toBe(false);
    control.take('second');
    expect(control.connect('second', false)).toBe(true);
  });

  // preserve initial admission and deliberate handoffs
  it('keeps one client active and supports explicit takeover', () => {
    const control = new ControlService();
    expect(control.connect('first', true)).toBe(true);
    expect(control.ownerSessionId()).toBe('first');
    expect(control.connect('second')).toBe(false);
    expect(control.active('first')).toBe(true);
    control.take('second');
    expect(control.ownerSessionId()).toBe('second');
    expect(control.active('first')).toBe(false);
    expect(control.active('second')).toBe(true);
  });

  // block passive acquisition even before an expiry check
  it('requires takeover after inactivity but lets the same owner reconnect', () => {
    let now = 1_000;
    const control = new ControlService(() => now, 100);
    expect(control.connect('first', true)).toBe(true);
    now += 100;
    expect(control.connect('second')).toBe(false);
    expect(control.ownerSessionId()).toBeUndefined();
    expect(control.active('first')).toBe(false);
    expect(control.connect('second')).toBe(false);
    expect(control.connect('first')).toBe(true);
    expect(control.ownerSessionId()).toBe('first');
    expect(control.active('first')).toBe(true);
  });

  // prevent a displaced browser from reclaiming an idle session
  it('retains explicit takeover across later lease expiry', () => {
    let now = 1_000;
    const control = new ControlService(() => now, 100);
    control.take('first');
    now += 101;
    control.take('second');
    expect(control.active('second')).toBe(true);
    expect(control.active('first')).toBe(false);
    now += 101;
    expect(control.ownerSessionId()).toBeUndefined();
    expect(control.connect('first')).toBe(false);
    expect(control.connect('third')).toBe(false);
    expect(control.connect('second')).toBe(true);
  });

  // unauthorized traffic must not keep a lease alive
  it('does not renew the owner lease for another client', () => {
    let now = 1_000;
    const control = new ControlService(() => now, 100);
    control.take('first');
    now += 99;
    expect(control.connect('second')).toBe(false);
    expect(control.active('second')).toBe(false);
    now += 1;
    expect(control.ownerSessionId()).toBeUndefined();
    expect(control.active('first')).toBe(false);
  });

  // only an explicit owner logout releases the reservation
  it('releases an expired owner without letting a displaced logout clear ownership', () => {
    let now = 1_000;
    const control = new ControlService(() => now, 100);
    control.take('first');
    control.take('second');
    now += 101;
    control.release('first');
    expect(control.connect('third')).toBe(false);
    control.release('second');
    expect(control.connect('third')).toBe(false);
    expect(control.connect('third', true)).toBe(true);
  });
});
