export type ClipboardOperation = 'clipboard-read-text' | 'clipboard-write-text' | 'clipboard-read' | 'clipboard-write';
type ClipboardCapability = 'clipboard-read' | 'clipboard-write';
type ClipboardPresentationStyle = 'unspecified' | 'inline' | 'attachment';
type ClipboardItems = Array<{ presentationStyle: ClipboardPresentationStyle; representations: Array<{ type: string; blob: Blob }> }>;
export type ClipboardPayload = { text?: string; items?: ClipboardItems };

const maxTextLength = 1_048_576;
const maxItems = 4;
const maxTypes = 8;
const maxBytes = 4 * 1024 * 1024;
const presentationStyles = new Set<ClipboardPresentationStyle>(['unspecified', 'inline', 'attachment']);
const errorNames = new Set(['AbortError', 'DataError', 'DataCloneError', 'InvalidStateError', 'NotAllowedError', 'NotFoundError', 'NotReadableError', 'NotSupportedError', 'QuotaExceededError', 'SecurityError', 'TypeError', 'UnknownError']);

// keep reads and writes under independent origin approvals
export const clipboardCapability = (operation: string): ClipboardCapability | undefined => {
  // both read methods expose clipboard contents
  if (operation === 'clipboard-read-text' || operation === 'clipboard-read') return 'clipboard-read';
  // both write methods replace clipboard contents
  if (operation === 'clipboard-write-text' || operation === 'clipboard-write') return 'clipboard-write';
  return undefined;
};

// reject oversized text rather than silently changing clipboard contents
export const validClipboardText = (value: unknown): value is string => typeof value === 'string' && value.length <= maxTextLength;

// custom format keys retain their web prefix while blobs retain their mime type
const clipboardBlobType = (type: string): string => type.startsWith('web ') ? type.slice(4) : type;

// validate cloneable clipboard data before retaining or invoking native work
export const parseClipboardItems = (value: unknown): ClipboardItems | undefined => {
  // bound native item construction and reject empty writes
  if (!Array.isArray(value) || value.length < 1 || value.length > maxItems) return undefined;
  let bytes = 0;
  const items: ClipboardItems = [];
  // validate every item before creating any native clipboard object
  for (const item of value) {
    // require the exact item envelope and one known presentation style
    if (item === null || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).length !== 2
      || !Object.prototype.hasOwnProperty.call(item, 'presentationStyle') || !Object.prototype.hasOwnProperty.call(item, 'representations')
      || !presentationStyles.has(item.presentationStyle as ClipboardPresentationStyle)) return undefined;
    const itemRepresentations = item.representations;
    // bound representations within each item
    if (!Array.isArray(itemRepresentations) || itemRepresentations.length < 1 || itemRepresentations.length > maxTypes) return undefined;
    const types = new Set<string>();
    const representations: ClipboardItems[number]['representations'] = [];
    // copy only explicitly permitted representation fields
    for (const entry of itemRepresentations) {
      // reject active, malformed, duplicate, or mismatched representations
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).length !== 2
        || typeof entry.type !== 'string' || entry.type.length < 1 || entry.type.length > 128
        || types.has(entry.type) || !(entry.blob instanceof Blob) || entry.blob.type !== clipboardBlobType(entry.type)) return undefined;
      bytes += entry.blob.size;
      // cap the entire transfer rather than each individual blob
      if (bytes > maxBytes) return undefined;
      types.add(entry.type);
      representations.push({ type: entry.type, blob: entry.blob });
    }
    items.push({ presentationStyle: item.presentationStyle as ClipboardPresentationStyle, representations });
  }
  return items;
};

// preserve useful native failure names without forwarding arbitrary objects
export const clipboardError = (error: unknown): { code: 1 | 2; message: string; name: string } => {
  const name = error instanceof Error && errorNames.has(error.name) ? error.name : 'UnknownError';
  return { code: name === 'NotAllowedError' || name === 'SecurityError' ? 1 : 2, name, message: (error instanceof Error ? error.message : 'Clipboard operation failed').slice(0, 500) };
};

// invoke native access before the first await to preserve consent-click activation
export const performClipboard = async (operation: ClipboardOperation, payload: ClipboardPayload): Promise<ClipboardPayload> => {
  const clipboard = navigator.clipboard;
  // fail predictably on browsers without the requested native method
  if (clipboard === undefined) throw new DOMException('Clipboard is unavailable', 'NotSupportedError');
  // return bounded text from the parent clipboard
  if (operation === 'clipboard-read-text') {
    // retain feature detection for browsers with partial clipboard support
    if (typeof clipboard.readText !== 'function') throw new DOMException('Clipboard reading is unavailable', 'NotSupportedError');
    const text = await clipboard.readText();
    // avoid large structured-clone responses
    if (!validClipboardText(text)) throw new DOMException('Clipboard text exceeds the transfer limit', 'QuotaExceededError');
    return { text };
  }
  // write the exact validated text without truncation
  if (operation === 'clipboard-write-text') {
    // reject unsupported providers and invalid internal payloads
    if (typeof clipboard.writeText !== 'function') throw new DOMException('Clipboard writing is unavailable', 'NotSupportedError');
    if (!validClipboardText(payload.text)) throw new DOMException('Invalid clipboard text', 'DataError');
    await clipboard.writeText(payload.text);
    return {};
  }
  // construct native items only after validating the full transfer
  if (operation === 'clipboard-write') {
    // keep rich clipboard support separate from text-only browser support
    if (typeof clipboard.write !== 'function' || typeof ClipboardItem !== 'function') throw new DOMException('Rich clipboard writing is unavailable', 'NotSupportedError');
    const items = parseClipboardItems(payload.items);
    // refuse malformed data before touching the native clipboard
    if (items === undefined) throw new DOMException('Invalid clipboard items', 'DataError');
    await clipboard.write(items.map(item => new ClipboardItem(
      Object.fromEntries(item.representations.map(entry => [entry.type, entry.blob])),
      { presentationStyle: item.presentationStyle }
    )));
    return {};
  }
  // keep the browser's default sanitization and paste authorization behavior
  if (typeof clipboard.read !== 'function') throw new DOMException('Rich clipboard reading is unavailable', 'NotSupportedError');
  const nativeItems = await clipboard.read();
  // native empty reads are valid but large item arrays are not transferable
  if (nativeItems.length > maxItems) throw new DOMException('Too many clipboard items', 'QuotaExceededError');
  const items: ClipboardItems = [];
  let bytes = 0;
  // serialize native items into cloneable blobs rather than native prototypes
  for (const item of nativeItems) {
    // bound representations before requesting any data
    if (item.types.length < 1 || item.types.length > maxTypes) throw new DOMException('Too many clipboard formats', 'QuotaExceededError');
    const representations: ClipboardItems[number]['representations'] = [];
    // read only bounded native formats
    for (const type of item.types) {
      // reject oversized format identifiers before awaiting native data
      if (type.length < 1 || type.length > 128) throw new DOMException('Invalid clipboard format', 'DataError');
      const blob = await item.getType(type);
      bytes += blob.size;
      // stop before cloning oversized data into the preview
      if (bytes > maxBytes) throw new DOMException('Clipboard data exceeds the transfer limit', 'QuotaExceededError');
      representations.push({ type, blob });
    }
    items.push({ presentationStyle: item.presentationStyle ?? 'unspecified', representations });
  }
  // require native results to obey the same representation schema as writes
  if (items.length > 0 && parseClipboardItems(items) === undefined) throw new DOMException('Invalid clipboard data', 'DataError');
  return { items };
};
