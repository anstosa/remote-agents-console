import { describe, expect, it } from 'vitest';
import { claudeTerminalTail, styledTerminalTail } from '../src/adapters/terminal-preview.js';

describe('passive terminal preview colors', () => {
  // preserve color state from omitted scrollback and across blank rows
  it('tracks inherited and reset colors in the newest meaningful rows', () => {
    const capture = '\x1b[31mold\n\x1b[1m\n🙂 follow\n\x1b[22mred\x1b[m plain\n';

    expect(styledTerminalTail(capture, 2, true)).toEqual({
      text: '🙂 follow\nred plain',
      colors: [{ from: 0, to: 9, foreground: 9 }, { from: 10, to: 13, foreground: 1 }]
    });
  });

  // extended colors and foreground/background attributes remain numeric data or hex
  it('retains indexed, RGB, inverse and dim attributes without leaking resets', () => {
    const capture = '\x1b[38;5;202;48:2::1:2:3mAB\x1b[7;2mCD\x1b[39;49;27;22mplain';

    expect(styledTerminalTail(capture, 5)).toEqual({
      text: 'ABCDplain',
      colors: [
        { from: 0, to: 2, foreground: 202, background: '#010203' },
        { from: 2, to: 4, foreground: 202, background: '#010203', inverse: true, dim: true }
      ]
    });
    expect(styledTerminalTail('\x1b[38;2;16;32;255mX\x1b[107mY', 5)).toEqual({ text: 'XY', colors: [{ from: 0, to: 1, foreground: '#1020ff' }, { from: 1, to: 2, foreground: '#1020ff', background: 15 }] });
  });

  // only text survives links, device commands, cursor movement or invalid colors
  it('ignores non-color controls and out-of-range channels', () => {
    const capture = '\x1b]8;;https://example.test\x07link\x1b]8;;\x1b\\\x1b[2J\x1bPnot visible\x1b\\\x1b[38;2;300;0;0m\x1b[58;2;31;41;7m normal';

    expect(styledTerminalTail(capture, 5)).toEqual({ text: 'link normal' });
  });

  // prevent hostile rendition churn from bloating a passive payload
  it('falls back to plain text when the color budget is exhausted', () => {
    expect(styledTerminalTail('\x1b[32mA\x1b[31mB'.repeat(513), 5)).toEqual({ text: 'AB'.repeat(513) });
  });

  // active questions are output, but their native keyboard instructions are not
  it('keeps Claude choice content while excluding its footer', () => {
    const capture = ['> Deploy the change', 'Checking state', 'Choose an environment', '❯ 1. Staging', '  2. Production', 'Enter to select · ↑/↓ to navigate · Esc to cancel'].join('\n');

    expect(claudeTerminalTail(capture, 7)).toEqual({ text: 'Checking state\nChoose an environment\n❯ 1. Staging\n  2. Production' });
  });

  it('rejects Claude scrollback without a current native boundary', () => {
    expect(claudeTerminalTail('An old assistant answer\nolder tool output', 7)).toBeUndefined();
  });
});
