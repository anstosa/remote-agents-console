import { afterEach, describe, expect, it, vi } from 'vitest';
import { clipboardCapability, clipboardError, parseClipboardItems, performClipboard, validClipboardText } from '../../web/src/browser-clipboard.js';

// restore native boundaries between provider simulations
afterEach(() => vi.unstubAllGlobals());

// supply a deterministic parent clipboard without involving the operating system
const provider = () => {
  const clipboard = { readText: vi.fn(async () => 'copied text'), writeText: vi.fn(async (_text: string) => undefined), read: vi.fn(async () => []), write: vi.fn(async (_items: ClipboardItem[]) => undefined) };
  vi.stubGlobal('navigator', { clipboard });
  return clipboard;
};

// validate parent-owned serialization and native invocation
describe('clipboard broker adapter', () => {
  // preserve independent read and write boundaries
  it('maps only clipboard operations to their capabilities', () => {
    expect(clipboardCapability('clipboard-read-text')).toBe('clipboard-read');
    expect(clipboardCapability('clipboard-read')).toBe('clipboard-read');
    expect(clipboardCapability('clipboard-write-text')).toBe('clipboard-write');
    expect(clipboardCapability('clipboard-write')).toBe('clipboard-write');
    expect(clipboardCapability('clipboard-cancel')).toBeUndefined();
    expect(clipboardCapability('notification-show')).toBeUndefined();
  });

  // reject oversized transfers without modifying content
  it('accepts exact bounded text and cloneable rich data only', () => {
    expect(validClipboardText('')).toBe(true);
    expect(validClipboardText('x'.repeat(1_048_576))).toBe(true);
    expect(validClipboardText('x'.repeat(1_048_577))).toBe(false);
    expect(validClipboardText(1)).toBe(false);
    const representations = [{ type: 'text/plain', blob: new Blob(['value'], { type: 'text/plain' }) }];
    const item = { presentationStyle: 'inline' as const, representations };
    expect(parseClipboardItems([item])).toEqual([item]);
    expect(parseClipboardItems([])).toBeUndefined();
    expect(parseClipboardItems(Array(5).fill(item))).toBeUndefined();
    expect(parseClipboardItems([{ ...item, representations: [...representations, ...representations] }])).toBeUndefined();
    expect(parseClipboardItems([{ ...item, extra: true }])).toBeUndefined();
    expect(parseClipboardItems([{ ...item, presentationStyle: 'invalid' }])).toBeUndefined();
    expect(parseClipboardItems([representations])).toBeUndefined();
    expect(parseClipboardItems([{ ...item, representations: [{ ...representations[0], extra: true }] }])).toBeUndefined();
    expect(parseClipboardItems([{ ...item, representations: [{ type: 'text/html', blob: representations[0]!.blob }] }])).toBeUndefined();
    expect(parseClipboardItems([{ ...item, representations: [{ type: 'text/plain', blob: { size: 5, type: 'text/plain' } }] }])).toBeUndefined();
    const big = new Blob([new Uint8Array(4 * 1024 * 1024)], { type: 'text/plain' });
    expect(parseClipboardItems([{ ...item, representations: [{ type: big.type, blob: big }] }])).toBeDefined();
    expect(parseClipboardItems([{ ...item, representations: [{ type: big.type, blob: big }] }, item])).toBeUndefined();
  });

  // do not insert an asynchronous boundary before activation-sensitive providers
  it('starts native text calls immediately and preserves exact values', async () => {
    const clipboard = provider();
    const read = performClipboard('clipboard-read-text', {});
    expect(clipboard.readText).toHaveBeenCalledOnce();
    await expect(read).resolves.toEqual({ text: 'copied text' });
    const write = performClipboard('clipboard-write-text', { text: '  exact\ntext  ' });
    expect(clipboard.writeText).toHaveBeenCalledExactlyOnceWith('  exact\ntext  ');
    await expect(write).resolves.toEqual({});
    await expect(performClipboard('clipboard-write-text', { text: 'x'.repeat(1_048_577) })).rejects.toMatchObject({ name: 'DataError' });
    expect(clipboard.writeText).toHaveBeenCalledOnce();
  });

  // serialize native items rather than sending uncloneable browser objects
  it('snapshots rich read data and permits an empty native result', async () => {
    const clipboard = provider();
    await expect(performClipboard('clipboard-read', {})).resolves.toEqual({ items: [] });
    const blob = new Blob(['<b>copied</b>'], { type: 'text/html' });
    const item = { types: ['text/html'], getType: vi.fn(async () => blob) };
    clipboard.read.mockResolvedValue([item] as never);
    await expect(performClipboard('clipboard-read', {})).resolves.toEqual({
      items: [{ presentationStyle: 'unspecified', representations: [{ type: 'text/html', blob }] }]
    });
    expect(item.getType).toHaveBeenCalledExactlyOnceWith('text/html');
  });

  // preserve item presentation metadata with a chromium fallback
  it('roundtrips rich presentation styles and defaults missing native metadata', async () => {
    const clipboard = provider();
    class NativeClipboardItem {
      readonly presentationStyle: 'unspecified' | 'inline' | 'attachment';

      // retain native constructor inputs
      constructor(readonly data: Record<string, Blob>, options?: { presentationStyle?: 'unspecified' | 'inline' | 'attachment' }) {
        this.presentationStyle = options?.presentationStyle ?? 'unspecified';
      }
    }
    vi.stubGlobal('ClipboardItem', NativeClipboardItem);
    const attachment = new Blob(['attachment'], { type: 'text/plain' });
    const fallback = new Blob(['fallback'], { type: 'text/html' });
    clipboard.read.mockResolvedValue([
      { presentationStyle: 'attachment', types: ['text/plain'], getType: async () => attachment },
      { types: ['text/html'], getType: async () => fallback }
    ] as never);
    await expect(performClipboard('clipboard-read', {})).resolves.toEqual({
      items: [
        { presentationStyle: 'attachment', representations: [{ type: 'text/plain', blob: attachment }] },
        { presentationStyle: 'unspecified', representations: [{ type: 'text/html', blob: fallback }] }
      ]
    });
    const write = performClipboard('clipboard-write', {
      items: [{ presentationStyle: 'inline', representations: [{ type: 'text/plain', blob: attachment }] }]
    });
    expect(clipboard.write).toHaveBeenCalledExactlyOnceWith([
      new NativeClipboardItem({ 'text/plain': attachment }, { presentationStyle: 'inline' })
    ]);
    await expect(write).resolves.toEqual({});
  });

  // preserve the web prefix on format keys rather than requiring it on blobs
  it('accepts custom clipboard formats without weakening mime validation', async () => {
    const clipboard = provider();
    const type = 'web application/x-example';
    const blob = new Blob(['custom data'], { type: 'application/x-example' });
    expect(parseClipboardItems([{ presentationStyle: 'unspecified', representations: [{ type, blob }] }])).toEqual([
      { presentationStyle: 'unspecified', representations: [{ type, blob }] }
    ]);
    expect(parseClipboardItems([{ presentationStyle: 'unspecified', representations: [{ type: 'web text/html', blob }] }])).toBeUndefined();
    clipboard.read.mockResolvedValue([{ types: [type], getType: async () => blob }] as never);
    await expect(performClipboard('clipboard-read', {})).resolves.toEqual({
      items: [{ presentationStyle: 'unspecified', representations: [{ type, blob }] }]
    });
  });

  // reject excessive provider data before cloning it into the preview
  it('bounds rich and text read results', async () => {
    const clipboard = provider();
    clipboard.readText.mockResolvedValue('x'.repeat(1_048_577));
    await expect(performClipboard('clipboard-read-text', {})).rejects.toMatchObject({ name: 'QuotaExceededError' });
    const item = { types: Array(9).fill('text/plain'), getType: vi.fn() };
    clipboard.read.mockResolvedValue([item] as never);
    await expect(performClipboard('clipboard-read', {})).rejects.toMatchObject({ name: 'QuotaExceededError' });
    expect(item.getType).not.toHaveBeenCalled();
    clipboard.read.mockResolvedValue(Array(5).fill(item) as never);
    await expect(performClipboard('clipboard-read', {})).rejects.toMatchObject({ name: 'QuotaExceededError' });
  });

  // construct native items synchronously after validating every representation
  it('starts rich writes during activation and rejects invalid data first', async () => {
    const clipboard = provider();
    class NativeClipboardItem {
      readonly presentationStyle: 'unspecified' | 'inline' | 'attachment';

      // retain the constructor payload for provider assertions
      constructor(readonly data: Record<string, Blob>, options?: { presentationStyle?: 'unspecified' | 'inline' | 'attachment' }) {
        this.presentationStyle = options?.presentationStyle ?? 'unspecified';
      }
    }
    vi.stubGlobal('ClipboardItem', NativeClipboardItem);
    const blob = new Blob(['rich value'], { type: 'text/plain' });
    const write = performClipboard('clipboard-write', {
      items: [{ presentationStyle: 'unspecified', representations: [{ type: 'text/plain', blob }] }]
    });
    expect(clipboard.write).toHaveBeenCalledExactlyOnceWith([
      new NativeClipboardItem({ 'text/plain': blob }, { presentationStyle: 'unspecified' })
    ]);
    await expect(write).resolves.toEqual({});
    await expect(performClipboard('clipboard-write', { items: [] })).rejects.toMatchObject({ name: 'DataError' });
    expect(clipboard.write).toHaveBeenCalledOnce();
  });

  // preserve unsupported and denied native behavior without implicit retries
  it('retains native errors and fails cleanly without a provider', async () => {
    const clipboard = provider();
    const denied = new DOMException('native denial', 'NotAllowedError');
    clipboard.readText.mockRejectedValue(denied);
    await expect(performClipboard('clipboard-read-text', {})).rejects.toBe(denied);
    expect(clipboard.readText).toHaveBeenCalledOnce();
    expect(clipboardError(denied)).toEqual({ code: 1, message: 'native denial', name: 'NotAllowedError' });
    expect(clipboardError(new DOMException('changed', 'InvalidStateError')).name).toBe('InvalidStateError');
    expect(clipboardError(new Error('x'.repeat(501))).message).toHaveLength(500);
    vi.stubGlobal('navigator', {});
    await expect(performClipboard('clipboard-read-text', {})).rejects.toMatchObject({ name: 'NotSupportedError' });
  });
});
