import { parseEnv } from 'node:util';
import { SettingsError } from './contracts.js';

export const envKey = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
// parse without mutating process environment
export function environment(content: string): Record<string, string> {
  // reject invalid text before parsing
  if (content.includes('\0') || Buffer.byteLength(content) > 1_048_576) throw new SettingsError('invalid_environment');
  return Object.fromEntries(Object.entries(parseEnv(content)).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

// retain complete quoted logical lines
function records(content: string): { text: string; key?: string }[] {
  const lines = content.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
  const result: { text: string; key?: string }[] = [];
  // group multiline quoted assignments
  for (let index = 0; index < lines.length; index += 1) {
    let text = lines[index]!;
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(['"`])?/u.exec(text);
    const quote = match?.[2];
    // find the closing delimiter without consuming adjacent entries
    if (quote !== undefined) {
      const start = match![0].length;
      // extend only an unfinished value
      while (!text.slice(start).includes(quote) && index + 1 < lines.length) text += lines[++index]!;
      // reject unterminated quoted input
      if (!text.slice(start).includes(quote)) throw new SettingsError('invalid_environment');
    }
    result.push({ text, ...(match === null ? {} : { key: match[1] }) });
  }
  return result;
}

// preserve untouched bytes and literal secrets
export function patchEnvironment(content: string, key: string, value?: string): string {
  // restrict assignment identities
  if (!envKey.test(key)) throw new SettingsError('invalid_environment_key');
  const entries = records(content);
  const matched = entries.filter(entry => entry.key === key);
  // require raw editing for ambiguous duplicate assignments
  if (matched.length > 1) throw new SettingsError('duplicate_environment_key');
  let replacement = '';
  // choose a literal representation that round-trips
  if (value !== undefined) {
    // reject placeholders and oversized strings
    if (value.includes('\0') || value.length > 65_536 || /^[•●*]{3,}$/u.test(value)) throw new SettingsError('invalid_environment_value');
    const quote = !value.includes("'") ? "'" : !value.includes('"') ? '"' : undefined;
    // refuse representations that Compose could interpolate or escape differently
    if (quote !== "'" && /[$\\]/u.test(value) || quote === undefined && /[\r\n#]/u.test(value)) throw new SettingsError('environment_value_requires_source_edit');
    const encoded = quote === undefined ? value : `${quote}${value}${quote}`;
    replacement = `${key}=${encoded}\n`;
    // do not silently change the submitted value
    if (environment(replacement)[key] !== value) throw new SettingsError('environment_value_requires_source_edit');
  }
  const rewritten = entries.map(entry => entry.key === key ? replacement : entry.text).join('');
  return matched.length > 0 || value === undefined ? rewritten : `${rewritten}${rewritten.length > 0 && !rewritten.endsWith('\n') ? '\n' : ''}${replacement}`;
}
