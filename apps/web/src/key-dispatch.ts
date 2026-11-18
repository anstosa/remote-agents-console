import { isFocusKeyTable, isTableBinding, keyActions, lookupKeyBinding, type KeyBinding, type ResolvedKeyTables } from '../../server/src/config/keys.js';

// how long a table switch waits for its key, and how long a repeatable binding stays live
export const keyTableTimeoutMs = 10_000;
export const keyRepeatMs = 500;

// What is waiting for the next key: a table entered by `chord` (live for repeatable bindings only
// while `repeat`), or a y/n question. Undefined while only `root` is active.
export type KeyDispatchState =
  | { table: string; chord: string; repeat: boolean; expiresAt: number; confirm?: undefined }
  | { confirm: string; onYes: () => void; expiresAt: number; table?: undefined; chord?: undefined };

// `run` returns false when its action does not apply right now, so the key passes through.
type KeyDispatcherOptions<Context> = {
  tables: () => ResolvedKeyTables;
  run: (binding: KeyBinding, context: { table: string; chord: string; event: Context }) => boolean;
  onMatch?: () => void;
};

// The tmux-style state machine behind the one keydown listener. `handle` takes the chord a key
// makes (undefined for a bare modifier) and says whether the listener should swallow the key,
// let it pass, or `send` it: the table's own key pressed again, for the focused terminal.
export function createKeyDispatcher<Context>({ tables, run, onMatch }: KeyDispatcherOptions<Context>) {
  let state: KeyDispatchState | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();
  const set = (next: KeyDispatchState | undefined) => {
    if (timer !== undefined) clearTimeout(timer);
    timer = next === undefined ? undefined : setTimeout(() => set(undefined), next.expiresAt - Date.now());
    state = next;
    listeners.forEach(listener => listener());
  };
  const repeatable = (binding: KeyBinding | undefined) => typeof binding === 'string' && keyActions[binding]?.repeat === true;

  // try the most specific active focus condition before the always-active root table
  const handleDirect = (chord: string, event: Context, focusTables: readonly string[]): 'pass' | 'handled' => {
    const currentTables = tables();
    const directTables = [...new Set([...focusTables.filter(isFocusKeyTable), 'root'])];
    // let declined condition actions fall through to less-specific conditions
    for (const table of directTables) {
      // ambiguous direct shortcuts are swallowed without running either command
      if (currentTables[table]?.[chord]?.conflicted === true) return 'handled';
      const binding = lookupKeyBinding(currentTables, table, chord);
      if (binding === undefined) continue;
      // table leaders always consume their configured key
      if (isTableBinding(binding)) {
        onMatch?.();
        set({ table: binding.table, chord, repeat: false, expiresAt: Date.now() + keyTableTimeoutMs });
        return 'handled';
      }
      // declined direct actions leave the key available to the next condition or native input
      if (!run(binding, { table, chord, event })) continue;
      onMatch?.();
      return 'handled';
    }
    return 'pass';
  };

  const handle = (chord: string | undefined, event: Context, focusTables: readonly string[] = []): 'pass' | 'handled' | 'send' => {
    // a bare modifier is on its way to a chord, so it neither matches nor ends a table
    if (chord === undefined) return 'pass';
    const current = state;
    if (current === undefined) return handleDirect(chord, event, focusTables);
    if (current.confirm !== undefined) {
      set(undefined);
      // report only accepted confirmation keys
      if (chord === 'y' || chord === 'n') onMatch?.();
      if (chord === 'y') current.onYes();
      return 'handled';
    }
    const currentTables = tables();
    // conflicts end a pending or repeated table without falling through or sending the leader
    if (currentTables[current.table]?.[chord]?.conflicted === true) {
      set(undefined);
      return 'handled';
    }
    const binding = lookupKeyBinding(currentTables, current.table, chord);
    if (current.repeat) {
      // only another repeatable key continues a repeat; anything else returns to direct conditions
      if (!repeatable(binding)) { set(undefined); return handleDirect(chord, event, focusTables); }
      set({ ...current, expiresAt: Date.now() + keyRepeatMs });
      // report repeatable table matches
      onMatch?.();
      run(binding!, { table: current.table, chord, event });
      return 'handled';
    }
    if (binding === undefined) {
      set(undefined);
      // the key that entered the table, pressed again, goes to the focused terminal (send-prefix)
      if (chord === current.chord) {
        // report the repeated leader shortcut
        onMatch?.();
        return 'send';
      }
      return 'handled';
    }
    // report configured table matches before dispatch
    onMatch?.();
    if (isTableBinding(binding)) {
      set({ table: binding.table, chord, repeat: false, expiresAt: Date.now() + keyTableTimeoutMs });
      return 'handled';
    }
    set(repeatable(binding) ? { table: current.table, chord: current.chord, repeat: true, expiresAt: Date.now() + keyRepeatMs } : undefined);
    run(binding, { table: current.table, chord, event });
    return 'handled';
  };

  return {
    handle,
    state: () => state,
    // ask a y/n question; the next key answers it, and only `y` runs `onYes`
    confirm: (message: string, onYes: () => void) => set({ confirm: message, onYes, expiresAt: Date.now() + keyTableTimeoutMs }),
    reset: () => { if (state !== undefined) set(undefined); },
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; }
  };
}
