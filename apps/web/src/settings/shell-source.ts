export type ShellSourceRange = { start: number; end: number };
export type ShellParserPosition = { Offset: number };
export type ShellHighlightKind = 'comment' | 'string' | 'number' | 'keyword' | 'constant' | 'operator' | 'property' | 'command' | 'option';
export type ShellHighlightSegment = { text: string; kind?: ShellHighlightKind };

type ShellTokenKind = 'word' | 'operator' | 'space' | 'newline' | 'comment' | 'heredoc' | 'unsafe';
type ShellToken = { kind: ShellTokenKind; text: string; start: number; end: number };
type PendingHeredoc = { delimiter: string; stripTabs: boolean };

const shellOperators = [';;&', '<<<', '<<-', '&&', '||', '|&', ';;', ';&', '>>', '&>', '<>', '>|', '<&', '>&', '[[', ']]', '((', '))', '<<', ';', '|', '&', '<', '>', '(', ')'] as const;
const commandSeparators = new Set([';', '&&', '||', '|', '|&', ';;', ';&', ';;&', '&', '(', ')', '[[', ']]', '((', '))']);
const shellKeywords = new Set(['break', 'case', 'continue', 'coproc', 'do', 'done', 'elif', 'else', 'esac', 'export', 'fi', 'for', 'function', 'if', 'in', 'local', 'readonly', 'return', 'select', 'then', 'time', 'typeset', 'until', 'while']);
const controlWords = new Set(['case', 'coproc', 'do', 'done', 'elif', 'else', 'esac', 'fi', 'for', 'function', 'if', 'in', 'select', 'then', 'time', 'until', 'while', '{', '}', '!']);
const commandIntroducers = new Set(['coproc', 'do', 'elif', 'else', 'if', 'then', 'time', 'until', 'while', '{', '!']);
const constants = new Set(['false', 'true']);
const assignmentPrefix = /^([A-Za-z_][A-Za-z0-9_]*)(=)/u;
const numberWord = /^(?:0x[\da-f]+|0b[01]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)$/iu;

// convert Go's UTF-8 byte offsets into JavaScript UTF-16 indexes
export const shellSourceIndexAtPosition = (source: string, position: ShellParserPosition): number | undefined => {
  const target = position.Offset;
  // reject positions outside the source byte stream
  if (!Number.isSafeInteger(target) || target < 0) return undefined;
  let bytes = 0;
  let index = 0;
  // count complete Unicode code points without splitting surrogates
  while (index < source.length) {
    // return exact boundaries before consuming their next code point
    if (bytes === target) return index;
    const point = source.codePointAt(index)!;
    const width = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    // reject byte offsets inside one encoded code point
    if (bytes + width > target) return undefined;
    bytes += width;
    index += point > 0xffff ? 2 : 1;
  }
  return bytes === target ? source.length : undefined;
};

// append adjacent fragments without changing source bytes
const appendHighlight = (segments: ShellHighlightSegment[], text: string, kind?: ShellHighlightKind) => {
  // omit empty lexer fragments
  if (text === '') return;
  const previous = segments.at(-1);
  // merge only identical adjacent classes
  if (previous !== undefined && previous.kind === kind) previous.text += text;
  else segments.push({ text, ...(kind === undefined ? {} : { kind }) });
};

// match one longest shell operator
const operatorAt = (source: string, index: number): string | undefined => {
  // prefer multi-byte operators over their prefixes
  for (const operator of shellOperators) {
    // return the first exact operator
    if (source.startsWith(operator, index)) return operator;
  }
  return undefined;
};

