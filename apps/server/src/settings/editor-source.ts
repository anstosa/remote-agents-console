import { createHash } from 'node:crypto';
import { protectedEnvironment, protectedPath, protectedSettingIdentity } from './catalog.js';
import { SettingsError, type SettingsFormat } from './contracts.js';
import { environment } from './env.js';

type Span = { start: number; end: number; identity: string; original: string; marker: string };
type CandidateSpan = { start: number; end: number; original: string; base: string };
type EditorSource = { content: string; hasProtectedContent: boolean };
const markerPattern = /__RAC_PROTECTED_[A-Za-z0-9_-]{43}__/gu;

// keep longer credential literals first so overlapping values redact as one span
function normalizedCredentialValues(values: readonly string[]): string[] {
  return [...new Set(values.filter(value => value.length > 0))].sort((left, right) => right.length - left.length || left.localeCompare(right));
}

// derive one revision-bound opaque placeholder without encoding its field identity
function marker(revisionId: string, identity: string): string {
  return `__RAC_PROTECTED_${createHash('sha256').update(revisionId).update('\0').update(identity).digest('base64url')}__`;
}

// reject placeholder-like source bytes before they can become ambiguous editor state
function rejectMarkerCollision(content: string): void {
  markerPattern.lastIndex = 0;
  // fail closed on a source value that impersonates the editor protocol
  if (markerPattern.test(content)) throw new SettingsError('settings_editor_marker_collision', 409);
}

// classify credential leaves consistently for application and credential JSON documents
function protectedJsonPath(path: string[], format: SettingsFormat): boolean {
  const key = path.at(-1) ?? '';
  return protectedPath(path) || format === 'credentials' && key === 'TunnelSecret';
}

// locate authorization credential portions without assuming a fixed auth scheme
function headerCredentialRanges(content: string): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  // inspect every recognized header name independently
  for (const header of content.matchAll(/(?:Authorization|X-Api-Key)\s*:\s*/giu)) {
    let valueStart = header.index + header[0].length;
    let valueEnd = content.indexOf('\n', valueStart);
    if (valueEnd < 0) valueEnd = content.length;
    const directQuote = content[valueStart];
    const precedingQuote = content[header.index - 1];
    // stop at a direct quoted header value such as a JSON property
    if (directQuote === "'" || directQuote === '"') {
      valueEnd = inlineScalarEnd(content, valueStart) - 1;
      valueStart += 1;
    } else if (precedingQuote === "'" || precedingQuote === '"') {
      const quotedEnd = inlineScalarEnd(content, header.index - 1) - 1;
      // use only a quote that actually wraps the complete header
      if (quotedEnd >= valueStart) valueEnd = quotedEnd;
    }
    // exclude trailing whitespace without exposing it as credential material
    while (valueEnd > valueStart && /\s/u.test(content[valueEnd - 1]!)) valueEnd -= 1;
    const value = content.slice(valueStart, valueEnd);
    const scheme = header[0].toLowerCase().startsWith('authorization') ? /^\S+\s+/u.exec(value) : null;
    // preserve only the nonsecret scheme token when one is present
    const credentialStart = valueStart + (scheme?.[0].length ?? 0);
    if (credentialStart < valueEnd) ranges.push({ start: credentialStart, end: valueEnd });
  }
  return ranges;
}

