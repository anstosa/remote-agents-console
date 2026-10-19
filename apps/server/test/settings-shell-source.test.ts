import { describe, expect, it } from 'vitest';
import { formatShellCommandArguments, highlightShellSource, shellSourceCanFormat, shellSourceIndexAtPosition, type ShellSourceRange } from '../../web/src/settings/shell-source.js';

// cover one parser-approved source range in isolation
const wholeSource = (source: string): ShellSourceRange[] => [{ start: 0, end: source.length }];
const bashEdgeSource = [
  '#!/usr/bin/env bash',
  'items=(alpha "two words")',
  'trimmed=${value##prefix}',
  '((mask = 1 << 2))',
  'shifted=$((1 << 2))',
  '((mask = $((1 + 1)) << 2))',
  '((',
  '  mask = 1 << 2',
  '))',
  'printf \'%s\\n\' \\"literal',
  '# actual escaped comment',
  '((mask = 1 << 2)); cat <<\'ARITH_EOF\'',
  '# arithmetic heredoc',
  'ARITH_EOF',
  'message="first line',
  '# literal double quote',
  'then remains text"',
  'if [[ ${#items[@]} -gt 0 ]];then',
  '  case "${items[0]}" in',
  '    alpha) printf \'%s\\n\' "${items[0]#a}" ;;',
  '    *) printf \'%s\\n\' "fallback # text" ;;',
  '  esac',
  'fi',
  'for item in "${items[@]}";do',
  '  printf \'%s\\n\' "$item"',
  'done',
  'cat <<\'EOF\' > >(sed \'s/^/item: /\')',
  '# heredoc bytes stay literal',
  'EOF',
  '# actual comment',
  ''
].join('\n');