// advance through one shell quote
const quotedEnd = (source: string, start: number, quote: "'" | '"' | '`' | 'ansi'): number => {
  let index = start + 1;
  // retain quoted whitespace and operators as one word part
  while (index < source.length) {
    const character = source[index]!;
    // single quotes have no escape syntax
    if (quote !== "'" && character === '\\') {
      index = Math.min(index + 2, source.length);
      continue;
    }
    // keep nested expansions in their own quote context
    if (quote === '"') {
      // shield arithmetic expansion before command substitution
      if (source.startsWith('$((', index)) {
        index = balancedEnd(source, index, '$((', '))');
        continue;
      }
      // shield command and parameter substitutions
      if (source.startsWith('$(', index) || source.startsWith('${', index)) {
        const parameter = source.startsWith('${', index);
        index = balancedEnd(source, index, parameter ? '${' : '$(', parameter ? '}' : ')');
        continue;
      }
      // shield legacy command substitution quotes
      if (character === '`') {
        index = quotedEnd(source, index, '`');
        continue;
      }
    }
    // stop after the matching delimiter
    if (character === (quote === 'ansi' ? "'" : quote)) return index + 1;
    index += 1;
  }
  return source.length;
};

// advance through one balanced shell expansion
const balancedEnd = (source: string, start: number, open: string, close: string): number => {
  const opener = close === '}' ? '{' : '(';
  const closer = close.at(-1)!;
  let depth = [...open].filter(character => character === opener).length;
  let index = start + open.length;
  // shield nested substitutions until their matching delimiter
  while (index < source.length) {
    const character = source[index]!;
    // shield ANSI-C and locale quotes from their dollar prefix
    if (source.startsWith("$'", index) || source.startsWith('$"', index)) {
      index = quotedEnd(source, index + 1, source[index + 1] === "'" ? 'ansi' : '"');
      continue;
    }
    // skip quoted regions inside the expansion
    if (character === "'" || character === '"' || character === '`') {
      index = quotedEnd(source, index, character);
      continue;
    }
    // keep escaped delimiters literal
    if (character === '\\') {
      index = Math.min(index + 2, source.length);
      continue;
    }
    // count every nested grouping delimiter
    if (character === opener) {
      depth += 1;
      index += 1;
      continue;
    }
    // finish only the matching outer construct
    if (character === closer) {
      depth -= 1;
      index += 1;
      // return after the outer delimiter
      if (depth === 0) return index;
      continue;
    }
    index += 1;
  }
  return source.length;
};

// identify the next protected word fragment
const protectedEnd = (source: string, index: number): number | undefined => {
  const character = source[index];
  // shield Bash ANSI-C and locale-translated quotes from their dollar prefix
  if (source.startsWith("$'", index)) return quotedEnd(source, index + 1, 'ansi');
  if (source.startsWith('$"', index)) return quotedEnd(source, index + 1, '"');
  // shield literal and interpolated quotes
  if (character === "'" || character === '"' || character === '`') return quotedEnd(source, index, character);
  // shield parameter expansion
  if (source.startsWith('${', index)) return balancedEnd(source, index, '${', '}');
  // shield arithmetic expansion before command substitution
  if (source.startsWith('$((', index)) return balancedEnd(source, index, '$((', '))');
  // shield command substitution
  if (source.startsWith('$(', index)) return balancedEnd(source, index, '$(', ')');
  // shield process substitution
  if (source.startsWith('<(', index) || source.startsWith('>(', index)) return balancedEnd(source, index, source.slice(index, index + 2), ')');
  // shield extended globs that may contain whitespace
  if (index > 0 && '?*+@!'.includes(source[index - 1]!) && character === '(') return balancedEnd(source, index, '(', ')');
  return undefined;
};

// read one shell word without splitting quotes or expansions
const wordEnd = (source: string, start: number): number => {
  let index = start;
  // stop only at unprotected shell syntax
  while (index < source.length) {
    const character = source[index]!;
    const protectedIndex = protectedEnd(source, index);
    // skip complete protected fragments
    if (protectedIndex !== undefined) {
      index = protectedIndex;
      continue;
    }
    // retain escaped bytes and physical continuations
    if (character === '\\') {
      index = Math.min(index + 2, source.length);
      continue;
    }
    // end before lexical whitespace or an operator
    if (/\s/u.test(character) || operatorAt(source, index) !== undefined) break;
    index += 1;
  }
  return index;
};

