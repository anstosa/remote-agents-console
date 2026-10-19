import type { SettingsSource } from './contracts.js';

export type SettingsCodeFormat = SettingsSource['format'];

const jsonFormats = new Set<SettingsCodeFormat>(['credentials', 'installation', 'json']);
const yamlFormats = new Set<SettingsCodeFormat>(['compose', 'cloudflared']);
const markerPattern = /__RAC_PROTECTED_[A-Za-z0-9_-]{43}__/gu;

// expose only errors that cannot disclose editor content
export class SettingsCodeFormatError extends Error {}

// enable supported source parsers without guessing at environment syntax
export const canPrettyFormatSettingsCode = (format?: SettingsCodeFormat): boolean => format !== undefined
  && (jsonFormats.has(format) || yamlFormats.has(format) || format === 'wrapper' || format === 'svg');

// provide safe feedback without forwarding parser errors or source snippets
export const settingsCodeFormatFailure = (format?: SettingsCodeFormat): string => {
  // retain the existing JSON validation message
  if (format !== undefined && jsonFormats.has(format)) return 'Enter valid JSON before formatting. The editor was not changed.';
  const name = format !== undefined && yamlFormats.has(format) ? 'YAML' : format === 'svg' ? 'SVG' : 'shell';
  return `Unable to format ${name}. Check its syntax and try again. The editor was not changed.`;
};

// isolate the shell runtime's globals and retire its memory after each draft operation
async function prettyFormatShell(value: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const worker = new Worker(new URL('./shell-format-worker.ts', import.meta.url), { type: 'module' });
  let removeAbortListener = () => {};
  try {
    return await new Promise<string>((resolve, reject) => {
      // retire pending plaintext as soon as the editor or disclosure is invalidated
      const abort = () => reject(new DOMException('Formatting cancelled', 'AbortError'));
      signal?.addEventListener('abort', abort, { once: true });
      removeAbortListener = () => signal?.removeEventListener('abort', abort);
      // accept only the worker's safe result envelope
      worker.onmessage = (event: MessageEvent<{ formatted?: unknown }>) => {
        if (typeof event.data?.formatted === 'string') resolve(event.data.formatted);
        else reject(new Error('Shell formatter unavailable'));
      };
      // do not forward runtime diagnostics or source snippets to the editor
      worker.onerror = event => { event.preventDefault(); reject(new Error('Shell formatter unavailable')); };
      worker.onmessageerror = () => reject(new Error('Shell formatter unavailable'));
      worker.postMessage(value);
    });
  } finally {
    removeAbortListener();
    worker.terminate();
  }
}

// retain opaque credentials and the YAML context needed to restore hidden scalars
function preserveProtectedMarkers(original: string, formatted: string, format: SettingsCodeFormat): void {
  const originalMarkers = original.match(markerPattern) ?? [];
  const formattedMarkers = formatted.match(markerPattern) ?? [];
  // reject removed, duplicated, reordered, or rewritten markers
  if (JSON.stringify(originalMarkers) !== JSON.stringify(formattedMarkers)) throw new SettingsCodeFormatError('Formatting would change protected keys. The editor was not changed.');
  // hidden YAML blocks cannot be safely rebased to a different indentation or wrapper
  if (yamlFormats.has(format) && originalMarkers.length > 0) {
    const protectedLines = (content: string) => content.split(/\r?\n/u).filter(line => /__RAC_PROTECTED_[A-Za-z0-9_-]{43}__/u.test(line));
    // preserve the complete mapping line rather than guessing at hidden scalar bytes
    if (JSON.stringify(protectedLines(original)) !== JSON.stringify(protectedLines(formatted))) throw new SettingsCodeFormatError('Formatting would change protected keys. The editor was not changed.');
  }
}

// select lazy browser parsers and apply only stable, reversible draft formatting
export async function prettyFormatSettingsCode(value: string, format: SettingsCodeFormat, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  // leave unsupported source contracts untouched
  if (!canPrettyFormatSettingsCode(format)) return value;
  let formatSource: (source: string) => Promise<string>;
  // preserve numeric lexemes instead of round-tripping through JavaScript numbers
  if (jsonFormats.has(format)) {
    const [prettier, babel, estree] = await Promise.all([import('prettier/standalone'), import('prettier/plugins/babel'), import('prettier/plugins/estree')]);
    formatSource = async source => {
      // require strict JSON without using the parsed value as formatter output
      JSON.parse(source);
      const formatted = await prettier.format(source, { parser: 'json-stringify', plugins: [babel, estree], tabWidth: 2, useTabs: false, endOfLine: 'lf', embeddedLanguageFormatting: 'off' });
      return formatted.trimEnd();
    };
  } else if (yamlFormats.has(format)) {
    const [prettier, yaml] = await Promise.all([import('prettier/standalone'), import('prettier/plugins/yaml')]);
    formatSource = source => prettier.format(source, { parser: 'yaml', plugins: [yaml], tabWidth: 2, useTabs: false, proseWrap: 'preserve', endOfLine: 'auto', embeddedLanguageFormatting: 'off' });
  } else if (format === 'svg') {
    const [prettier, xml] = await Promise.all([import('prettier/standalone'), import('@prettier/plugin-xml')]);
    formatSource = source => prettier.format(source, { parser: 'xml', plugins: [xml.default], tabWidth: 2, useTabs: false, xmlWhitespaceSensitivity: 'strict', xmlQuoteAttributes: 'preserve', xmlSortAttributesByKey: false, endOfLine: 'auto', embeddedLanguageFormatting: 'off' });
  } else {
    const formatted = await prettyFormatShell(value, signal);
    preserveProtectedMarkers(value, formatted, format);
    // the isolated worker already reparses and verifies its own stable output
    return formatted;
  }
  // stop lazy parser work after any editor or security transition
  signal?.throwIfAborted();
  const formatted = await formatSource(value);
  signal?.throwIfAborted();
  preserveProtectedMarkers(value, formatted, format);
  // require reparsing and a stable second pass before accepting any output
  if (await formatSource(formatted) !== formatted) throw new SettingsCodeFormatError('Formatting was not stable. The editor was not changed.');
  return formatted;
}
