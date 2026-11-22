/** Indexed ANSI colors use the browser's terminal palette; explicit RGB colors are hex. */
type TerminalColor = number | string;
export type TerminalColorRange = { from: number; to: number; foreground?: TerminalColor; background?: TerminalColor; inverse?: true; dim?: true };
export type TerminalPreview = { text: string; colors?: TerminalColorRange[] };

type ColorState = Omit<TerminalColorRange, 'from' | 'to'> & { bold?: true };
const maxColorRanges = 1_024;
const sgr = /\x1b\[([0-9;:]*)m/gu;
// keep only rendition controls; never forward links, cursor actions or other terminal commands
const terminalControls = /(?:\x1b\]|\x9d)[\s\S]*?(?:\x07|\x1b\\|\x9c|$)|(?:\x1b[P^_X]|[\x90\x98\x9e\x9f])[\s\S]*?(?:\x1b\\|\x9c|$)|(?:\x1b\[|\x9b)(?:([0-9;:]*)m|[0-?]*[ -/]*[@-~])|\x1b[ -/]*[0-~]|[\x00-\x08\x0b-\x1f\x7f-\x9f]/gu;

// admit only actual ANSI palette indices and RGB channels
const byte = (value: string | undefined): number | undefined => {
  const index = Number(value);
  return value !== undefined && /^\d+$/u.test(value) && index <= 255 ? index : undefined;
};

// parse either extended palette indices or explicit RGB, including colon-form sRGB
const extendedColor = (mode: string | undefined, values: string[]): TerminalColor | undefined => {
  // indexed color has one argument
  if (mode === '5') return byte(values[0]);
  // only RGB mode and the default color space are supported
  if (mode !== '2' || !(values.length === 3 || values.length === 4 && (values[0] === '' || values[0] === '0'))) return undefined;
  const [red, green, blue] = values.slice(-3).map(byte);
  // reject incomplete controls instead of manufacturing a color
  if (red === undefined || green === undefined || blue === undefined) return undefined;
  return `#${((red << 16) | (green << 8) | blue).toString(16).padStart(6, '0')}`;
};

// apply just the color-affecting parameters of a rendition sequence
function updateColors(state: ColorState, parameters: string): ColorState {
  const groups = parameters.split(';');
  // consume extended-color arguments together so channels are never mistaken for SGR commands
  for (let index = 0; index < groups.length; index += 1) {
    const [head, ...parts] = groups[index]!.split(':');
    const code = Number(head);
    // handle standard, indexed and truecolor changes and their resets
    if (code === 38 || code === 48 || code === 58) {
      const mode = parts.length === 0 ? groups[index + 1] : parts[0];
      const count = mode === '2' ? 3 : mode === '5' ? 1 : 0;
      const color = extendedColor(mode, parts.length === 0 ? groups.slice(index + 2, index + 2 + count) : parts.slice(1));
      // colon parameters are self-contained
      if (parts.length === 0) index += count + 1;
      // ignore underline colors and leave the last valid color unchanged on malformed controls
      if (code !== 58 && color !== undefined) state[code === 38 ? 'foreground' : 'background'] = color;
    } else if (code === 0) state = {};
    else if (code >= 30 && code <= 37) state.foreground = code - 30;
    else if (code >= 90 && code <= 97) state.foreground = code - 82;
    else if (code >= 40 && code <= 47) state.background = code - 40;
    else if (code >= 100 && code <= 107) state.background = code - 92;
    else if (code === 39) state.foreground = undefined;
    else if (code === 49) state.background = undefined;
    else if (code === 1) state.bold = true;
    else if (code === 2) state.dim = true;
    else if (code === 22) { state.bold = undefined; state.dim = undefined; }
    else if (code === 7) state.inverse = true;
    else if (code === 27) state.inverse = undefined;
  }
  return state;
}

// append bounded, nonoverlapping ranges with UTF-16 offsets into the plain tail
function appendColor(ranges: TerminalColorRange[], from: number, to: number, state: ColorState): void {
  const { foreground, background, inverse, dim, bold } = state;
  // don't allocate ranges for empty spans, unstyled text or tails over the range budget
  if (to <= from || ranges.length > maxColorRanges || foreground === undefined && background === undefined && !inverse && !dim) return;
  // xterm brightens the displayed foreground, after applying inverse video
  const brighten = (color: TerminalColor | undefined) => bold && typeof color === 'number' && color < 8 ? color + 8 : color;
  ranges.push({ from, to, foreground: inverse ? foreground : brighten(foreground), background: inverse ? brighten(background) : background, inverse, dim });
}

// preserve colors inherited from earlier rows while returning only the requested plain-text tail
export function styledTerminalTail(value: string, rows: number, skipBlank = false, firstRow = 0): TerminalPreview {
  // select no text for an empty or invalid window
  if (!Number.isInteger(rows) || rows <= 0) return { text: '' };
  const styled = value.replace(terminalControls, (_token, parameters: string | undefined) => parameters === undefined ? '' : `\x1b[${parameters}m`).split('\n');
  // ignore the capture's final line terminator
  if (styled.at(-1) === '') styled.pop();
  const plain = styled.map(line => line.replace(sgr, ''));
  const selected = new Set(plain.flatMap((line, index) => index >= firstRow && (!skipBlank || line.trim() !== '') ? [index] : []).slice(-rows));
  const text: string[] = [];
  const colors: TerminalColorRange[] = [];
  let offset = 0;
  let state: ColorState = {};
  // read rendition state even on rows that won't be displayed
  for (let index = 0; index < styled.length; index += 1) {
    const visible = selected.has(index);
    // account for the newline only between displayed rows
    if (visible && text.length > 0) offset += 1;
    let cursor = 0;
    // split a row where its display color changes
    for (const control of styled[index]!.matchAll(sgr)) {
      const at = control.index;
      // attach the previous color to the text before this control
      if (visible) {
        appendColor(colors, offset, offset + at - cursor, state);
        offset += at - cursor;
      }
      state = updateColors(state, control[1]!);
      cursor = at + control[0].length;
    }
    // discard hidden rows after updating inherited state
    if (!visible) continue;
    const end = offset + styled[index]!.length - cursor;
    appendColor(colors, offset, end, state);
    offset = end;
    text.push(plain[index]!);
  }
  return { text: text.join('\n'), ...(colors.length > 0 && colors.length <= maxColorRanges ? { colors } : {}) };
}

// Claude's active composer and permission/question footers are UI chrome, not output
const claudeFooterLine = /^(?:\? for shortcuts\b|esc to interrupt\b|enter to select\b|enter to confirm\b|esc to cancel\b|[↑↓←→] to navigate\b|⏵⏵ .*permissions.*(?:shift\+tab|tab)\b)/iu;
const claudeChoice = /^❯\s+(?:\[[ xX]\]\s*)?\d+[.)]\s/u;
const claudeChoiceRow = /^(?:❯\s*)?\d+[.)]\s+\S/u;