// decode one ANSI-C quote escape without evaluating source
const ansiEscape = (raw: string, start: number): { text: string; end: number } | undefined => {
  const escaped = raw[start + 1];
  // reject an incomplete escape rather than guessing a delimiter
  if (escaped === undefined) return undefined;
  const simple = new Map([
    ['a', '\u0007'], ['b', '\b'], ['e', '\u001b'], ['E', '\u001b'], ['f', '\f'], ['n', '\n'], ['r', '\r'], ['t', '\t'], ['v', '\v'],
    ['\\', '\\'], ["'", "'"], ['"', '"'], ['?', '?']
  ]);
  const simpleValue = simple.get(escaped);
  // decode one named ANSI-C escape
  if (simpleValue !== undefined) return { text: simpleValue, end: start + 2 };
  // remove escaped physical newlines
  if (escaped === '\n') return { text: '', end: start + 2 };
  // decode Bash's one-to-three digit octal form
  if (/[0-7]/u.test(escaped)) {
    const digits = /^[0-7]{1,3}/u.exec(raw.slice(start + 1))![0];
    const value = Number.parseInt(digits, 8);
    // reject NUL because shell words cannot retain it
    if (value === 0) return undefined;
    return { text: String.fromCodePoint(value), end: start + 1 + digits.length };
  }
  // decode Bash's one-to-two digit hexadecimal form
  if (escaped === 'x') {
    const digits = /^[\da-f]{1,2}/iu.exec(raw.slice(start + 2))?.[0];
    // reject missing digits and NUL
    if (digits === undefined || Number.parseInt(digits, 16) === 0) return undefined;
    return { text: String.fromCodePoint(Number.parseInt(digits, 16)), end: start + 2 + digits.length };
  }
  // decode Bash's bounded Unicode forms
  if (escaped === 'u' || escaped === 'U') {
    const limit = escaped === 'u' ? 4 : 8;
    const digits = new RegExp(`^[\\da-f]{1,${limit}}`, 'iu').exec(raw.slice(start + 2))?.[0];
    // reject missing, NUL, surrogate, and out-of-range code points
    if (digits === undefined) return undefined;
    const value = Number.parseInt(digits, 16);
    if (value === 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) return undefined;
    return { text: String.fromCodePoint(value), end: start + 2 + digits.length };
  }
  // decode one Bash control-character escape
  if (escaped === 'c') {
    const control = raw[start + 2];
    // reject an incomplete control escape
    if (control === undefined) return undefined;
    const value = control.toUpperCase().codePointAt(0)! & 0x1f;
    // reject NUL because shell words cannot retain it
    if (value === 0) return undefined;
    return { text: String.fromCodePoint(value), end: start + 3 };
  }
  // Bash retains unknown ANSI-C escapes verbatim
  return { text: `\\${escaped}`, end: start + 2 };
};

