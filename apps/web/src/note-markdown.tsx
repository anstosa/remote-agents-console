import { Fragment, type ReactNode, type Ref } from 'react';

// a `#` link is one of the console's own addresses (`#worktree=<id>` opens that Workspace), so it stays in this tab
const safeLink = (value: string) => /^(?:https?:|mailto:|#)/iu.test(value) ? value : undefined;
// a bare URL is one more token, so emphasis cannot match inside it (`https://a.com/x_y_z`)
const inlinePattern = /(`([^`\n]+)`|\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*\n]+)\*\*|__([^_\n]+)__|~~([^~\n]+)~~|\*([^*\n]+)\*|_([^_\n]+)_|(?:https?:\/\/|mailto:|www\.)[^\s<]+)/giu;
const singleTildeListStrike = /(^|[^~])~([^~\n]+)~(?!~)/gu;

const trimLinkSuffix = (value: string) => {
  let end = value.length;
  while (end > 0 && /[.,!?;:]/u.test(value[end - 1]!)) end -= 1;
  for (const [closing, opening] of [[')', '('], [']', '['], ['}', '{']] as const) {
    while (value[end - 1] === closing && value.slice(0, end).split(closing).length > value.slice(0, end).split(opening).length) end -= 1;
  }
  return [value.slice(0, end), value.slice(end)] as const;
};

// Emphasis and link labels are parsed again, so `**[PR](url)**` links; `links` is off inside a
// label, so an anchor never nests another.
const inlineMarkdown = (text: string, key: string, links = true): ReactNode[] => {
  const content: ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(inlinePattern)) {
    const index = match.index ?? 0;
    const at = `${key}-${index}`;
    if (index > cursor) content.push(text.slice(cursor, index));
    if (match[2] !== undefined) content.push(<code key={at}>{match[2]}</code>);
    else if (match[3] !== undefined && match[4] !== undefined) {
      const href = links ? safeLink(match[4]) : undefined;
      const label = inlineMarkdown(match[3], at, false);
      content.push(href === undefined ? <Fragment key={at}>{label}</Fragment> : href.startsWith('#') ? <a key={at} href={href}>{label}</a> : <a key={at} href={href} target="_blank" rel="noreferrer">{label}</a>);
    } else if (match[5] !== undefined || match[6] !== undefined) content.push(<strong key={at}>{inlineMarkdown(match[5] ?? match[6]!, at, links)}</strong>);
    else if (match[7] !== undefined) content.push(<del key={at}>{inlineMarkdown(match[7], at, links)}</del>);
    else if (match[8] !== undefined || match[9] !== undefined) content.push(<em key={at}>{inlineMarkdown(match[8] ?? match[9]!, at, links)}</em>);
    else if (!links) content.push(match[0]);
    else {
      const [label, suffix] = trimLinkSuffix(match[0]);
      content.push(<a key={at} href={label.startsWith('www.') ? `https://${label}` : label} target="_blank" rel="noreferrer">{label}</a>);
      if (suffix) content.push(suffix);
    }
    cursor = index + match[0].length;
  }
  if (cursor < text.length) content.push(text.slice(cursor));
  return content;
};

// preserve source lines inside one paragraph
const inlineMarkdownLines = (lines: string[], key: string): ReactNode[] => lines.map((line, index) => <Fragment key={`${key}-line-${index}`}>{index > 0 && <br />}{inlineMarkdown(line, `${key}-line-${index}`)}</Fragment>);