// retain only Claude's current interaction while preserving its ANSI color data
export function claudeTerminalTail(value: string, rows: number): TerminalPreview | undefined {
  const normalized = value.replace(terminalControls, (_token, parameters: string | undefined) => parameters === undefined ? '' : `\x1b[${parameters}m`);
  const styled = normalized.split('\n');
  const plain = styled.map(line => line.replace(sgr, ''));
  const choiceRows = plain.filter(line => claudeChoiceRow.test(line.trim()));
  const activeChoice = choiceRows.length >= 2 && choiceRows.some(line => claudeChoice.test(line.trim())) && plain.some(line => claudeFooterLine.test(line.trim()));
  const submittedPrompt = plain.some(line => /^>\s+\S/u.test(line.trimStart()));
  const activeWork = plain.some(line => /\besc to interrupt\b/iu.test(line));
  let end = plain.length;
  // ignore the capture's final terminator and native footer rows
  while (end > 0 && (!plain[end - 1]!.trim() || claudeFooterLine.test(plain[end - 1]!.trim()))) end -= 1;
  // the last ordinary caret row is the live composer; numbered choices are visible output
  for (let index = end - 1; index >= 0; index -= 1) {
    const row = plain[index]!.trimStart();
    if (!row.startsWith('❯')) continue;
    if (!claudeChoice.test(row)) end = index;
    break;
  }
  const composer = end < plain.length && plain[end]?.trimStart().startsWith('❯') === true;
  // unknown scrollback cannot prove that its newest rows belong to this turn
  if (!composer && !activeChoice && !submittedPrompt && !activeWork) return undefined;
  let first = 0;
  // exclude previous turns when the current submitted prompt remains visible
  for (let index = end - 1; index >= 0; index -= 1) {
    if (/^>\s+\S/u.test(plain[index]!.trimStart())) { first = index + 1; break; }
  }
  return styledTerminalTail(styled.slice(0, end).join('\n'), rows, true, first);
}