// remove shell quoting from one heredoc delimiter word
const heredocDelimiter = (raw: string): string | undefined => {
  let delimiter = '';
  let quote: "'" | '"' | 'ansi' | undefined;
  let index = 0;
  // reject a multiline declaration that the line-oriented lexer cannot prove
  if (raw.includes('\n') || raw.includes('\r')) return undefined;
  // apply quote removal across concatenated shell word parts
  while (index < raw.length) {
    const character = raw[index]!;
    // decode bytes inside ANSI-C quotes
    if (quote === 'ansi') {
      // consume only the matching quote delimiter
      if (character === "'") {
        quote = undefined;
        index += 1;
        continue;
      }
      // decode one backslash escape without shell execution
      if (character === '\\') {
        const escape = ansiEscape(raw, index);
        // reject an escape that cannot be represented safely
        if (escape === undefined) return undefined;
        delimiter += escape.text;
        index = escape.end;
        continue;
      }
      delimiter += character;
      index += 1;
      continue;
    }
    // retain every byte inside single quotes
    if (quote === "'") {
      // consume only the matching quote delimiter
      if (character === "'") quote = undefined;
      else delimiter += character;
      index += 1;
      continue;
    }
    // enter Bash ANSI-C or locale-translated quoted word parts
    if (quote === undefined && character === '$' && (raw[index + 1] === "'" || raw[index + 1] === '"')) {
      quote = raw[index + 1] === "'" ? 'ansi' : '"';
      index += 2;
      continue;
    }
    // apply Bash's restricted escapes inside double quotes
    if (quote === '"') {
      // consume only the matching quote delimiter
      if (character === '"') {
        quote = undefined;
        index += 1;
        continue;
      }
      // remove escapes only for characters Bash treats specially here
      if (character === '\\' && index + 1 < raw.length && '$`"\\\n'.includes(raw[index + 1]!)) {
        const escaped = raw[index + 1]!;
        // remove escaped physical newlines entirely
        if (escaped !== '\n') delimiter += escaped;
        index += 2;
        continue;
      }
      delimiter += character;
      index += 1;
      continue;
    }
    // enter one quoted word part
    if (character === "'" || character === '"') {
      quote = character;
      index += 1;
      continue;
    }
    // remove an unquoted escape while retaining its literal byte
    if (character === '\\' && index + 1 < raw.length) {
      const escaped = raw[index + 1]!;
      // remove escaped physical newlines entirely
      if (escaped !== '\n') delimiter += escaped;
      index += 2;
      continue;
    }
    delimiter += character;
    index += 1;
  }
  // reject an unterminated quote rather than misclassifying the payload
  return quote === undefined ? delimiter : undefined;
};

// compare one physical line with a pending heredoc delimiter
const closesHeredoc = (line: string, heredoc: PendingHeredoc): boolean => {
  const withoutNewline = line.endsWith('\n') ? line.slice(0, -1) : line;
  const normalized = withoutNewline.endsWith('\r') ? withoutNewline.slice(0, -1) : withoutNewline;
  return (heredoc.stripTabs ? normalized.replace(/^\t+/u, '') : normalized) === heredoc.delimiter;
};

