import { useMemo, type ReactNode, type Ref } from 'react';
import { highlightShellSource } from './settings/shell-source.js';

type TokenKind = 'comment'|'string'|'number'|'keyword'|'constant'|'tag'|'operator'|'property'|'command'|'option';
type HighlightSegment = { text: string; kind?: TokenKind };

type SyntaxHighlightedCodeProps = {
  path?: string;
  code: string;
  label?: string;
  language?: string;
  presentation?: boolean;
  preRef?: Ref<HTMLPreElement>;
};

// map exact filenames
const filenameLanguages: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile'
};

// map source extensions
const extensionLanguages: Record<string, string> = {
  bash: 'shell',
  c: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cs: 'csharp',
  css: 'css',
  env: 'env',
  go: 'go',
  graphql: 'graphql',
  gql: 'graphql',
  h: 'c',
  hpp: 'cpp',
  html: 'html',
  java: 'java',
  js: 'javascript',
  json: 'json',
  jsx: 'jsx',
  kt: 'kotlin',
  kts: 'kotlin',
  md: 'markdown',
  mdx: 'mdx',
  php: 'php',
  prisma: 'prisma',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  scss: 'scss',
  sh: 'shell',
  sql: 'sql',
  svelte: 'svelte',
  svg: 'xml',
  swift: 'swift',
  toml: 'toml',
  ts: 'typescript',
  tsx: 'tsx',
  vue: 'vue',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  zsh: 'shell'
};

// select comment grammars
const hashCommentLanguages = new Set(['dockerfile', 'env', 'makefile', 'python', 'ruby', 'shell', 'toml', 'yaml']);
const markupLanguages = new Set(['html', 'markdown', 'mdx', 'svelte', 'vue', 'xml']);
// match common source tokens
const keywords = String.raw`\b(?:abstract|and|as|async|await|break|case|catch|class|const|continue|def|default|delete|do|elif|else|enum|export|extends|finally|fn|for|from|function|go|if|implements|import|in|instanceof|interface|let|match|namespace|new|not|of|or|package|private|protected|public|readonly|return|select|static|struct|switch|throw|trait|try|type|typeof|var|void|while|with|yield)\b`;
const constants = String.raw`\b(?:false|null|nil|none|true|undefined)\b`;
const strings = String.raw`"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\x60(?:\\.|[^\x60\\])*\x60`;
const numbers = String.raw`\b(?:0x[\da-f]+|0b[01]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)\b`;
const operators = String.raw`(?:===|!==|==|!=|=>|->|<=|>=|&&|\|\||\?\?|\+\+|--|\+=|-=|\*=|\/=)`;

// infer one preview language
const languageForPath = (path: string) => {
  const filename = path.split('/').at(-1)?.toLowerCase() ?? '';
  const extension = filename.includes('.') ? filename.slice(filename.lastIndexOf('.') + 1) : '';
  return filenameLanguages[filename] ?? extensionLanguages[extension] ?? 'plaintext';
};

// build one language grammar
const tokenPattern = (language: string) => {
  const comment = markupLanguages.has(language)
    ? String.raw`<!--[\s\S]*?-->`
    : hashCommentLanguages.has(language)
      ? String.raw`#[^\n]*`
      : String.raw`\/\*[\s\S]*?\*\/|\/\/[^\n]*`;
  const tag = markupLanguages.has(language) ? String.raw`<\/?[A-Za-z][^>]*>` : String.raw`(?!)`;
  const property = language === 'env' ? String.raw`[A-Za-z_][A-Za-z0-9_]*(?=[ \t]*=)` : String.raw`(?!)`;
  return new RegExp(`(?<comment>${comment})|(?<string>${strings})|(?<tag>${tag})|(?<property>${property})|(?<number>${numbers})|(?<keyword>${keywords})|(?<constant>${constants})|(?<operator>${operators})`, 'gimu');
};

// tokenize Bash with the shared semantics-aware lexer
const highlightedShellSegments = (code: string): HighlightSegment[] => highlightShellSource(code);

// classify one matched token
const tokenKind = (match: RegExpExecArray): TokenKind => {
  const groups = match.groups ?? {};
  return groups.comment !== undefined ? 'comment'
    : groups.string !== undefined ? 'string'
      : groups.tag !== undefined ? 'tag'
        : groups.property !== undefined ? 'property'
          : groups.number !== undefined ? 'number'
            : groups.keyword !== undefined ? 'keyword'
              : groups.constant !== undefined ? 'constant'
                : 'operator';
};

// tokenize one preview safely
const highlightedSegments = (code: string, language: string): HighlightSegment[] => {
  // preserve unknown file contents
  if (language === 'plaintext') return [{ text: code }];
  // use Bash-aware lexical state for shell editors
  if (language === 'shell') return highlightedShellSegments(code);
  const segments: HighlightSegment[] = [];
  const pattern = tokenPattern(language);
  let cursor = 0;
  let match = pattern.exec(code);
  // consume every grammar match
  while (match !== null) {
    // preserve unmatched source
    if (match.index > cursor) segments.push({ text: code.slice(cursor, match.index) });
    const kind = tokenKind(match);
    segments.push({ text: match[0], kind });
    cursor = match.index + match[0].length;
    match = pattern.exec(code);
  }
  // preserve trailing source
  if (cursor < code.length) segments.push({ text: code.slice(cursor) });
  return segments;
};

// split tokens into numbered rows
const highlightedLines = (code: string, language: string): HighlightSegment[][] => {
  const lines: HighlightSegment[][] = [[]];
  // distribute every token segment
  for (const segment of highlightedSegments(code, language)) {
    const parts = segment.text.split('\n');
    // distribute every segment line
    for (let index = 0; index < parts.length; index += 1) {
      const text = parts[index]!;
      // retain visible fragments
      if (text !== '') lines[lines.length - 1]!.push({ text, ...(segment.kind === undefined ? {} : { kind: segment.kind }) });
      // advance after real newlines
      if (index < parts.length - 1) lines.push([]);
    }
  }
  return lines;
};

// render one highlighted fragment
const renderSegment = (segment: HighlightSegment, index: number): ReactNode => segment.kind === undefined
  ? segment.text
  : <span className={`syntax-${segment.kind}`} key={`${index}-${segment.kind}`}>{segment.text}</span>;

// render one numbered source row
const renderLine = (line: HighlightSegment[], index: number) => <span className="syntax-line" key={index}><span className="syntax-line-number" aria-hidden="true">{index + 1}</span><span className="syntax-line-content">{line.map(renderSegment)}</span></span>;

// render one highlighted preview
export function SyntaxHighlightedCode({ path = '', code, label, language: languageOverride, presentation = false, preRef }: SyntaxHighlightedCodeProps) {
  const language = languageOverride ?? languageForPath(path);
  // cache numbered token rows
  const lines = useMemo(() => highlightedLines(code, language), [code, language]);
  // keep editor decoration out of the accessibility tree
  if (presentation) return <pre ref={preRef} className="syntax-highlight-presentation" aria-hidden="true"><code data-language={language}>{lines.map(renderLine)}</code></pre>;
  // allow keyboard scrolling inside the preview modal
  return <pre ref={preRef} tabIndex={0} aria-label={label}><code data-language={language}>{lines.map(renderLine)}</code></pre>;
}