// discover credential bytes embedded inside otherwise ordinary scalar settings
function embeddedCredentialValues(content: string): string[] {
  const result: string[] = [];
  // retain complete private-key blocks as one credential
  for (const match of content.matchAll(/-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----[\s\S]*?-----END \1-----/gu)) result.push(match[0]);
  // retain complete authorization credential portions across auth schemes
  for (const range of headerCredentialRanges(content)) result.push(content.slice(range.start, range.end));
  // retain only URL user-info password bytes
  for (const match of content.matchAll(/:\/\/[^\s/@:]+:([^\s/@]+)@/gu)) result.push(match[1]!);
  // retain credential-bearing long-option values without their shell syntax
  for (const match of content.matchAll(/--([A-Za-z][A-Za-z0-9_-]*)(?:\s*=\s*|\s+)(?:"([^"]*)"|'([^']*)'|([^\s#"',}\]]+))/gu)) {
    if (protectedSettingIdentity(match[1]!)) result.push(match[2] ?? match[3] ?? match[4] ?? '');
  }
  // retain credential-named inline assignment values inside commands and flow scalars
  for (const match of content.matchAll(/(?:^|[\s;,{])([A-Za-z_][A-Za-z0-9_]*)(?:\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s#;,}\]]+))/gmu)) {
    if (protectedSettingIdentity(match[1]!)) result.push(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return normalizedCredentialValues(result);
}

// collect scalar strings from a credential-bearing JSON value
function scalarStrings(value: unknown, result: string[]): void {
  // retain nonempty string credential material only
  if (typeof value === 'string') { if (value.length > 0) result.push(value); return; }
  // traverse nested credential containers conservatively
  if (Array.isArray(value)) { for (const child of value) scalarStrings(child, result); return; }
  // traverse plain credential object values conservatively
  if (value !== null && typeof value === 'object') for (const child of Object.values(value)) scalarStrings(child, result);
}

// collect credential values that must also be masked when repeated in another source
export function credentialValues(content: string, format: SettingsFormat): string[] {
  const result: string[] = embeddedCredentialValues(content);
  // parse dotenv through the same literal model as the settings editor
  if (format === 'env') {
    const values = environment(content);
    // collect named credentials and credential syntax embedded in ordinary values
    for (const [key, value] of Object.entries(values)) {
      if (protectedEnvironment(key) && value.length > 0) result.push(value);
      result.push(...embeddedCredentialValues(value));
    }
    return normalizedCredentialValues(result);
  }
  // parse JSON-backed sources without treating formatting as semantics
  if (format === 'json' || format === 'installation' || format === 'credentials') {
    let parsed: unknown;
    // distinguish invalid syntax from later traversal failures
    try { parsed = JSON.parse(content); } catch { return normalizedCredentialValues(result); }
    const visit = (value: unknown, path: string[] = []): void => {
      // discover credential syntax inside ordinary JSON string settings
      if (typeof value === 'string') result.push(...embeddedCredentialValues(value));
      // collect every scalar inside a credential-bearing leaf
      if (path.length > 0 && protectedJsonPath(path, format)) { scalarStrings(value, result); return; }
      // traverse arrays by stable indexes
      if (Array.isArray(value)) { for (let index = 0; index < value.length; index += 1) visit(value[index], [...path, String(index)]); return; }
      // traverse object properties by their declared identities
      if (value !== null && typeof value === 'object') for (const [key, child] of Object.entries(value)) visit(child, [...path, key]);
    };
    visit(parsed);
  }
  return normalizedCredentialValues(result);
}

// retain one marker for each credential-bearing JSON leaf
function redactJsonValue(value: unknown, format: SettingsFormat, revisionId: string, path: string[] = [], found = new Map<string, unknown>()): unknown {
  // replace only the selected credential value
  if (path.length > 0 && protectedJsonPath(path, format)) {
    // keep unset credential leaves literal and reveal-free
    if (value === '' || value === null || value === undefined) return value;
    const identity = `json:${JSON.stringify(path)}`;
    found.set(marker(revisionId, identity), value);
    return marker(revisionId, identity);
  }
  // preserve array shape and ordering
  if (Array.isArray(value)) return value.map((child, index) => redactJsonValue(child, format, revisionId, [...path, String(index)], found));
  // preserve object shape and safe values
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redactJsonValue(child, format, revisionId, [...path, key], found)]));
  return value;
}

// replace exact markers wherever their credential-bearing row moved in valid JSON
function restoreJsonValue(value: unknown, format: SettingsFormat, revisionId: string, expected: Map<string, unknown>, seen: Set<string>, path: string[] = []): unknown {
  // consume only a complete expected marker at a credential path
  if (typeof value === 'string' && value.startsWith('__RAC_PROTECTED_')) {
    const identity = `json:${JSON.stringify(path)}`;
    if (value !== marker(revisionId, identity) || !expected.has(value) || !protectedJsonPath(path, format) || seen.has(value)) throw new SettingsError('settings_protected_content_changed');
    seen.add(value);
    return structuredClone(expected.get(value));
  }
  // reject a marker hidden inside an edited scalar
  if (typeof value === 'string') {
    markerPattern.lastIndex = 0;
    if (markerPattern.test(value)) throw new SettingsError('settings_protected_content_changed');
    return value;
  }
  // restore every array member independently
  if (Array.isArray(value)) return value.map((child, index) => restoreJsonValue(child, format, revisionId, expected, seen, [...path, String(index)]));
  // restore every object property independently
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, restoreJsonValue(child, format, revisionId, expected, seen, [...path, key])]));
  return value;
}