// tokenize Bash without evaluating or normalizing its contents
const shellTokens = (source: string): ShellToken[] => {
  const tokens: ShellToken[] = [];
  const pendingHeredocs: PendingHeredoc[] = [];
  let readingHeredocs = false;
  let waitingForHeredoc: { stripTabs: boolean } | undefined;
  let expressionDepth = 0;
  let index = 0;
  // consume every source byte exactly once
  while (index < source.length) {
    // shield heredoc payloads and delimiters as literal strings
    if (readingHeredocs && pendingHeredocs.length > 0) {
      const end = source.indexOf('\n', index);
      const lineEnd = end === -1 ? source.length : end + 1;
      const text = source.slice(index, lineEnd);
      tokens.push({ kind: 'heredoc', text, start: index, end: lineEnd });
      // advance to the next pending heredoc after its terminator
      if (closesHeredoc(text, pendingHeredocs[0]!)) {
        pendingHeredocs.shift();
        readingHeredocs = pendingHeredocs.length > 0;
      }
      index = lineEnd;
      continue;
    }

    const start = index;
    const character = source[index]!;
    // group ordinary spacing and escaped physical newlines
    if (character === ' ' || character === '\t' || character === '\r' || (character === '\\' && (source[index + 1] === '\n' || source[index + 1] === '\r'))) {
      // retain the complete separator for stable replacement
      while (index < source.length) {
        const current = source[index]!;
        // consume horizontal spacing
        if (current === ' ' || current === '\t' || current === '\r') {
          index += 1;
          continue;
        }
        // consume one escaped newline and its indentation
        if (current === '\\' && source[index + 1] === '\n') {
          index += 2;
          continue;
        }
        // consume one escaped CRLF and its indentation
        if (current === '\\' && source[index + 1] === '\r' && source[index + 2] === '\n') {
          index += 3;
          continue;
        }
        break;
      }
      tokens.push({ kind: 'space', text: source.slice(start, index), start, end: index });
      continue;
    }
    // activate heredoc payload shielding after a logical command line
    if (character === '\n') {
      index += 1;
      tokens.push({ kind: 'newline', text: '\n', start, end: index });
      readingHeredocs = pendingHeredocs.length > 0;
      continue;
    }
    // recognize comments only where a word can begin
    if (character === '#') {
      const end = source.indexOf('\n', index);
      index = end === -1 ? source.length : end;
      tokens.push({ kind: 'comment', text: source.slice(start, index), start, end: index });
      continue;
    }
    // shield process substitutions as one command argument
    if (source.startsWith('<(', index) || source.startsWith('>(', index)) {
      index = balancedEnd(source, index, source.slice(index, index + 2), ')');
      const text = source.slice(start, index);
      tokens.push({ kind: 'word', text, start, end: index });
      continue;
    }
    const operator = operatorAt(source, index);
    // emit structural operators independently
    if (operator !== undefined) {
      index += operator.length;
      tokens.push({ kind: 'operator', text: operator, start, end: index });
      // shield arithmetic and conditional operators from redirection parsing
      if (operator === '[[' || operator === '((') expressionDepth += 1;
      else if ((operator === ']]' || operator === '))') && expressionDepth > 0) expressionDepth -= 1;
      // remember only real heredoc declarations
      if (expressionDepth === 0 && (operator === '<<' || operator === '<<-')) waitingForHeredoc = { stripTabs: operator === '<<-' };
      continue;
    }
    index = wordEnd(source, index);
    // guarantee progress on parser-approved but unknown syntax
    if (index === start) index += 1;
    const text = source.slice(start, index);
    tokens.push({ kind: 'word', text, start, end: index });
    // queue the delimiter after its declaration word
    if (waitingForHeredoc !== undefined) {
      const delimiter = heredocDelimiter(text);
      // surface delimiters whose quote removal cannot be proven
      if (delimiter === undefined) tokens.push({ kind: 'unsafe', text: '', start: index, end: index });
      else pendingHeredocs.push({ delimiter, stripTabs: waitingForHeredoc.stripTabs });
      waitingForHeredoc = undefined;
    }
  }
  return tokens;
};

// reject source that cannot be preserved through the parser and delimiter lexer
export const shellSourceCanFormat = (source: string): boolean => !source.includes('\r') && !shellTokens(source).some(token => token.kind === 'unsafe');

// test whether one token is inside a parser-approved statement
const tokenInRanges = (token: ShellToken, ranges: readonly ShellSourceRange[]): boolean => {
  // accept a token only when one complete parser range owns it
  for (const range of ranges) {
    // preserve partially overlapping syntax instead of guessing
    if (token.start >= range.start && token.end <= range.end) return true;
  }
  return false;
};

// find the indentation of one command's first word
const commandIndent = (source: string, token: ShellToken, baseIndentation: string): string => {
  const lineStart = source.lastIndexOf('\n', token.start - 1) + 1;
  const prefix = source.slice(lineStart, token.start);
  const indentation = /^[ \t]*/u.exec(prefix)?.[0] ?? '';
  return `${indentation === '' ? baseIndentation : indentation}  `;
};

// pair long options with one lexical value without command-specific option schemas
const isLongOptionValue = (option: string, value: string): boolean => option !== '--'
  && /^--[^=]+$/u.test(option)
  && (value === '-' || !value.startsWith('-') || /^-(?:\d|\.\d)/u.test(value));

