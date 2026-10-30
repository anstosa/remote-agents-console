import { describe, expect, it } from 'vitest';
import { lineSplitter } from '../src/transports/structured.js';

// How the console reads an Agent process's lines from its holder: on LF only, and never holding
// more than one line's cap however long a line runs.

describe('the console\'s line splitter', () => {
  it('splits on LF only, across chunks, dropping a CR before it', () => {
    const lines: string[] = [];
    const splitter = lineSplitter(line => lines.push(line), 8);
    for (const chunk of ['a b\r', '\nc', 'd\n']) splitter.push(chunk);
    expect(lines).toEqual(['a b', 'cd']);
  });

  it('cuts a line past its cap there and drops the rest of it, however it arrives', () => {
    const lines: string[] = [];
    const splitter = lineSplitter(line => lines.push(line), 8);
    splitter.push('0123456789abcdef\nok\n');
    for (const chunk of ['01234', '56789', 'abcdef', 'ghij', 'k\nafter\n']) splitter.push(chunk);
    expect(lines).toEqual(['01234567', 'ok', '01234567', 'after']);
  });
});
