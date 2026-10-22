export type DiffRow = { hunk: number; old?: number; new?: number; text: string };

// number a unified patch's rows; anything before the first hunk header (a file header) is skipped,
// so this reads both a tour Change's patch and GitHub's header-less `patch`
export function diffRows(patch: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let hunk = -1;
  let oldLine = 0;
  let newLine = 0;
  for (const line of patch.split('\n')) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(line);
    if (header !== null) { hunk += 1; oldLine = Number(header[1]); newLine = Number(header[2]); continue; }
    if (hunk < 0) continue;
    const text = line.slice(1);
    if (line.startsWith('-')) rows.push({ hunk, old: oldLine++, text });
    else if (line.startsWith('+')) rows.push({ hunk, new: newLine++, text });
    else if (line.startsWith(' ')) rows.push({ hunk, old: oldLine++, new: newLine++, text });
  }
  return rows;
}
