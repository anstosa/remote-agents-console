type ModelPickerLayout = { footer: number; earlierArrow?: number; unnumbered: number[] };

// identify the current native model list before treating its unnumbered caret as a prompt
export function codexModelPickerLayout(lines: readonly string[]): ModelPickerLayout | undefined {
  let footer = lines.length - 1;
  // ignore empty terminal rows below the keyboard hint
  while (footer >= 0 && !lines[footer]!.trim()) footer -= 1;
  const hint = lines[footer]?.trim();
  // narrow panes can split the keyboard hint after its separator
  if (hint === 'esc back' && lines[footer - 1]?.trim() === 'enter select ·') footer -= 1;
  // leave other menus and authored output alone
  else if (hint !== 'enter select · esc back') return undefined;
  let start = footer - 1;
  // look backward for the adjacent model heading, not an older menu in scrollback
  while (start >= 0 && lines[start]!.trim() !== 'Select Model and Effort') {
    const row = lines[start]!;
    // rows outside the selector cannot bridge the title and footer
    if (row.trim() && !/^(?:[↑↓]\s*$|› | {2})/u.test(row)) return undefined;
    start -= 1;
  }
  // require the native model heading
  if (start < 0) return undefined;
  let row = start + 1;
  // locate the first option and its optional overflow marker
  while (row < footer && !lines[row]!.trim()) row += 1;
  const earlierArrow = lines[row]?.trim() === '↑' ? row++ : undefined;
  const unnumbered: number[] = [];
  let previous: number | undefined;
  let selected = 0;
  // recognize exact option indentation and keep indented descriptions distinct
  for (; row < footer; row += 1) {
    const raw = lines[row]!;
    const numbered = /^(?:› | {2})([1-9])\. \S/u.exec(raw);
    // native numeric shortcuts stop at nine
    if (numbered) {
      const number = Number(numbered[1]);
      // require consecutive shortcuts
      if (previous !== undefined && number !== previous + 1) return undefined;
      previous = number;
    // accept post-nine options only at their native indentation
    } else if (/^(?:› {5}| {6})\S/u.test(raw) && (previous === undefined ? earlierArrow !== undefined : previous >= 9)) {
      previous = (previous ?? 9) + 1;
      unnumbered.push(row);
    // permit only aligned text continuations or native bottom spacing
    } else if (raw.trim() && raw.trim() !== '↓' && (previous === undefined || !/^ {5,}\S/u.test(raw))) return undefined;
    // only one native caret can supply the cursor for relative navigation
    if (raw.startsWith('›')) selected += 1;
  }
  return selected === 1 ? { footer, earlierArrow, unnumbered } : undefined;
}
