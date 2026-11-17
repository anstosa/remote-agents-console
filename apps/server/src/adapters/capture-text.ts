/**
 * Reading the visible text out of a raw `capture-pane -e -p` snapshot. A snapshot
 * carries the terminal's escape sequences; a pure Adapter matcher (question parsing,
 * new-conversation composer/readiness checks) wants the characters a person sees.
 * The shared home for the Claude-question and new-conversation matchers; the Codex
 * TUI parsers (`codex-turns.ts`, `codex-questions.ts`) keep their own stripping,
 * which tolerates an embedded ESC that these matchers never meet.
 */

/** drop capture styling without changing literal folder characters */
export function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/gu, '')  // OSC (e.g. hyperlinks)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, '');           // CSI (colours, cursor)
}

/**
 * Strip ANSI, turn box-drawing glyphs and the ascii bar into spaces (a boxed
 * composer or a wrapped line is drawn under `│ `/`─`), then collapse whitespace, so
 * a wrapped or box-framed row matches its plain string. The caret glyphs `❯`/`›`
 * and the Braille spinner sit outside the box-drawing range and survive.
 */
export function normalizeLine(line: string): string {
  return stripAnsi(line)
    .replace(/[─-╿|]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** Every line of a capture, ANSI-stripped and normalized (see {@link normalizeLine}). */
export function normalizedLines(capture: string): string[] {
  return capture.split('\n').map(normalizeLine);
}

/**
 * A whole multi-line capture flattened to one normalized line, so a substring or
 * regex can be matched across it (`normalizeLine` collapses newlines like any other
 * whitespace). Use this for "does the capture mention …" checks; use
 * {@link normalizedLines} when the row a match sits on matters.
 */
export function normalizedCapture(capture: string): string {
  return normalizeLine(capture);
}
