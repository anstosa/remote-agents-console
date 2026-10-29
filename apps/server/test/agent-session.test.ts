import { describe, expect, it } from 'vitest';
import { paneTmuxSession } from '../src/domain/models.js';

describe('paneTmuxSession', () => {
  it('recovers the raw tmux session from the composite agent id', () => {
    // discovery keys an agent as `${socketFingerprint}:${tmuxSession}`; a consumer that
    // needs to run a tmux command (attach-session, kill-session) must strip the prefix,
    // or the ":" makes an invalid target that no tmux session matches
    expect(paneTmuxSession({ sessionId: 'socket:$1', socketFingerprint: 'socket' })).toBe('$1');
    expect(paneTmuxSession({ sessionId: 'abc123:rac-main', socketFingerprint: 'abc123' })).toBe('rac-main');
  });
});
