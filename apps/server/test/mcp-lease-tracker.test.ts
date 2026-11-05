import { describe, expect, it } from 'vitest';
import { RemoteArtifactLeaseTracker } from '../src/integrations/mcp/lease-tracker.js';

describe('remote artifact lease fencing', () => {
  // delayed old delegations cannot roll a stable owner back to a replaced lease
  it('preserves B through out-of-order A/B/A arrivals and rejects equal-time ambiguity', () => {
    const tracker = new RemoteArtifactLeaseTracker(() => 1000);
    expect(tracker.observe('owner', 'A', 900, 15_900)).toBe(true);
    expect(tracker.observe('owner', 'B', 950, 15_950)).toBe(true);
    expect(tracker.observe('owner', 'A', 900, 15_900)).toBe(false);
    expect(tracker.active('owner', 'B')).toBe(true);
    expect(tracker.active('owner', 'A')).toBe(false);
    expect(tracker.observe('owner', 'A', 950, 15_950)).toBe(false);
    expect(tracker.active('owner', 'B')).toBe(true);
  });
  // saturation preserves current owners and releases only actually expired entries
  it('expires before bounded admission without live eviction', () => {
    let now = 1000;
    const tracker = new RemoteArtifactLeaseTracker(() => now, 1);
    expect(tracker.observe('first', 'A', 900, 1100)).toBe(true);
    expect(tracker.observe('second', 'B', 950, 1200)).toBe(false);
    expect(tracker.active('first', 'A')).toBe(true);
    now = 1100;
    expect(tracker.observe('second', 'B', 1050, 1200)).toBe(true);
    expect(tracker.observe('first', 'A', 900, 1100)).toBe(false);
  });
});