// format simple-command argv with explicit continuation lines
const formatShellCommandArgumentsOnce = (source: string, ranges: readonly ShellSourceRange[], baseIndentation: string): string => {
  const tokens = shellTokens(source);
  const replacements: Array<{ start: number; end: number; text: string }> = [];
  let wordCount = 0;
  let optionsEnded = false;
  let skipCommand = false;
  let previousWord: ShellToken | undefined;
  let separator: ShellToken | undefined;
  let indentation = '  ';
  let reuseIndentation = false;
  let arrayDepth = 0;
  let expressionDepth = 0;
  // inspect each parser-owned lexical token
  for (const token of tokens) {
    // preserve assignment-array elements rather than treating them as argv
    if (arrayDepth > 0) {
      // balance nested array groups
      if (token.kind === 'operator' && token.text === '(') arrayDepth += 1;
      else if (token.kind === 'operator' && token.text === ')') arrayDepth -= 1;
      continue;
    }
    // preserve complete conditional and arithmetic expressions
    if (expressionDepth > 0) {
      // balance nested expression delimiters across physical lines
      if (token.kind === 'operator' && (token.text === '[[' || token.text === '((')) expressionDepth += 1;
      else if (token.kind === 'operator' && (token.text === ']]' || token.text === '))')) expressionDepth -= 1;
      continue;
    }
    // enter an assignment array only when its opener is adjacent
    if (token.kind === 'operator' && token.text === '(' && previousWord?.text.endsWith('=') === true && separator === undefined) {
      arrayDepth = 1;
      wordCount = 0;
      skipCommand = false;
      previousWord = undefined;
      separator = undefined;
      continue;
    }
    // enter one conditional or arithmetic expression
    if (token.kind === 'operator' && (token.text === '[[' || token.text === '((')) {
      expressionDepth = 1;
      wordCount = 0;
      skipCommand = false;
      previousWord = undefined;
      separator = undefined;
      continue;
    }
    // reset command state at logical boundaries
    if (token.kind === 'newline') {
      wordCount = 0;
      skipCommand = false;
      previousWord = undefined;
      separator = undefined;
      reuseIndentation = false;
      continue;
    }
    // retain the root indentation across one command chain
    if (token.kind === 'operator' && commandSeparators.has(token.text)) {
      wordCount = 0;
      skipCommand = false;
      previousWord = undefined;
      separator = undefined;
      reuseIndentation = token.text === '|' || token.text === '|&' || token.text === '&&' || token.text === '||';
      continue;
    }
    // retain comments and heredoc payloads byte-for-byte
    if (token.kind === 'comment' || token.kind === 'heredoc') continue;
    // retain the whitespace candidate between adjacent words
    if (token.kind === 'space') {
      separator = token;
      continue;
    }
    // leave redirections and structural syntax in place
    if (token.kind === 'operator') {
      previousWord = undefined;
      separator = undefined;
      continue;
    }
    // never rewrite bytes outside the parser's statement spans
    if (!tokenInRanges(token, ranges)) {
      wordCount = 0;
      skipCommand = false;
      previousWord = undefined;
      separator = undefined;
      continue;
    }
    // begin a simple command after shell control prefixes
    if (wordCount === 0 && commandIntroducers.has(token.text)) {
      skipCommand = false;
      previousWord = undefined;
      separator = undefined;
      reuseIndentation = false;
      continue;
    }
    // initialize one simple command from its first word
    if (wordCount === 0) {
      optionsEnded = false;
      skipCommand = controlWords.has(token.text);
      // chained commands keep the left-hand command's stable indentation
      if (!reuseIndentation) indentation = commandIndent(source, token, baseIndentation);
      reuseIndentation = false;
    }
    // replace only lexical whitespace between real words
    if (!skipCommand && wordCount > 0 && previousWord !== undefined && separator !== undefined && tokenInRanges(separator, ranges)) {
      const keepValue = !optionsEnded && wordCount > 1 && isLongOptionValue(previousWord.text, token.text);
      replacements.push({ start: separator.start, end: separator.end, text: keepValue ? ' ' : ` \\\n${indentation}` });
    }
    // retain positional arguments after the explicit option terminator
    if (token.text === '--') optionsEnded = true;
    wordCount += 1;
    previousWord = token;
    separator = undefined;
  }
  let formatted = source;
  // apply right-to-left so source offsets remain authoritative
  for (let index = replacements.length - 1; index >= 0; index -= 1) {
    const replacement = replacements[index]!;
    formatted = `${formatted.slice(0, replacement.start)}${replacement.text}${formatted.slice(replacement.end)}`;
  }
  return formatted;
};