describe('settings shell source presentation', () => {
  it('keeps long options with their next value on one continued line', () => {
    const source = `command --name "two words" --retry 3 --timeout -0.5 --stdin - --flag --mode=safe positional -x short -- --literal value\n`;
    const formatted = formatShellCommandArguments(source, wholeSource(source));

    expect(formatted).toBe(`command \\\n  --name "two words" \\\n  --retry 3 \\\n  --timeout -0.5 \\\n  --stdin - \\\n  --flag \\\n  --mode=safe \\\n  positional \\\n  -x \\\n  short \\\n  -- \\\n  --literal \\\n  value\n`);
    expect(formatShellCommandArguments(formatted, wholeSource(formatted))).toBe(formatted);
  });

  it('joins continued option values without crossing command or redirection boundaries', () => {
    const source = `command --output \\\n  "$out" --data "$(printf '%s' "$payload")" --header 'X-Name: two words' --before >"$file" after --last # retain comment\necho next\n`;
    const formatted = formatShellCommandArguments(source, wholeSource(source));

    expect(formatted).toBe(`command \\\n  --output "$out" \\\n  --data "$(printf \\\n    '%s' \\\n    "$payload")" \\\n  --header 'X-Name: two words' \\\n  --before >"$file" \\\n  after \\\n  --last # retain comment\necho \\\n  next\n`);
    expect(formatShellCommandArguments(formatted, wholeSource(formatted))).toBe(formatted);
  });

  it('resets option grouping at the next logical command', () => {
    const source = `command -- --literal value | command --name next\ncommand --other value\n`;

    expect(formatShellCommandArguments(source, wholeSource(source))).toBe(`command \\\n  -- \\\n  --literal \\\n  value | command \\\n  --name next\ncommand \\\n  --other value\n`);
  });

  it('wraps standalone arguments while keeping option values together', () => {
    const source = `#!/usr/bin/env bash\nexec docker run --rm --name "two words" "\${IMAGE:-rac}" "$@"\n`;

    expect(formatShellCommandArguments(source, wholeSource(source))).toBe(`#!/usr/bin/env bash\nexec \\\n  docker \\\n  run \\\n  --rm \\\n  --name "two words" \\\n  "\${IMAGE:-rac}" \\\n  "$@"\n`);
  });

  it('preserves control flow, comments, substitutions, pipelines, and heredoc payloads', () => {
    const source = `if [[ \${MODE:-safe} == safe ]]; then\n  payload=$(curl --fail "https://example.test/a b")\n  printf '%s\\n' alpha "two words" "$payload" # retain comment\n  curl --fail "$url" | jq --raw-output '.value'\n  cat --number <<'EOF'\n  exact   heredoc bytes\nEOF\nfi\n`;

    expect(formatShellCommandArguments(source, wholeSource(source))).toBe(`if [[ \${MODE:-safe} == safe ]]; then\n  payload=$(curl \\\n    --fail "https://example.test/a b")\n  printf \\\n    '%s\\n' \\\n    alpha \\\n    "two words" \\\n    "$payload" # retain comment\n  curl \\\n    --fail "$url" | jq \\\n    --raw-output '.value'\n  cat \\\n    --number <<'EOF'\n  exact   heredoc bytes\nEOF\nfi\n`);
  });

  it('is stable for already formatted continuations', () => {
    const source = `command \\\n  --flag "two words"\n`;

    expect(formatShellCommandArguments(source, wholeSource(source))).toBe(source);
  });

  it('keeps nested substitution quotes separate from the outer quoted argument', () => {
    const source = `printf '%s\\n' "$(printf "%s %s" alpha beta)" tail\n`;
    const formatted = formatShellCommandArguments(source, wholeSource(source));

    expect(formatted).toBe(`printf \\\n  '%s\\n' \\\n  "$(printf \\\n    "%s %s" \\\n    alpha \\\n    beta)" \\\n  tail\n`);
    expect(formatted).toContain('"%s %s"');
    expect(formatted).not.toContain('"%s \\\n');
    expect(formatShellCommandArguments(formatted, wholeSource(formatted))).toBe(formatted);
  });

  it('formats commands introduced by common control-flow syntax', () => {
    const source = `if printf '%s' alpha beta; then echo ok; fi\nwhile curl --fail --retry 3 "$url"; do echo ok; done\nfoo() { command --one alpha beta; }\ncoproc echo alpha beta\n`;
    const formatted = formatShellCommandArguments(source, wholeSource(source));

    expect(formatted).toContain(`if printf \\\n  '%s' \\\n  alpha \\\n  beta; then echo \\\n  ok; fi`);
    expect(formatted).toContain(`while curl \\\n  --fail \\\n  --retry 3 \\\n  "$url"; do echo \\\n  ok; done`);
    expect(formatted).toContain(`foo() { command \\\n  --one alpha \\\n  beta; }`);
    expect(formatted).toContain(`coproc echo \\\n  alpha \\\n  beta`);
  });

  it('formats commands in compact case arms without changing patterns', () => {
    const source = `case $x in a|b) command --one alpha beta ;; *) printf '%s' fallback ;; esac\n`;
    const formatted = formatShellCommandArguments(source, wholeSource(source));

    expect(formatted).toContain(`a|b) command \\\n  --one alpha \\\n  beta`);
    expect(formatted).toContain(`*) printf \\\n  '%s' \\\n  fallback`);
    expect(formatted).toContain(';; esac');
  });

  it('removes quotes from mixed heredoc delimiters before resuming commands', () => {
    const source = `cat <<E"OF"\npayload # literal\nEOF\ncommand --after alpha beta\ncat <<E\\"OF\nsecond payload\nE"OF\necho done\n`;
    const formatted = formatShellCommandArguments(source, wholeSource(source));
    const segments = highlightShellSource(source);

    expect(formatted).toBe(`cat <<E"OF"\npayload # literal\nEOF\ncommand \\\n  --after alpha \\\n  beta\ncat <<E\\"OF\nsecond payload\nE"OF\necho \\\n  done\n`);
    expect(segments.filter(segment => segment.kind === 'command').map(segment => segment.text)).toEqual(['cat', 'command', 'cat', 'echo']);
    expect(segments.filter(segment => segment.kind === 'comment')).toEqual([]);
    expect(segments.map(segment => segment.text).join('')).toBe(source);
  });

  it('decodes ANSI-C and locale heredoc delimiters before resuming commands', () => {
    const source = `cat <<$'E\\x4fF'\nansi payload\nEOF\ncommand --after value\ncat <<$"EOF"\nlocale payload\nEOF\necho done\n`;
    const formatted = formatShellCommandArguments(source, wholeSource(source));
    const segments = highlightShellSource(source);

    expect(shellSourceCanFormat(source)).toBe(true);
    expect(formatted).toContain(`command \\\n  --after value`);
    expect(formatted).toContain(`echo \\\n  done`);
    expect(segments.filter(segment => segment.kind === 'command').map(segment => segment.text)).toEqual(['cat', 'command', 'cat', 'echo']);
    expect(segments.map(segment => segment.text).join('')).toBe(source);
  });

  it('fails closed before CRLF or unrepresentable ANSI-C delimiters reach shfmt', () => {
    const crlf = `printf '<%q>\\n' alpha beta\r\n`;
    const nulDelimiter = `cat <<$'E\\0OF'\npayload\nEOF\n`;

    expect(shellSourceCanFormat(crlf)).toBe(false);
    expect(shellSourceCanFormat(nulDelimiter)).toBe(false);
    expect(formatShellCommandArguments(crlf, wholeSource(crlf))).toBe(crlf);
    expect(formatShellCommandArguments(nulDelimiter, wholeSource(nulDelimiter))).toBe(nulDelimiter);
  });

  it('keeps escaped apostrophes inside ANSI-C arguments', () => {
    const source = `printf '%s\\n' $'it\\'s here' tail --after\n`;
    const formatted = formatShellCommandArguments(source, wholeSource(source));
    const segments = highlightShellSource(source);

    expect(formatted).toBe(`printf \\\n  '%s\\n' \\\n  $'it\\'s here' \\\n  tail \\\n  --after\n`);
    expect(segments.filter(segment => segment.kind === 'command').map(segment => segment.text)).toEqual(['printf']);
    expect(segments.filter(segment => segment.kind === 'option').map(segment => segment.text)).toEqual(['--after']);
    expect(segments.map(segment => segment.text).join('')).toBe(source);
  });

  it('keeps ANSI-C quotes balanced inside command substitutions', () => {
    const source = `$(printf '%s' $'it\\'s here') tail --after\n`;
    const formatted = formatShellCommandArguments(source, wholeSource(source));
    const segments = highlightShellSource(source);

    expect(formatted).toContain(`$(printf \\\n  '%s' \\\n  $'it\\'s here')`);
    expect(formatted).toContain(`tail \\\n  --after`);
    expect(segments.filter(segment => segment.kind === 'option').map(segment => segment.text)).toEqual(['--after']);
    expect(segments.map(segment => segment.text).join('')).toBe(source);
  });

  it('maps Unicode parser offsets before failing closed on CRLF source', () => {
    const source = `# café 中文 🐢\r\nMODE=safe printf '%s' 'café 中文 🐢' escaped\\ value $(printf '%s' $(echo nested)) "$@" >"$out"\r\n`;
    const commandStart = source.indexOf('MODE=');
    const commandEnd = source.length - 2;
    const byteStart = Buffer.byteLength(source.slice(0, commandStart));
    const byteEnd = Buffer.byteLength(source.slice(0, commandEnd));
    const turtleByte = Buffer.byteLength(source.slice(0, source.indexOf('🐢')));
    const ranges = [{
      start: shellSourceIndexAtPosition(source, { Offset: byteStart })!,
      end: shellSourceIndexAtPosition(source, { Offset: byteEnd })!
    }];

    expect(ranges).toEqual([{ start: commandStart, end: commandEnd }]);
    expect(shellSourceIndexAtPosition(source, { Offset: turtleByte + 1 })).toBeUndefined();
    expect(formatShellCommandArguments(source, ranges)).toBe(source);
  });

  it('classifies shell commands, options, assignments, expansions, operators, and comments', () => {
    const source = `MODE=safe exec docker --flag "two words" "$HOME" | cat # note\n`;
    const segments = highlightShellSource(source);

    expect(segments.filter(segment => segment.kind === 'command').map(segment => segment.text)).toEqual(['exec', 'cat']);
    expect(segments.filter(segment => segment.kind === 'property').map(segment => segment.text)).toContain('MODE');
    expect(segments.filter(segment => segment.kind === 'option').map(segment => segment.text)).toEqual(['--flag']);
    expect(segments.filter(segment => segment.kind === 'string').map(segment => segment.text)).toEqual(expect.arrayContaining(['"two words"', '"$HOME"']));
    expect(segments.filter(segment => segment.kind === 'operator').map(segment => segment.text)).toEqual(expect.arrayContaining(['=', '|']));
    expect(segments.filter(segment => segment.kind === 'comment').map(segment => segment.text)).toEqual(['# note']);
    expect(segments.map(segment => segment.text).join('')).toBe(source);
  });

  it('does not bleed strings or formatting across Bash arithmetic and heredocs', () => {
    const segments = highlightShellSource(bashEdgeSource);
    const formatted = formatShellCommandArguments(bashEdgeSource, wholeSource(bashEdgeSource));

    expect(segments.map(segment => segment.text).join('')).toBe(bashEdgeSource);
    expect(segments.filter(segment => segment.kind === 'keyword').map(segment => segment.text)).toEqual([
      'if', 'then', 'case', 'in', 'esac', 'fi', 'for', 'in', 'do', 'done'
    ]);
    expect(segments.filter(segment => segment.kind === 'comment').map(segment => segment.text)).toEqual([
      '#!/usr/bin/env bash', '# actual escaped comment', '# actual comment'
    ]);
    expect(formatted).toContain('items=(alpha "two words")');
    expect(formatted).toContain('(\n  mask = 1 << 2\n))');
    expect(formatted).toContain('cat <<\'EOF\' > >(sed \\\n  \'s/^/item: /\')\n# heredoc bytes stay literal\nEOF');
    expect(formatted).toContain('printf \\\n  \'%s\\n\' \\\n  \\"literal');
    expect(formatShellCommandArguments(formatted, wholeSource(formatted))).toBe(formatted);
  });
});
