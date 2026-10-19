import { getProcessor, LangVariant, type File } from 'sh-syntax';
import wasmAsset from 'sh-syntax/main.wasm?url';
import { formatShellCommandArguments, shellSourceCanFormat, shellSourceIndexAtPosition, type ShellSourceRange } from './shell-source.js';

const parserOptions = { filepath: 'settings.sh', keepComments: true, variant: LangVariant.LangBash, recoverErrors: 0, simplify: false, indent: 2, binaryNextLine: true, switchCaseIndent: true, spaceRedirects: true, keepPadding: false, functionNextLine: false } as const;
type ShellProcessor = ReturnType<typeof getProcessor>;

// normalize layout while retaining parsed literals, operators, comments, and heredocs
const structuralFingerprint = (processor: ShellProcessor, source: string): Promise<string> => processor(source, { ...parserOptions, print: true, singleLine: true });

// map parser byte positions onto browser string indexes
const statementRanges = (source: string, parsed: File): ShellSourceRange[] => parsed.Stmts.map(statement => {
  const start = shellSourceIndexAtPosition(source, statement.Pos);
  const end = shellSourceIndexAtPosition(source, statement.End);
  // fail closed rather than slicing through Unicode source
  if (start === undefined || end === undefined || start > end) throw new Error('Shell parser returned an invalid source range');
  return { start, end };
});

// parse and print shell drafts in an isolated worker without running commands
globalThis.addEventListener('message', async (event: MessageEvent<string>) => {
  try {
    // fail closed before shfmt can normalize carriage returns or unsafe delimiters
    if (!shellSourceCanFormat(event.data)) throw new Error('Shell source cannot be preserved safely');
    // load the Go shim in the worker before constructing its WebAssembly imports
    await import('sh-syntax/vendors/wasm_exec.cjs');
    const response = await fetch(wasmAsset);
    // reject asset failures without handing HTML to WebAssembly
    if (!response.ok) throw new Error('Shell formatter asset unavailable');
    const bytes = await response.arrayBuffer();
    const processor = getProcessor(() => bytes);
    // canonicalize Bash before applying the requested argv layout
    const canonical = await processor(event.data, { ...parserOptions, print: true });
    const parsed = await processor(canonical, parserOptions);
    const firstPass = formatShellCommandArguments(canonical, statementRanges(canonical, parsed));
    // let the parser settle indentation introduced by newly multiline constructs
    const printedAgain = await processor(firstPass, { ...parserOptions, print: true });
    const parsedAgain = await processor(printedAgain, parserOptions);
    const formatted = formatShellCommandArguments(printedAgain, statementRanges(printedAgain, parsedAgain));
    const printedFinal = await processor(formatted, { ...parserOptions, print: true });
    const parsedFinal = await processor(printedFinal, parserOptions);
    const stable = formatShellCommandArguments(printedFinal, statementRanges(printedFinal, parsedFinal));
    // reject a formatter that does not reach a fixed point after parser settling
    if (stable !== formatted) throw new Error('Shell formatter unstable');
    const canonicalStructure = await structuralFingerprint(processor, canonical);
    const formattedStructure = await structuralFingerprint(processor, formatted);
    // reject edits that alter parser-normalized program structure or literals
    if (formattedStructure !== canonicalStructure) throw new Error('Shell formatter changed program structure');
    globalThis.postMessage({ formatted });
  } catch {
    // never transmit parser errors that may include source or disclosed keys
    globalThis.postMessage({ failed: true });
  }
});