const startsBlock = (line: string) => /^(?:\s*$|#{1,6}\s+|```|>\s?|[-*+]\s+|\d+[.)]\s+|(?:-{3,}|\*{3,}|_{3,})\s*$)/u.test(line);

type TableAlignment = 'left' | 'center' | 'right' | undefined;

// share safe inline rendering and scrolling across table formats
const renderTable = (headers: string[], rows: string[][], start: number, alignments: TableAlignment[] = []): ReactNode => (
  <div className="note-table-scroll" key={`table-${start}`}><table>
    <thead><tr>{headers.map(
      // preserve accessible column headers even without body rows
      (header, column) => <th key={`head-${column}`} scope="col" style={{ textAlign: alignments[column] }}>{inlineMarkdown(header, `table-head-${start}-${column}`)}</th>
    )}</tr></thead>
    {/* omit empty body sections */}
    {rows.length > 0 && <tbody>{rows.map(
      // retain stable row identities
      (row, rowIndex) => <tr key={`row-${rowIndex}`}>{row.map(
        // render cell contents without interpreting html
        (cell, column) => <td key={`cell-${column}`} style={{ textAlign: alignments[column] }}>{inlineMarkdown(cell, `table-cell-${start}-${rowIndex}-${column}`)}</td>
      )}</tr>
    )}</tbody>}
  </table></div>
);

// split table cells while respecting escaped separators
const pipeTableCells = (line: string) => {
  const row = line.trim();
  const cells = [''];
  // consume escaped pipes before considering separators
  for (let index = 0; index < row.length; index += 1) {
    const character = row[index]!;
    const next = row[index + 1];
    // only the backslash immediately before a pipe escapes it
    if (character === '\\' && next === '|') {
      cells[cells.length - 1] += next;
      index += 1;
    // start a cell at each unescaped pipe
    } else if (character === '|') {
      cells.push('');
    } else cells[cells.length - 1] += character;
  }
  // discard optional outer borders
  if (cells.length > 1 && cells[0] === '') cells.shift();
  // retain genuine empty cells between borders
  if (cells.length > 1 && cells[cells.length - 1] === '') cells.pop();
  // trim padding without changing inline cell content
  return cells.map(cell => cell.trim());
};

// recognize a matching header and delimiter without consuming body rows
const pipeTableHeader = (lines: string[], start: number) => {
  const line = lines[start] ?? '';
  const delimiter = lines[start + 1] ?? '';
  // keep other blocks and ordinary paragraphs out of table parsing
  if (startsBlock(line) || !delimiter.includes('|') || !/^[\s|:-]+$/u.test(delimiter)) return undefined;
  const header = pipeTableCells(line);
  const rule = pipeTableCells(delimiter);
  // require matching header and delimiter column counts
  if (header.length !== rule.length) return undefined;
  // validate every delimiter before converting the block
  if (!rule.every(cell => /^:?-+:?$/u.test(cell))) return undefined;
  // derive each column's optional alignment markers
  const alignments: TableAlignment[] = rule.map(cell => cell.endsWith(':') ? (cell.startsWith(':') ? 'center' : 'right') : cell.startsWith(':') ? 'left' : undefined);
  return { headers: header, alignments };
};

// parse standard markdown pipe tables
const pipeTable = (lines: string[], start: number, cellBudget: number): { block: ReactNode; next: number; cellCount: number } | undefined => {
  const header = pipeTableHeader(lines, start);
  // leave unmatched syntax as ordinary markdown
  if (header === undefined) return undefined;
  let next = start + 2;
  // find the complete table before allocating any padded rows
  while (next < lines.length && !startsBlock(lines[next]!)) next += 1;
  const cellCount = header.headers.length * (next - start - 1);
  // consume oversized tables as text so their rows cannot be reparsed
  if (cellCount > cellBudget) {
    return {
      block: <p key={`table-source-${start}`}>{inlineMarkdownLines(lines.slice(start, next), `table-source-${start}`)}</p>,
      next,
      cellCount: 0
    };
  }
  // materialize rows only after the complete table fits the note budget
  const rows = lines.slice(start + 2, next).map(line => {
    const row = pipeTableCells(line);
    // pad missing cells and ignore excess cells
    return header.headers.map((_, column) => row[column] ?? '');
  });
  return { block: renderTable(header.headers, rows, start, header.alignments), next, cellCount };
};

type TableColumn = { start: number; end?: number };

const tableDividerColumns = (line: string, header = false): TableColumn[] | undefined => {
  if (header && !/[━═]/u.test(line)) return undefined;
  if (!/^[━─═\s]+$/u.test(line)) return undefined;
  const runs = [...line.matchAll(/[━─═]{3,}/gu)];
  if (runs.length < 2) return undefined;
  return runs.map((run, index) => ({ start: run.index, end: runs[index + 1]?.index }));
};

const tableCells = (lines: string[], columns: TableColumn[]) => columns.map(column => lines
  .map(line => line.slice(column.start, column.end).trim())
  .filter(Boolean)
  .join(' '));

// preserve fixed-width terminal tables alongside markdown tables
const pseudoTable = (lines: string[], start: number): { block: ReactNode; next: number } | undefined => {
  let headerRule = start + 1;
  while (headerRule < Math.min(lines.length, start + 4) && lines[headerRule]!.trim()) {
    const columns = tableDividerColumns(lines[headerRule]!, true);
    if (columns !== undefined) {
      const headers = tableCells(lines.slice(start, headerRule), columns);
      if (headers.some(header => !header)) return undefined;
      const rows: string[][] = [];
      let rowLines: string[] = [];
      let index = headerRule + 1;
      const finishRow = () => {
        if (rowLines.length === 0) return;
        const cells = tableCells(rowLines, columns);
        if (cells.some(Boolean)) rows.push(cells);
        rowLines = [];
      };
      while (index < lines.length && lines[index]!.trim()) {
        if (tableDividerColumns(lines[index]!) !== undefined) finishRow();
        else rowLines.push(lines[index]!);
        index += 1;
      }
      finishRow();
      if (rows.length === 0) return undefined;
      return {
        block: renderTable(headers, rows, start),
        next: index
      };
    }
    headerRule += 1;
  }
  return undefined;
};

type ListMarker = { indent: number; ordered: boolean; number?: number; checked?: boolean; text: string };
type ListItem = { marker: ListMarker; lines: string[]; children: ParsedList[] };
type ParsedList = { ordered: boolean; start?: number; items: ListItem[] };

const listMarker = (line: string): ListMarker | undefined => {
  const match = /^(\s*)(?:(\d+)[.)]|([-*+]))\s+(?:\[([ xX])\]\s+)?(.*)$/u.exec(line);
  if (!match) return undefined;
  const [, indentation = '', orderedNumber, , checkedMarker, text = ''] = match;
  return {
    indent: indentation.replace(/\t/gu, '    ').length,
    ordered: orderedNumber !== undefined,
    ...(orderedNumber === undefined ? {} : { number: Number(orderedNumber) }),
    ...(checkedMarker === undefined ? {} : { checked: checkedMarker.toLowerCase() === 'x' }),
    text
  };
};