// split text into offset-bearing physical lines without normalizing newline bytes
function physicalLines(content: string): { start: number; contentEnd: number; end: number; text: string }[] {
  const result: { start: number; contentEnd: number; end: number; text: string }[] = [];
  const matches = content.matchAll(/[^\n]*(?:\n|$)/gu);
  // retain each nonempty physical record and its exact offsets
  for (const match of matches) {
    if (match[0].length === 0) continue;
    const start = match.index;
    const newlineLength = match[0].endsWith('\n') ? match[0].endsWith('\r\n') ? 2 : 1 : 0;
    result.push({ start, contentEnd: start + match[0].length - newlineLength, end: start + match[0].length, text: match[0].slice(0, match[0].length - newlineLength) });
  }
  return result;
}

// assign stable per-identity ordinals after overlapping recognizers are resolved
function finalizeSpans(content: string, candidates: CandidateSpan[], revisionId: string): Span[] {
  const counts = new Map<string, number>();
  const spans: Span[] = [];
  // prefer the widest match when two recognizers cover the same bytes
  for (const candidate of [...candidates].sort((left, right) => left.start - right.start || right.end - left.end)) {
    if (spans.some(span => candidate.start < span.end && candidate.end > span.start)) continue;
    const base = candidate.base;
    const ordinal = (counts.get(base) ?? 0) + 1;
    counts.set(base, ordinal);
    const identity = `${base}:${ordinal}`;
    spans.push({ start: candidate.start, end: candidate.end, original: content.slice(candidate.start, candidate.end), identity, marker: marker(revisionId, identity) });
  }
  return spans.sort((left, right) => left.start - right.start);
}