// find executable substitution bodies inside one shell word
const commandSubstitutionRanges = (word: ShellToken): ShellSourceRange[] => {
  const ranges: ShellSourceRange[] = [];
  let quote: "'" | '"' | undefined;
  let index = 0;
  // inspect protected word bytes without entering literal quotes
  while (index < word.text.length) {
    const character = word.text[index]!;
    // keep escaped substitution openers literal
    if (character === '\\') {
      index = Math.min(index + 2, word.text.length);
      continue;
    }
    // retain every byte inside single quotes
    if (quote === "'") {
      // leave the literal quote at its delimiter
      if (character === "'") quote = undefined;
      index += 1;
      continue;
    }
    // enter a literal single quote outside double quotes
    if (quote === undefined && character === "'") {
      quote = "'";
      index += 1;
      continue;
    }
    // track double quotes while still allowing command substitutions
    if (character === '"') {
      quote = quote === '"' ? undefined : '"';
      index += 1;
      continue;
    }
    // leave arithmetic expansions intact
    if (word.text.startsWith('$((', index)) {
      index = balancedEnd(word.text, index, '$((', '))');
      continue;
    }
    const commandOpen = word.text.startsWith('$(', index) ? '$('
      : quote === undefined && word.text.startsWith('<(', index) ? '<('
        : quote === undefined && word.text.startsWith('>(', index) ? '>('
          : undefined;
    // recurse into one executable substitution body
    if (commandOpen !== undefined) {
      const end = balancedEnd(word.text, index, commandOpen, ')');
      ranges.push({ start: word.start + index + 2, end: word.start + end - 1 });
      index = end;
      continue;
    }
    // skip legacy command substitutions conservatively
    if (character === '`') {
      index = quotedEnd(word.text, index, '`');
      continue;
    }
    index += 1;
  }
  return ranges;
};

// format nested command substitutions after the outer argv pass
const formatNestedShellCommands = (source: string, depth: number, baseIndentation: string): string => {
  // bound hostile nesting while leaving parser-approved bytes untouched
  if (depth >= 64) return source;
  const ranges = shellTokens(source).flatMap(token => token.kind === 'word' ? commandSubstitutionRanges(token) : []);
  let formatted = source;
  // format inner ranges from right to left without invalidating offsets
  for (let index = ranges.length - 1; index >= 0; index -= 1) {
    const range = ranges[index]!;
    const content = formatted.slice(range.start, range.end);
    const lineStart = formatted.lastIndexOf('\n', range.start - 3) + 1;
    const prefix = formatted.slice(lineStart, range.start - 2);
    const localIndentation = /^[ \t]*/u.exec(prefix)?.[0] ?? '';
    const nestedIndentation = localIndentation === '' ? baseIndentation : localIndentation;
    const nested = formatShellCommandArgumentsInternal(content, [{ start: 0, end: content.length }], depth + 1, nestedIndentation);
    formatted = `${formatted.slice(0, range.start)}${nested}${formatted.slice(range.end)}`;
  }
  return formatted;
};