const parseList = (lines: string[], start: number, first: ListMarker): { list: ParsedList; next: number } => {
  const indent = first.indent;
  const list: ParsedList = { ordered: first.ordered, ...(first.number === undefined ? {} : { start: first.number }), items: [] };
  let index = start;
  while (index < lines.length) {
    const marker = listMarker(lines[index] ?? '');
    if (marker === undefined || marker.indent !== indent || marker.ordered !== list.ordered) break;
    const item: ListItem = { marker, lines: [marker.text], children: [] };
    index += 1;
    let endList = false;
    while (index < lines.length) {
      if (!lines[index]!.trim()) {
        let next = index + 1;
        while (next < lines.length && !(lines[next] ?? '').trim()) next += 1;
        const nextMarker = next < lines.length ? listMarker(lines[next] ?? '') : undefined;
        if (nextMarker !== undefined && nextMarker.indent >= indent) {
          index = next;
          if (nextMarker.indent === indent) break;
          continue;
        }
        index = next;
        endList = true;
        break;
      }
      const nestedMarker = listMarker(lines[index] ?? '');
      if (nestedMarker !== undefined) {
        if (nestedMarker.indent === indent) break;
        if (nestedMarker.indent < indent) { endList = true; break; }
        const nested = parseList(lines, index, nestedMarker);
        item.children.push(nested.list);
        index = nested.next;
        continue;
      }
      const continuationIndent = /^\s*/u.exec(lines[index] ?? '')?.[0].replace(/\t/gu, '    ').length ?? 0;
      if (continuationIndent > indent) {
        item.lines.push((lines[index] ?? '').trim());
        index += 1;
        continue;
      }
      endList = true;
      break;
    }
    list.items.push(item);
    if (endList) break;
  }
  return { list, next: index };
};