// select one shell-style scalar without hiding the command that follows it
function shellValueEnd(text: string, start: number): number {
  const quote = text[start];
  // retain one same-line quoted scalar
  if (quote === "'" || quote === '"') {
    const closing = text.indexOf(quote, start + 1);
    return closing < 0 ? text.length : closing + 1;
  }
  const match = /[\s#]/u.exec(text.slice(start));
  return match === null ? text.length : start + match.index;
}

// find one inline JSON or YAML scalar without consuming neighboring fields
function inlineScalarEnd(content: string, start: number): number {
  const quote = content[start];
  // scan quoted scalars through escaped quote bytes
  if (quote === "'" || quote === '"') {
    for (let index = start + 1; index < content.length; index += 1) {
      // skip characters escaped by an odd backslash run
      if (content[index] !== quote) continue;
      let backslashes = 0;
      for (let previous = index - 1; previous >= start && content[previous] === '\\'; previous -= 1) backslashes += 1;
      // stop on the first unescaped closing quote
      if (backslashes % 2 === 0) return index + 1;
    }
    return content.length;
  }
  const match = /[,}\r\n#]/u.exec(content.slice(start));
  const end = match === null ? content.length : start + match.index;
  return end - (/\s*$/u.exec(content.slice(start, end))?.[0].length ?? 0);
}

// discover credential values in dotenv, YAML, Compose, and trusted wrapper text
function literalSpans(content: string, protectedValues: readonly string[], revisionId: string): Span[] {
  const candidates: CandidateSpan[] = [];
  // mask every exact occurrence of a credential already identified in another source
  normalizedCredentialValues(protectedValues).forEach((value, valueIndex) => {
    let start = content.indexOf(value);
    // retain every nonoverlapping exact occurrence
    while (start >= 0) {
      candidates.push({ start, end: start + value.length, original: value, base: `literal:${valueIndex}` });
      start = content.indexOf(value, start + value.length);
    }
  });
  return finalizeSpans(content, candidates, revisionId);
}

// discover credential values in dotenv, YAML, Compose, and trusted wrapper text
function textSpans(content: string, format: SettingsFormat, revisionId: string, protectedValues: readonly string[] = []): Span[] {
  const candidates: CandidateSpan[] = [];
  const lines = physicalLines(content);
  // protect complete PEM private-key blocks before line-oriented recognizers
  for (const match of content.matchAll(/-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----[\s\S]*?-----END \1-----/gu)) {
    candidates.push({ start: match.index, end: match.index + match[0].length, original: match[0], base: `pem:${match[1]}` });
  }
  // inspect each physical assignment or mapping row
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]!;
    const composeAssignment = /^(\s*-\s*)(["'])([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*?)\2(?:\s*(?:#.*)?)?$/u.exec(line.text);
    // hide values in quoted Compose environment-list assignments
    if (composeAssignment !== null && protectedSettingIdentity(composeAssignment[3]!)) {
      const valueStart = line.start + composeAssignment[1]!.length + composeAssignment[2]!.length + composeAssignment[3]!.length + composeAssignment[4]!.length;
      candidates.push({ start: valueStart, end: valueStart + composeAssignment[5]!.length, original: composeAssignment[5]!, base: `assignment:${composeAssignment[3]!.toUpperCase()}` });
      continue;
    }
    const assignment = /^(\s*(?:-\s*)?(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$/u.exec(line.text);
    // hide credential assignment values but retain their names and separators
    if (assignment !== null && protectedSettingIdentity(assignment[2]!)) {
      const valueStart = line.start + assignment[1]!.length + assignment[2]!.length + assignment[3]!.length;
      let valueEnd = line.contentEnd;
      // dotenv owns the complete logical value, including multiline quoted values
      if (format === 'env') {
        const quote = content[valueStart];
        // continue through the first later physical line that closes the quote
        if ((quote === "'" || quote === '"' || quote === '`') && !content.slice(valueStart + 1, line.contentEnd).includes(quote)) {
          for (let next = lineIndex + 1; next < lines.length; next += 1) {
            valueEnd = lines[next]!.contentEnd;
            // stop at the closing quoted physical line
            if (content.slice(lines[next]!.start, valueEnd).includes(quote)) { lineIndex = next; break; }
          }
        }
      } else valueEnd = line.start + shellValueEnd(line.text, valueStart - line.start);
      candidates.push({ start: valueStart, end: valueEnd, original: content.slice(valueStart, valueEnd), base: `assignment:${assignment[2]!.toUpperCase()}` });
      continue;
    }
    const mapping = /^(\s*(?:-\s*)?)(?:([A-Za-z_][A-Za-z0-9_.-]*)|["']([^"']+)["'])(\s*:\s*)(.*)$/u.exec(line.text);
    const mappingKey = mapping?.[2] ?? mapping?.[3];
    // hide credential-named YAML or JSON-like mapping values
    if (mapping !== null && mappingKey !== undefined && protectedSettingIdentity(mappingKey)) {
      const valueStart = line.start + mapping[1]!.length + (mapping[2] === undefined ? mapping[3]!.length + 2 : mapping[2]!.length) + mapping[4]!.length;
      let valueEnd = line.contentEnd;
      const scalar = mapping[5]!.trim();
      // include every indented line owned by a YAML block scalar
      if (/^[>|][+-]?(?:\s+#.*)?$/u.test(scalar)) {
        const indent = /^\s*/u.exec(line.text)![0].length;
        for (let next = lineIndex + 1; next < lines.length; next += 1) {
          const child = lines[next]!;
          // stop before the next peer mapping
          if (child.text.trim().length > 0 && /^\s*/u.exec(child.text)![0].length <= indent) break;
          valueEnd = child.contentEnd;
        }
      }
      candidates.push({ start: valueStart, end: valueEnd, original: content.slice(valueStart, valueEnd), base: `mapping:${mappingKey.toUpperCase()}` });
    }
    // hide credential-bearing long-option arguments on this line
    for (const option of line.text.matchAll(/--([A-Za-z][A-Za-z0-9_-]*)(\s*=\s*|\s+)(?:"([^"]*)"|'([^']*)'|([^\s#"',}\]]+))/gu)) {
      if (!protectedSettingIdentity(option[1]!)) continue;
      const value = option[3] ?? option[4] ?? option[5] ?? '';
      const relative = option.index + option[0].lastIndexOf(value);
      const start = line.start + relative;
      candidates.push({ start, end: start + value.length, original: value, base: `option:${option[1]!.toUpperCase()}` });
    }
    // hide only the password portion of URL user-info
    for (const url of line.text.matchAll(/:\/\/[^\s/@:]+:([^\s/@]+)@/gu)) {
      const start = line.start + url.index + url[0].length - url[1]!.length - 1;
      candidates.push({ start, end: start + url[1]!.length, original: url[1]!, base: 'url:PASSWORD' });
    }
  }
  // inspect inline JSON properties and YAML flow mappings even when the document is invalid
  for (const mapping of content.matchAll(/(?:^|[{,])\s*(?:([A-Za-z_][A-Za-z0-9_.-]*)|"([^"]+)"|'([^']+)')\s*:\s*/gmu)) {
    const mappingKey = mapping[1] ?? mapping[2] ?? mapping[3];
    // retain ordinary inline fields unchanged
    if (mappingKey === undefined || !protectedSettingIdentity(mappingKey)) continue;
    const valueStart = mapping.index + mapping[0].length;
    const valueEnd = inlineScalarEnd(content, valueStart);
    // ignore empty malformed values rather than creating zero-byte markers
    if (valueEnd <= valueStart) continue;
    candidates.push({ start: valueStart, end: valueEnd, original: content.slice(valueStart, valueEnd), base: `mapping:${mappingKey.toUpperCase()}` });
  }
  // hide authorization credentials across arbitrary schemes and quoted header syntax
  for (const range of headerCredentialRanges(content)) candidates.push({ start: range.start, end: range.end, original: content.slice(range.start, range.end), base: 'header:AUTHORIZATION' });
  // hide credential assignments embedded after env, docker, or other command tokens
  for (const assignment of content.matchAll(/(?:^|[\s;,{])([A-Za-z_][A-Za-z0-9_]*)(?:\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s#;,}\]]+))/gmu)) {
    if (!protectedSettingIdentity(assignment[1]!)) continue;
    const value = assignment[2] ?? assignment[3] ?? assignment[4] ?? '';
    // ignore empty assignments rather than creating zero-byte markers
    if (value.length === 0) continue;
    const start = assignment.index + assignment[0].lastIndexOf(value);
    candidates.push({ start, end: start + value.length, original: value, base: `assignment:${assignment[1]!.toUpperCase()}` });
  }
  // mask known credential literals even when they appear under an ordinary field name
  candidates.push(...literalSpans(content, protectedValues, revisionId).map(span => ({ start: span.start, end: span.end, original: span.original, base: span.identity.slice(0, span.identity.lastIndexOf(':')) })));
  return finalizeSpans(content, candidates, revisionId);
}

// apply nonoverlapping replacements from the end so earlier offsets remain stable
function replaceSpans(content: string, spans: Span[], replacements: Map<string, string>): string {
  let result = content;
  // replace later values before earlier values
  for (const span of [...spans].sort((left, right) => right.start - left.start)) result = `${result.slice(0, span.start)}${replacements.get(span.identity) ?? span.marker}${result.slice(span.end)}`;
  return result;
}

// build a pretty or line-preserving editor document with only credentials masked
export function redactEditorSource(content: string, format: SettingsFormat, revisionId: string, protectedValues: readonly string[] = []): EditorSource {
  rejectMarkerCollision(content);
  // pretty-print valid JSON sources while replacing credential leaves
  if (format === 'json' || format === 'installation' || format === 'credentials') {
    let value: unknown = undefined;
    let valid = true;
    // use text repair mode only for invalid JSON syntax
    try { value = JSON.parse(content); } catch { valid = false; }
    if (valid) {
      const found = new Map<string, unknown>();
      const redacted = redactJsonValue(value, format, revisionId, [], found);
      const structured = `${JSON.stringify(redacted, null, 2)}\n`;
      const encodedValues = normalizedCredentialValues(protectedValues).map(value => JSON.stringify(value).slice(1, -1));
      const literals = literalSpans(structured, encodedValues, revisionId);
      return { content: replaceSpans(structured, literals, new Map()), hasProtectedContent: found.size > 0 || literals.length > 0 };
    }
  }
  const spans = textSpans(content, format, revisionId, protectedValues);
  return { content: replaceSpans(content, spans, new Map()), hasProtectedContent: spans.length > 0 };
}

// restore unchanged markers from the fresh revision-bound original before persistence
export function restoreEditorSource(candidate: string, original: string, format: SettingsFormat, revisionId: string, protectedValues: readonly string[] = []): string {
  rejectMarkerCollision(original);
  // restore structured credential leaves and retain pretty JSON output
  if (format === 'json' || format === 'installation' || format === 'credentials') {
    try {
      const originalValue: unknown = JSON.parse(original);
      const expected = new Map<string, unknown>();
      const redactedOriginal = redactJsonValue(originalValue, format, revisionId, [], expected);
      const structuredOriginal = `${JSON.stringify(redactedOriginal, null, 2)}\n`;
      const encodedValues = normalizedCredentialValues(protectedValues).map(value => JSON.stringify(value).slice(1, -1));
      const literalExpected = literalSpans(structuredOriginal, encodedValues, revisionId);
      let restoredCandidate = candidate;
      // restore each exact cross-source credential marker before parsing JSON
      for (const span of [...literalExpected].sort((left, right) => right.start - left.start)) {
        const start = restoredCandidate.indexOf(span.marker);
        if (start < 0 || restoredCandidate.indexOf(span.marker, start + 1) >= 0) throw new SettingsError('settings_protected_content_changed');
        restoredCandidate = `${restoredCandidate.slice(0, start)}${span.original}${restoredCandidate.slice(start + span.marker.length)}`;
      }
      const candidateValue: unknown = JSON.parse(restoredCandidate);
      const seen = new Set<string>();
      const restored = restoreJsonValue(candidateValue, format, revisionId, expected, seen);
      // require every original credential marker exactly once
      if ([...expected.keys()].some(value => !seen.has(value))) throw new SettingsError('settings_protected_content_changed');
      return `${JSON.stringify(restored, null, 2)}\n`;
    } catch (error) {
      // preserve explicit protocol failures
      if (error instanceof SettingsError) throw error;
      // valid original JSON requires a valid edited JSON document
      let originalValid = true;
      try { JSON.parse(original); } catch { originalValid = false; }
      if (originalValid) throw new SettingsError('invalid_settings_value');
    }
  }
  const expected = textSpans(original, format, revisionId, protectedValues);
  const expectedByIdentity = new Map(expected.map(span => [span.identity, span]));
  const candidateSpans = textSpans(candidate, format, revisionId, protectedValues);
  const seen = new Set<string>();
  const replacements = new Map<string, string>();
  const restorable = candidateSpans.filter(span => expectedByIdentity.has(span.identity));
  // accept new credential literals but require every existing credential marker unchanged
  for (const span of candidateSpans) {
    const originalSpan = expectedByIdentity.get(span.identity);
    if (originalSpan === undefined) continue;
    if (span.original !== originalSpan.marker || seen.has(span.identity)) throw new SettingsError('settings_protected_content_changed');
    seen.add(span.identity);
    replacements.set(span.identity, originalSpan.original);
  }
  // recognize removed PEM blocks and known literals through their exact opaque marker
  for (const originalSpan of expected.filter(span => (span.identity.startsWith('pem:') || span.identity.startsWith('literal:')) && !seen.has(span.identity))) {
    const start = candidate.indexOf(originalSpan.marker);
    const lineStart = candidate.lastIndexOf('\n', start - 1) + 1;
    const lineEndMatch = candidate.indexOf('\n', start);
    const lineEnd = lineEndMatch < 0 ? candidate.length : lineEndMatch;
    const placementValid = originalSpan.identity.startsWith('literal:') || candidate.slice(lineStart, lineEnd).trim() === originalSpan.marker;
    // bind PEM blocks to marker-only lines and literals to one exact marker occurrence
    if (start < 0 || candidate.indexOf(originalSpan.marker, start + 1) >= 0 || !placementValid) continue;
    const identity = originalSpan.identity;
    seen.add(identity);
    replacements.set(identity, originalSpan.original);
    restorable.push({ start, end: start + originalSpan.marker.length, original: originalSpan.marker, identity, marker: originalSpan.marker });
  }
  // reject missing original markers
  if (expected.some(span => !seen.has(span.identity))) throw new SettingsError('settings_protected_content_changed');
  const consumed = new Set([...seen].map(identity => expectedByIdentity.get(identity)!.marker));
  // reject unknown, duplicated, or relocated marker strings
  const submittedMarkers = candidate.match(markerPattern) ?? [];
  if (submittedMarkers.length !== consumed.size || submittedMarkers.some(value => !consumed.has(value))) throw new SettingsError('settings_protected_content_changed');
  return replaceSpans(candidate, restorable, replacements);
}

// refuse editor placeholders even when a revealed source bypasses restoration
export function hasEditorMarker(content: string): boolean {
  markerPattern.lastIndex = 0;
  return markerPattern.test(content);
}
