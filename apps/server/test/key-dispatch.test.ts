import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKeyDispatcher, keyRepeatMs, keyTableTimeoutMs } from '../../web/src/key-dispatch.js';
import { parseKeysConfig, resolveKeyTables, type KeyBinding, type ResolvedKeyTables } from '../src/config/keys.js';

// a dispatcher over the defaults (plus `config`) that records what it ran; `decline` lists the
// actions that say they do not apply right now
const setup = (config: unknown = {}, decline: string[] = [], suppliedTables?: ResolvedKeyTables) => {
  const ran: Array<{ binding: KeyBinding; table: string; chord: string }> = [];
  const matched = vi.fn();
  const dispatcher = createKeyDispatcher({
    tables: () => suppliedTables ?? resolveKeyTables(parseKeysConfig(config)),
    onMatch: matched,
    run: (binding, context) => {
      ran.push({ binding, table: context.table, chord: context.chord });
      return typeof binding !== 'string' || !decline.includes(binding);
    }
  });
  return { dispatcher, matched, ran, press: (chord: string | undefined, focusTables: readonly string[] = []) => dispatcher.handle(chord, undefined, focusTables) };
};

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('key dispatcher', () => {
  it('passes keys with no root binding straight through', () => {
    const { press, ran } = setup();
    expect(press('a')).toBe('pass');
    expect(press('C-l')).toBe('pass');
    expect(ran).toEqual([]);
  });

  it('runs a root action and lets a declining one pass', () => {
    const { press, matched, ran } = setup({}, ['copy-selection']);
    expect(press('C-?')).toBe('handled');
    expect(press('y')).toBe('pass');
    expect(ran.map(entry => entry.binding)).toEqual(['show-bindings', 'copy-selection']);
    expect(matched).toHaveBeenCalledTimes(1);
  });

  it('copies selected text before the prompt clear condition', () => {
    const { press, matched, ran } = setup();

    expect(press('C-c', ['when:text-selected', 'when:prompt', 'when:agent'])).toBe('handled');
    expect(press('C-c', ['when:prompt', 'when:agent'])).toBe('handled');
    expect(ran).toEqual([
      { binding: 'copy-selection', table: 'when:text-selected', chord: 'C-c' },
      { binding: 'clear-prompt', table: 'when:prompt', chord: 'C-c' }
    ]);
    expect(matched).toHaveBeenCalledTimes(2);
  });

  it('uses a remapped prompt action while retaining selected-text copy', () => {
    const { press, ran } = setup({ 'when:prompt': { 'C-c': null, 'C-k': 'clear-prompt' } });

    expect(press('C-k', ['when:prompt'])).toBe('handled');
    expect(press('C-c', ['when:text-selected', 'when:prompt'])).toBe('handled');
    expect(ran).toEqual([
      { binding: 'clear-prompt', table: 'when:prompt', chord: 'C-k' },
      { binding: 'copy-selection', table: 'when:text-selected', chord: 'C-c' }
    ]);
  });

  it('falls through missing and declining focus conditions to root', () => {
    const { press, matched, ran } = setup({ 'when:text-selected': { 'C-k': 'copy-selection' }, 'when:note-editor': { 'C-k': 'last-panel' } }, ['copy-selection']);

    expect(press('C-k', ['when:text-selected', 'when:note-editor', 'when:agent'])).toBe('handled');
    expect(ran).toEqual([
      { binding: 'copy-selection', table: 'when:text-selected', chord: 'C-k' },
      { binding: 'last-panel', table: 'when:note-editor', chord: 'C-k' }
    ]);
    expect(matched).toHaveBeenCalledOnce();

    const root = setup();
    expect(root.press('y', ['when:terminal'])).toBe('handled');
    expect(root.ran).toEqual([{ binding: 'copy-selection', table: 'root', chord: 'y' }]);
    expect(root.matched).toHaveBeenCalledOnce();
  });

  it('swallows a conflicted focus shortcut without falling through', () => {
    const tables = resolveKeyTables(undefined);
    tables['when:prompt']!['C-c'] = { ...tables['when:prompt']!['C-c']!, conflicted: true };
    const { press, matched, ran } = setup({}, [], tables);

    expect(press('C-c', ['when:prompt'])).toBe('handled');
    expect(ran).toEqual([]);
    expect(matched).not.toHaveBeenCalled();
  });

  it('reports table entries and actions but not missing or disabled bindings', () => {
    const { press, matched } = setup({ root: { 'C-l': null } });
    expect(press(undefined)).toBe('pass');
    expect(press('a')).toBe('pass');
    expect(press('C-l')).toBe('pass');
    expect(matched).not.toHaveBeenCalled();
    expect(press('C-b')).toBe('handled');
    expect(matched).toHaveBeenCalledTimes(1);
    expect(press('c')).toBe('handled');
    expect(matched).toHaveBeenCalledTimes(2);
  });

  it('swallows a conflicted root shortcut without dispatching either command', () => {
    const tables = resolveKeyTables(undefined);
    tables.root!['C-?'] = { ...tables.root!['C-?']!, conflicted: true };
    const { press, matched, ran } = setup({}, [], tables);

    expect(press('C-?')).toBe('handled');
    expect(ran).toEqual([]);
    expect(matched).not.toHaveBeenCalled();
  });

  it('runs the next key from the leader table, then returns to root', () => {
    const { press, ran, dispatcher } = setup();
    expect(press('C-b')).toBe('handled');
    expect(dispatcher.state()).toMatchObject({ table: 'prefix', chord: 'C-b' });
    expect(press('c')).toBe('handled');
    expect(ran).toEqual([{ binding: 'new-terminal', table: 'prefix', chord: 'c' }]);
    expect(dispatcher.state()).toBeUndefined();
    expect(press('c')).toBe('pass');
  });

  it('swallows an unbound key after the leader, as tmux does', () => {
    const { press, ran, dispatcher } = setup();
    press('C-b');
    expect(press('q')).toBe('handled');
    expect(ran).toEqual([]);
    expect(dispatcher.state()).toBeUndefined();
  });

  it('keeps a table bound action swallowed even when it declines', () => {
    const { press } = setup({}, ['rename-panel']);
    press('C-b');
    expect(press(',')).toBe('handled');
  });

  it('sends the leader on when it is pressed twice', () => {
    const { press, matched, ran, dispatcher } = setup();
    press('C-b');
    expect(press('C-b')).toBe('send');
    expect(ran).toEqual([]);
    expect(matched).toHaveBeenCalledTimes(2);
    expect(dispatcher.state()).toBeUndefined();
  });

  it('sends a rebound leader through too, and a table may bind its own leader', () => {
    const rebound = setup({ root: { 'C-a': { table: 'prefix' }, 'C-b': null } });
    expect(rebound.press('C-b')).toBe('pass');
    rebound.press('C-a');
    expect(rebound.press('C-a')).toBe('send');
    const bound = setup({ prefix: { 'C-b': 'last-panel' } });
    bound.press('C-b');
    expect(bound.press('C-b')).toBe('handled');
    expect(bound.ran.map(entry => entry.binding)).toEqual(['last-panel']);
  });

  it('does not send a leader whose destination in the active table is conflicted', () => {
    const tables = resolveKeyTables(undefined);
    tables.prefix!['C-b'] = { chord: 'C-b', binding: 'new-terminal', source: 'config', conflicted: true };
    const { press, matched, ran, dispatcher } = setup({}, [], tables);

    expect(press('C-b')).toBe('handled');
    expect(press('C-b')).toBe('handled');
    expect(ran).toEqual([]);
    expect(matched).toHaveBeenCalledTimes(1);
    expect(dispatcher.state()).toBeUndefined();
  });

  it('ignores bare modifiers while a table waits', () => {
    const { press, ran } = setup();
    press('C-b');
    expect(press(undefined)).toBe('pass');
    expect(press('%')).toBe('handled');
    expect(ran.map(entry => entry.binding)).toEqual(['split-beside']);
  });

  it('drops back to root when the table times out', () => {
    const { press, ran, dispatcher } = setup();
    const changes = vi.fn();
    dispatcher.subscribe(changes);
    press('C-b');
    vi.advanceTimersByTime(keyTableTimeoutMs - 1);
    expect(dispatcher.state()?.table).toBe('prefix');
    vi.advanceTimersByTime(1);
    expect(dispatcher.state()).toBeUndefined();
    expect(changes).toHaveBeenCalledTimes(2);
    expect(press('c')).toBe('pass');
    expect(ran).toEqual([]);
  });

  it('reports when the active table expires, for the indicator', () => {
    const { press, dispatcher } = setup();
    press('C-b');
    expect(dispatcher.state()).toMatchObject({ table: 'prefix', expiresAt: Date.now() + keyTableTimeoutMs, repeat: false });
  });

  it('chains from one table to another', () => {
    const { press, matched, ran, dispatcher } = setup({ root: { 'C-g': { table: 'git' } }, git: { l: { terminal: 'lazygit' } }, prefix: { G: { table: 'git' } } });
    press('C-b');
    expect(press('S-g')).toBe('handled');
    expect(dispatcher.state()).toMatchObject({ table: 'git', chord: 'S-g' });
    expect(press('l')).toBe('handled');
    expect(ran).toEqual([{ binding: { terminal: 'lazygit' }, table: 'git', chord: 'l' }]);
    expect(matched).toHaveBeenCalledTimes(3);
  });

  it('keeps a repeatable binding live without the leader for a moment', () => {
    const { press, matched, ran, dispatcher } = setup();
    press('C-b');
    press('Right');
    expect(dispatcher.state()).toMatchObject({ table: 'prefix', repeat: true });
    vi.advanceTimersByTime(keyRepeatMs - 1);
    expect(press('Right')).toBe('handled');
    vi.advanceTimersByTime(keyRepeatMs - 1);
    expect(press('Left')).toBe('handled');
    expect(ran.map(entry => entry.binding)).toEqual(['select-panel-right', 'select-panel-right', 'select-panel-left']);
    vi.advanceTimersByTime(keyRepeatMs);
    expect(dispatcher.state()).toBeUndefined();
    expect(press('Right')).toBe('pass');
    expect(matched).toHaveBeenCalledTimes(4);
  });

  it('ends the repeat on any other key and handles that key from root', () => {
    const { press, matched, ran, dispatcher } = setup();
    press('C-b');
    press('Left');
    expect(press('c')).toBe('pass');
    expect(dispatcher.state()).toBeUndefined();
    press('C-b');
    press('Left');
    expect(press('C-?')).toBe('handled');
    expect(ran.map(entry => entry.binding)).toEqual(['select-panel-left', 'select-panel-left', 'show-bindings']);
    expect(matched).toHaveBeenCalledTimes(5);
  });

  it('ends a repeat by returning to the active focus conditions', () => {
    const { press, ran, dispatcher } = setup();
    press('C-b', ['when:prompt']);
    press('Left', ['when:prompt']);

    expect(press('C-c', ['when:prompt'])).toBe('handled');
    expect(dispatcher.state()).toBeUndefined();
    expect(ran.map(entry => entry.binding)).toEqual(['select-panel-left', 'clear-prompt']);
  });

  it('does not fall through a conflicted repeat key to its root binding', () => {
    const tables = resolveKeyTables(undefined);
    tables.prefix!['C-?'] = { chord: 'C-?', binding: 'new-terminal', source: 'config', conflicted: true };
    const { press, matched, ran, dispatcher } = setup({}, [], tables);

    press('C-b');
    press('Right');
    expect(dispatcher.state()).toMatchObject({ table: 'prefix', repeat: true });
    expect(press('C-?')).toBe('handled');
    expect(ran.map(entry => entry.binding)).toEqual(['select-panel-right']);
    expect(matched).toHaveBeenCalledTimes(2);
    expect(dispatcher.state()).toBeUndefined();
  });

  it('asks before a confirmed action and runs it only on y', () => {
    const { press, matched, dispatcher } = setup();
    const yes = vi.fn();
    dispatcher.confirm('Close panel Terminal 1?', yes);
    expect(dispatcher.state()).toMatchObject({ confirm: 'Close panel Terminal 1?' });
    expect(press(undefined)).toBe('pass');
    expect(matched).not.toHaveBeenCalled();
    expect(press('x')).toBe('handled');
    expect(matched).not.toHaveBeenCalled();
    dispatcher.confirm('Close panel Terminal 1?', yes);
    expect(press('n')).toBe('handled');
    expect(matched).toHaveBeenCalledTimes(1);
    expect(yes).not.toHaveBeenCalled();
    expect(dispatcher.state()).toBeUndefined();
    dispatcher.confirm('Close panel Terminal 1?', yes);
    expect(press('y')).toBe('handled');
    expect(matched).toHaveBeenCalledTimes(2);
    expect(yes).toHaveBeenCalledOnce();
    expect(dispatcher.state()).toBeUndefined();
  });

  it('drops an unanswered question after the table timeout', () => {
    // with nothing selected, copy declines y, so an expired question lets it through
    const { press, dispatcher } = setup({}, ['copy-selection']);
    const yes = vi.fn();
    dispatcher.confirm('Close panel Terminal 1?', yes);
    vi.advanceTimersByTime(keyTableTimeoutMs);
    expect(dispatcher.state()).toBeUndefined();
    expect(press('y')).toBe('pass');
    expect(yes).not.toHaveBeenCalled();
  });

  it('cancels a pending table on reset', () => {
    const { press, dispatcher } = setup();
    press('C-b');
    dispatcher.reset();
    expect(dispatcher.state()).toBeUndefined();
    expect(press('c')).toBe('pass');
  });
});
