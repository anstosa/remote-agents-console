import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { isUtf8 } from 'node:buffer';

export type WorkspaceFileSummary = { path: string; size: number };
export type PreviewImage = { mediaType: 'image/gif'|'image/jpeg'|'image/png'|'image/webp'; base64: string };
export type WorkspaceFilePreview = WorkspaceFileSummary & { binary: boolean; truncated: boolean; content?: string; image?: PreviewImage };
export type WorkspaceFileOptions = { hostProcRoot?: string; hostUid?: number };

const maxMessageLength = 30_000;
const maxCandidates = 24;
const maxPathLength = 512;
const maxPreviewBytes = 256 * 1024;
export const maxInlineImageBytes = 5 * 1024 * 1024;
const knownBasenames = /^(?:README|LICENSE|Dockerfile|Makefile)(?:\.[A-Za-z0-9_-]+)?$/u;
const temporaryImagePath = /^\/tmp\/([A-Za-z0-9][A-Za-z0-9._-]{0,254}\.(?:gif|jpe?g|png|webp))$/iu;

// report one configured host preview bridge failure
const temporaryImageBridgeError = () => Object.assign(new Error('host temporary image preview unavailable'), { statusCode: 503 });

// identify expected temporary-file misses
const temporaryImageMiss = (error: unknown): boolean => {
  // require one filesystem error code
  if (error === null || typeof error !== 'object' || !('code' in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === 'ENOENT' || code === 'ELOOP';
};

// identify one supported raster image from its bytes
export const previewImageMediaType = (content: Buffer): PreviewImage['mediaType'] | undefined => {
  // recognize PNG signatures
  if (content.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  // recognize JPEG signatures
  if (content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff) return 'image/jpeg';
  const header = content.subarray(0, 6).toString('ascii');
  // recognize GIF signatures
  if (header === 'GIF87a' || header === 'GIF89a') return 'image/gif';
  // recognize WebP signatures
  if (content.subarray(0, 4).toString('ascii') === 'RIFF' && content.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return undefined;
};

// classify bounded bytes using the true source size when a read is partial
export const previewFileBytes = (path: string, bytes: Buffer, textCap = maxPreviewBytes, size = bytes.length): WorkspaceFilePreview => {
  const mediaType = previewImageMediaType(bytes);
  // inline only complete supported raster images within the image cap
  if (mediaType !== undefined && size === bytes.length && size <= maxInlineImageBytes) {
    return { path, size, binary: true, truncated: false, image: { mediaType, base64: bytes.toString('base64') } };
  }
  const binary = mediaType !== undefined || bytes.includes(0) || (size === bytes.length && !isUtf8(bytes));
  // return a safe metadata-only fallback for unsupported binary bytes
  if (binary) return { path, size, binary: true, truncated: mediaType === undefined && size > bytes.length };
  let content = bytes.subarray(0, textCap);
  // avoid splitting the final utf-8 code point
  let trimmed = 0;
  while (!isUtf8(content) && trimmed < 3) { content = content.subarray(0, content.length - 1); trimmed += 1; }
  // reject invalid bytes beyond one incomplete utf-8 tail
  if (!isUtf8(content)) return { path, size, binary: true, truncated: size > bytes.length };
  return { path, size, binary: false, truncated: size > content.length, content: content.toString('utf8') };
};

// fill one bounded buffer from an opened descriptor
const readOpenedBytes = async (handle: Awaited<ReturnType<typeof open>>, length: number): Promise<Buffer> => {
  const content = Buffer.alloc(length);
  let offset = 0;
  // fill only the bounded allocation
  while (offset < content.length) {
    const { bytesRead } = await handle.read(content, offset, content.length - offset, offset);
    // stop on concurrent truncation
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return content.subarray(0, offset);
};

// normalize one mentioned path
const normalizeMention = (value: string): string | undefined => {
  let path = value.trim().replace(/^file:\/\//u, '').replace(/^@/u, '').replace(/^['"`(<]+|['"`>),.;]+$/gu, '');
  try { path = decodeURIComponent(path); } catch { return undefined; }
  path = path.replace(/#L\d+(?:-L\d+)?$/iu, '').replace(/:\d+(?::\d+)?$/u, '');
  if (!path || path.length > maxPathLength || path.includes('\0') || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(path)) return undefined;
  return path;
};

// recognize likely file references
const looksLikePath = (value: string) => value.includes('/') || /^[^\s/]+\.[A-Za-z0-9_-]{1,16}(?::\d+(?::\d+)?)?$/u.test(value) || knownBasenames.test(value);

// extract bounded path candidates
export const fileMentions = (message: string): string[] => {
  if (!message || message.length > maxMessageLength || message.includes('\0')) return [];
  const found: string[] = [];
  const seen = new Set<string>();
  // retain explicit Markdown and code references
  for (const match of message.matchAll(/`([^`\n]+)`|\[[^\]]*\]\(([^)\s]+)\)/gu)) {
    const candidate = normalizeMention(match[1] ?? match[2] ?? '');
    if (candidate !== undefined && looksLikePath(candidate) && !seen.has(candidate)) { seen.add(candidate); found.push(candidate); }
  }
  // retain bare paths with directory segments
  for (const match of message.matchAll(/(?:^|[\s'"(])((?:file:\/\/)?(?:\/|\.{1,2}\/)?(?:[A-Za-z0-9_@.+-]+\/)+[A-Za-z0-9_@.+-]+(?:#L\d+(?:-L\d+)?|:\d+(?::\d+)?)?)/gmu)) {
    const candidate = normalizeMention(match[1] ?? '');
    if (candidate !== undefined && !seen.has(candidate)) { seen.add(candidate); found.push(candidate); }
  }
  return found.slice(0, maxCandidates);
};

// keep resolved files inside one workspace
const resolveFile = async (workspace: string, mention: string): Promise<{ root: string; file: string; summary: WorkspaceFileSummary } | undefined> => {
  const path = normalizeMention(mention);
  if (path === undefined) return undefined;
  const root = await realpath(workspace).catch(() => undefined);
  if (root === undefined) return undefined;
  const file = await realpath(isAbsolute(path) ? path : resolve(root, path)).catch(() => undefined);
  if (file === undefined) return undefined;
  const local = relative(root, file);
  if (!local || local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) return undefined;
  const info = await stat(file).catch(() => undefined);
  if (info === undefined || !info.isFile()) return undefined;
  return { root, file, summary: { path: local.split(sep).join('/'), size: info.size } };
};

export class WorkspaceFileService {
  private readonly hostProcRoot?: string;
  private readonly hostUid: number;

  // bind optional host artifact access to the configured proc mount
  constructor(options: WorkspaceFileOptions = {}) {
    this.hostProcRoot = options.hostProcRoot ?? process.env.RAC_HOST_PROC;
    const configuredUid = Number(process.env.RAC_HOST_UID);
    this.hostUid = options.hostUid ?? (Number.isInteger(configuredUid) && configuredUid >= 0 ? configuredUid : process.getuid?.() ?? 0);
  }

  // list real files mentioned by one response
  async list(workspace: string, message: string): Promise<WorkspaceFileSummary[]> {
    const files: WorkspaceFileSummary[] = [];
    const seen = new Set<string>();
    // resolve candidates sequentially within fixed bounds
    for (const mention of fileMentions(message)) {
      const resolved = await resolveFile(workspace, mention);
      if (resolved !== undefined && !seen.has(resolved.summary.path)) { seen.add(resolved.summary.path); files.push(resolved.summary); }
    }
    return files;
  }

  // load bounded text or complete raster bytes through one secure descriptor
  async preview(workspace: string, path: string, maxBytes = maxPreviewBytes): Promise<WorkspaceFilePreview | undefined> {
    const resolved = await resolveFile(workspace, path);
    if (resolved === undefined) return undefined;
    const handle = await open(resolved.file, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => undefined);
    if (handle === undefined) return undefined;
    try {
      const [info, opened] = await Promise.all([handle.stat(), realpath(`/proc/self/fd/${handle.fd}`).catch(() => undefined)]);
      // bind containment and size checks to the opened descriptor
      if (!info.isFile() || opened === undefined) return undefined;
      const local = relative(resolved.root, opened);
      if (!local || local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) return undefined;
      const summary = { path: local.split(sep).join('/'), size: info.size };
      const header = await readOpenedBytes(handle, Math.min(summary.size, 12));
      const image = previewImageMediaType(header) !== undefined;
      // return oversized supported images as metadata without reading their bodies
      if (image && summary.size > maxInlineImageBytes) return { ...summary, binary: true, truncated: false };
      const length = Math.min(summary.size, image ? maxInlineImageBytes : maxBytes);
      const content = await readOpenedBytes(handle, length);
      const settled = await handle.stat();
      // never inline a partial or concurrently resized image
      if (image && (content.length !== summary.size || settled.size !== summary.size)) return undefined;
      return previewFileBytes(summary.path, content, maxBytes, summary.size);
    } finally { await handle.close(); }
  }

  // load a flat screenshot from one proven pane namespace
  async previewTemporaryImage(path: string, panePid?: number): Promise<WorkspaceFilePreview | undefined> {
    const match = temporaryImagePath.exec(path);
    // require an enabled bridge, one exact pane, and a flat image filename
    if (this.hostProcRoot === undefined || match === null || typeof panePid !== 'number' || !Number.isInteger(panePid) || panePid < 1) return undefined;
    const procRoot = await stat(this.hostProcRoot).catch(() => { throw temporaryImageBridgeError(); });
    // reject a misconfigured proc bridge
    if (!procRoot.isDirectory()) throw temporaryImageBridgeError();
    const namespace = resolve(this.hostProcRoot, String(panePid), 'root', 'tmp');
    const namespaceInfo = await stat(namespace).catch(() => { throw temporaryImageBridgeError(); });
    // require one accessible pane temporary directory
    if (!namespaceInfo.isDirectory()) throw temporaryImageBridgeError();
    const filename = match[1]!;
    const candidate = resolve(namespace, filename);
    let handle: Awaited<ReturnType<typeof open>>;
    try { handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) {
      // hide absent files and symlinks
      if (temporaryImageMiss(error)) return undefined;
      throw temporaryImageBridgeError();
    }
    try {
      const info = await handle.stat();
      // require one bounded regular file owned by the host agent user
      if (!info.isFile() || info.uid !== this.hostUid || info.size < 1 || info.size > maxInlineImageBytes) return undefined;
      const content = await readOpenedBytes(handle, info.size);
      const settled = await handle.stat();
      // reject concurrent truncation or growth
      if (content.length !== info.size || settled.size !== info.size) return undefined;
      const mediaType = previewImageMediaType(content);
      // return only recognized raster images
      if (mediaType === undefined) return undefined;
      return { path, size: info.size, binary: true, truncated: false, image: { mediaType, base64: content.toString('base64') } };
    } catch (error) {
      // preserve expected process-exit misses
      if (temporaryImageMiss(error)) return undefined;
      throw temporaryImageBridgeError();
    } finally {
      await handle.close();
    }
  }
}
