import { describe, expect, it } from 'vitest';
import { expiryForAnchor, retentionWindow } from '../src/davo/retention.js';

// verify calendar retention boundaries
describe('davo retention', () => {
  // advance only at the los angeles cutoff
  it('uses the latest 03:00 los angeles sweep', () => {
    expect(retentionWindow(new Date('2026-11-05T10:59:59.999Z'))).toEqual({
      sweepDate: '2026-11-04',
      retainedFrom: '2026-11-02T08:00:00.000Z',
      nextSweepAt: '2026-11-05T11:00:00.000Z'
    });
    expect(retentionWindow(new Date('2026-11-05T11:00:00.000Z'))).toEqual({
      sweepDate: '2026-11-05',
      retainedFrom: '2026-11-03T08:00:00.000Z',
      nextSweepAt: '2026-11-06T11:00:00.000Z'
    });
  });

  // preserve calendar semantics across daylight changes
  it('computes one cutoff across spring and fall transitions', () => {
    expect(retentionWindow(new Date('2026-03-08T09:59:59.999Z'))).toMatchObject({
      sweepDate: '2026-03-07',
      nextSweepAt: '2026-03-08T10:00:00.000Z'
    });
    expect(retentionWindow(new Date('2026-03-08T10:00:00.001Z'))).toMatchObject({
      sweepDate: '2026-03-08',
      retainedFrom: '2026-03-06T08:00:00.000Z',
      nextSweepAt: '2026-03-09T10:00:00.000Z'
    });
    expect(retentionWindow(new Date('2026-11-01T11:00:00.000Z'))).toMatchObject({
      sweepDate: '2026-11-01',
      nextSweepAt: '2026-11-02T11:00:00.000Z'
    });
  });

  // anchor expiry to the original local date
  it('expires an anchor at its fourth local date cutoff', () => {
    expect(expiryForAnchor('2026-11-02T07:59:59.999Z')).toBe('2026-11-04T11:00:00.000Z');
    expect(expiryForAnchor('2026-11-02T08:00:00.000Z')).toBe('2026-11-05T11:00:00.000Z');
  });
});