// render nested lists with paired single-tilde compatibility
const renderList = (list: ParsedList, key: string): ReactNode => {
  const items = list.items.map((item, index) => <li key={`${key}-item-${index}`}>{item.marker.checked !== undefined && <input type="checkbox" checked={item.marker.checked} readOnly tabIndex={-1} />}{inlineMarkdown(item.lines.join(' ').replace(singleTildeListStrike, '$1~~$2~~'), `${key}-item-${index}`)}{item.children.map((child, childIndex) => renderList(child, `${key}-item-${index}-child-${childIndex}`))}</li>);
  return list.ordered ? <ol key={key} start={list.start}>{items}</ol> : <ul key={key}>{items}</ul>;
};

// render note markdown blocks
// render recognized blocks while preserving paragraph boundaries
export function MarkdownBlocks({ text }: { text: string }) {
  const lines = text.replace(/\r\n?/gu, '\n').split('\n');
  const blocks: ReactNode[] = [];
  // bound generated pipe-table cells across the entire note
  let remainingPipeTableCells = 10_000;
  // consume each parsed block once
  for (let index = 0; index < lines.length;) {
    const line = lines[index]!;
    if (!line.trim()) { index += 1; continue; }
    // recognize markdown and terminal table blocks
    const parsedPipeTable = pipeTable(lines, index, remainingPipeTableCells);
    const table = parsedPipeTable ?? pseudoTable(lines, index);
    // advance past either table format or its bounded fallback
    if (table !== undefined) {
      // debit only pipe tables that are actually rendered
      remainingPipeTableCells -= parsedPipeTable?.cellCount ?? 0;
      blocks.push(table.block);
      index = table.next;
      continue;
    }
    const fence = /^```([^\s`]*)\s*$/u.exec(line);
    if (fence) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/u.test(lines[index]!)) code.push(lines[index++]!);
      if (index < lines.length) index += 1;
      blocks.push(<pre key={`code-${index}`}><code data-language={fence[1] || undefined}>{code.join('\n')}</code></pre>);
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/u.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      const children = inlineMarkdown(heading[2]!, `heading-${index}`);
      blocks.push(level === 1 ? <h1 key={`heading-${index}`}>{children}</h1> : level === 2 ? <h2 key={`heading-${index}`}>{children}</h2> : level === 3 ? <h3 key={`heading-${index}`}>{children}</h3> : level === 4 ? <h4 key={`heading-${index}`}>{children}</h4> : level === 5 ? <h5 key={`heading-${index}`}>{children}</h5> : <h6 key={`heading-${index}`}>{children}</h6>);
      index += 1;
      continue;
    }
    if (/^(?:-{3,}|\*{3,}|_{3,})\s*$/u.test(line)) { blocks.push(<hr key={`rule-${index}`} />); index += 1; continue; }
    if (/^>\s?/u.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^>\s?/u.test(lines[index]!)) quote.push(lines[index++]!.replace(/^>\s?/u, ''));
      blocks.push(<blockquote key={`quote-${index}`}>{quote.map((value, quoteIndex) => <Fragment key={`quote-line-${quoteIndex}`}>{quoteIndex > 0 && <br />}{inlineMarkdown(value, `quote-${index}-${quoteIndex}`)}</Fragment>)}</blockquote>);
      continue;
    }
    const marker = listMarker(line);
    if (marker !== undefined) {
      const parsed = parseList(lines, index, marker);
      blocks.push(renderList(parsed.list, `list-${index}`));
      index = parsed.next;
      continue;
    }
    const paragraph = [line.trim()];
    index += 1;
    // let a table header interrupt the current paragraph
    while (index < lines.length && !startsBlock(lines[index]!) && pipeTableHeader(lines, index) === undefined) paragraph.push(lines[index++]!.trim());
    blocks.push(<p key={`paragraph-${index}`}>{inlineMarkdownLines(paragraph, `paragraph-${index}`)}</p>);
  }
  return <>{blocks}</>;
}

export function NoteMarkdown({ text, containerRef }: { text: string; containerRef?: Ref<HTMLDivElement> }) {
  return <div ref={containerRef} className="note-markdown" role="document" aria-label="Note preview" tabIndex={0}><MarkdownBlocks text={text} /></div>;
}