// apply one stable argv layout across outer and nested commands
const formatShellCommandArgumentsInternal = (source: string, ranges: readonly ShellSourceRange[], depth: number, baseIndentation: string): string => {
  const formatted = formatShellCommandArgumentsOnce(source, ranges, baseIndentation);
  return formatNestedShellCommands(formatted, depth, baseIndentation);
};

// format parser-approved simple commands without evaluating source
export const formatShellCommandArguments = (source: string, ranges: readonly ShellSourceRange[]): string => {
  // retain source unchanged when its bytes cannot be preserved safely
  if (!shellSourceCanFormat(source)) return source;
  return formatShellCommandArgumentsInternal(source, ranges, 0, '');
};

// color protected fragments inside one ordinary word
const appendWordHighlights = (segments: ShellHighlightSegment[], word: string, fallback?: ShellHighlightKind) => {
  let cursor = 0;
  let index = 0;
  // classify every quoted or expanded fragment
  while (index < word.length) {
    const end = protectedEnd(word, index);
    // keep scanning until a protected fragment begins
    if (end === undefined) {
      index += 1;
      continue;
    }
    appendHighlight(segments, word.slice(cursor, index), fallback);
    appendHighlight(segments, word.slice(index, end), 'string');
    cursor = end;
    index = end;
  }
  appendHighlight(segments, word.slice(cursor), fallback);
};

// classify Bash tokens while preserving exact editor text
export const highlightShellSource = (source: string): ShellHighlightSegment[] => {
  const segments: ShellHighlightSegment[] = [];
  let commandPosition = true;
  // classify every lexical token
  for (const token of shellTokens(source)) {
    // retain spacing without decoration
    if (token.kind === 'space') {
      // color explicit continuations as shell operators
      const continuation = /\\\r?\n/u.exec(token.text);
      // keep ordinary whitespace plain
      if (continuation === null) appendHighlight(segments, token.text);
      else {
        appendHighlight(segments, token.text.slice(0, continuation.index));
        appendHighlight(segments, continuation[0], 'operator');
        appendHighlight(segments, token.text.slice(continuation.index + continuation[0].length));
      }
      continue;
    }
    // restart command detection after a real line boundary
    if (token.kind === 'newline') {
      appendHighlight(segments, token.text);
      commandPosition = true;
      continue;
    }
    // color comments and heredoc contents literally
    if (token.kind === 'comment' || token.kind === 'heredoc') {
      appendHighlight(segments, token.text, token.kind === 'comment' ? 'comment' : 'string');
      continue;
    }
    // color operators and restart after command separators
    if (token.kind === 'operator') {
      appendHighlight(segments, token.text, 'operator');
      // begin a new command after binary and list operators
      if (commandSeparators.has(token.text)) commandPosition = true;
      continue;
    }
    const assignment = commandPosition ? assignmentPrefix.exec(token.text) : null;
    // split assignment prefixes from their values
    if (assignment !== null) {
      appendHighlight(segments, assignment[1]!, 'property');
      appendHighlight(segments, assignment[2]!, 'operator');
      appendWordHighlights(segments, token.text.slice(assignment[0].length));
      continue;
    }
    // retain shell grammar words distinctly from executable names
    if (shellKeywords.has(token.text)) {
      appendHighlight(segments, token.text, 'keyword');
      commandPosition = controlWords.has(token.text);
      continue;
    }
    // color one executable at each command boundary
    if (commandPosition) {
      appendWordHighlights(segments, token.text, constants.has(token.text) ? 'constant' : 'command');
      commandPosition = false;
      continue;
    }
    // expose command-line flags as options
    if (/^-{1,2}[^-]/u.test(token.text)) {
      appendWordHighlights(segments, token.text, 'option');
      continue;
    }
    // retain scalar literals and protected fragments
    appendWordHighlights(segments, token.text, constants.has(token.text) ? 'constant' : numberWord.test(token.text) ? 'number' : undefined);
  }
  return segments;
};
