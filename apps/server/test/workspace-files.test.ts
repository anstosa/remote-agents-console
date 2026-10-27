import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fileMentions, previewFileBytes, WorkspaceFileService } from '../src/workspace-files/service.js';

describe('workspace response files', () => {
  // preview stored text and binary bytes within the modal cap
  it('builds bounded in-memory text and binary previews', () => {
    const large = Buffer.from('x'.repeat(256 * 1_024 + 10));
    expect(previewFileBytes('large.txt', large)).toMatchObject({ path: 'large.txt', size: large.length, binary: false, truncated: true, content: 'x'.repeat(256 * 1_024) });
    expect(previewFileBytes('binary.dat', Buffer.from([0xff, 0x00, 0x01]))).toEqual({ path: 'binary.dat', size: 3, binary: true, truncated: false });
    expect(previewFileBytes('invalid.dat', Buffer.from([0xff]))).toEqual({ path: 'invalid.dat', size: 1, binary: true, truncated: false });
    expect(previewFileBytes('diagram.svg', Buffer.from('<svg><script>alert(1)</script></svg>'))).toMatchObject({ binary: false, content: '<svg><script>alert(1)</script></svg>' });
  });

  // preserve valid utf-8 when the byte cap lands inside a multibyte code point
  it('trims an incomplete utf-8 tail from a text preview', () => {
    const bytes = Buffer.from(`${'x'.repeat(256 * 1_024 - 1)}€tail`);
    const preview = previewFileBytes('unicode.txt', bytes);
    expect(preview).toEqual({ path: 'unicode.txt', size: bytes.length, binary: false, truncated: true, content: 'x'.repeat(256 * 1_024 - 1) });
  });

  // recognize every supported raster signature
  it.each([
    ['image/png', Buffer.from('89504e470d0a1a0a', 'hex')],
    ['image/jpeg', Buffer.from('ffd8ff', 'hex')],
    ['image/gif', Buffer.from('GIF89a', 'ascii')],
    ['image/webp', Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.alloc(4), Buffer.from('WEBP', 'ascii')])]
  ] as const)('builds a bounded %s image preview', (mediaType, bytes) => {
    expect(previewFileBytes('image.bin', bytes)).toEqual({
      path: 'image.bin',
      size: bytes.length,
      binary: true,
      truncated: false,
      image: { mediaType, base64: bytes.toString('base64') }
    });
  });

  // fall back safely when a recognized image exceeds five mebibytes
  it('does not inline an oversized raster image', () => {
    const bytes = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(5 * 1_024 * 1_024)]);
    expect(previewFileBytes('large.png', bytes)).toEqual({ path: 'large.png', size: bytes.length, binary: true, truncated: false });
  });

  it('extracts explicit and bare file references without remote URLs', () => {
    const message = 'Changed `src/main.ts:42`, [setup](docs/setup.md), and src/main.ts. See https://example.com/docs/help.';
    expect(fileMentions(message)).toEqual(['src/main.ts', 'docs/setup.md']);
  });

  it('lists only real contained files and blocks symlink escapes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-response-files-'));
    const workspace = join(directory, 'workspace');
    const outside = join(directory, 'outside.txt');
    try {
      await mkdir(join(workspace, 'src'), { recursive: true });
      await writeFile(join(workspace, 'src/main.ts'), 'export const ready = true;\n');
      await writeFile(join(workspace, 'README.md'), '# Ready\n');
      await writeFile(outside, 'secret');
      await symlink(outside, join(workspace, 'src/escaped.txt'));
      const service = new WorkspaceFileService();
      const message = '`src/main.ts:7` [readme](README.md) `src/escaped.txt` `../outside.txt` `missing.ts`';

      await expect(service.list(workspace, message)).resolves.toEqual([
        { path: 'src/main.ts', size: 27 },
        { path: 'README.md', size: 8 }
      ]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('returns bounded text previews and identifies binary files', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'rac-response-preview-'));
    try {
      await writeFile(join(workspace, 'large.txt'), 'x'.repeat(256 * 1_024 + 10));
      await writeFile(join(workspace, 'unicode.txt'), `${'x'.repeat(256 * 1_024 - 1)}€tail`);
      await writeFile(join(workspace, 'binary.dat'), Buffer.from([1, 0, 2]));
      const service = new WorkspaceFileService();

      await expect(service.preview(workspace, 'large.txt')).resolves.toMatchObject({ path: 'large.txt', binary: false, truncated: true, content: 'x'.repeat(256 * 1_024) });
      await expect(service.preview(workspace, 'unicode.txt')).resolves.toEqual({ path: 'unicode.txt', size: 256 * 1_024 + 6, binary: false, truncated: true, content: 'x'.repeat(256 * 1_024 - 1) });
      await expect(service.preview(workspace, 'binary.dat')).resolves.toEqual({ path: 'binary.dat', size: 3, binary: true, truncated: false });
      await expect(service.preview(workspace, '../unavailable.txt')).resolves.toBeUndefined();
    } finally { await rm(workspace, { recursive: true, force: true }); }
  });

  // inline complete workspace raster images through the same secure file descriptor
  it('previews workspace raster images up to five mebibytes', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'rac-response-images-'));
    const pngHeader = Buffer.from('89504e470d0a1a0a', 'hex');
    const medium = Buffer.concat([pngHeader, Buffer.alloc(2 * 1_024 * 1_024 + 17, 7)]);
    const exact = Buffer.concat([pngHeader, Buffer.alloc(5 * 1_024 * 1_024 - pngHeader.length, 8)]);
    const oversized = Buffer.concat([pngHeader, Buffer.alloc(5 * 1_024 * 1_024, 9)]);
    try {
      await Promise.all([
        writeFile(join(workspace, 'medium.png'), medium),
        writeFile(join(workspace, 'exact.png'), exact),
        writeFile(join(workspace, 'oversized.png'), oversized)
      ]);
      const service = new WorkspaceFileService();

      const preview = await service.preview(workspace, 'medium.png');
      expect(preview).toMatchObject({ path: 'medium.png', size: medium.length, binary: true, truncated: false, image: { mediaType: 'image/png' } });
      expect(Buffer.from(preview?.image?.base64 ?? '', 'base64')).toEqual(medium);
      // the inclusive cap still returns the complete exact-boundary image
      const exactPreview = await service.preview(workspace, 'exact.png');
      expect(exactPreview?.size).toBe(exact.length);
      expect(exactPreview?.truncated).toBe(false);
      expect(exactPreview?.image?.base64 === exact.toString('base64')).toBe(true);
      await expect(service.preview(workspace, 'oversized.png')).resolves.toEqual({ path: 'oversized.png', size: oversized.length, binary: true, truncated: false });
    } finally { await rm(workspace, { recursive: true, force: true }); }
  }, 15_000);

  // verify host temporary screenshots stay image-only and pane-scoped
  it('previews bounded host temporary images through the selected pane root', async () => {
    const procRoot = await mkdtemp(join(tmpdir(), 'rac-host-proc-'));
    const invalidProcRoot = await mkdtemp(join(tmpdir(), 'rac-empty-proc-'));
    const pid = '1234';
    const otherPid = '5678';
    const hostTmp = join(procRoot, pid, 'root', 'tmp');
    const otherHostTmp = join(procRoot, otherPid, 'root', 'tmp');
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const jpeg = Buffer.from('ffd8ffe000104a464946', 'hex');
    try {
      await mkdir(hostTmp, { recursive: true });
      await mkdir(otherHostTmp, { recursive: true });
      await writeFile(join(hostTmp, 'agent-screenshot.png'), png);
      await writeFile(join(otherHostTmp, 'agent-screenshot.png'), jpeg);
      await writeFile(join(hostTmp, 'not-an-image.png'), 'private text');
      await symlink(join(hostTmp, 'agent-screenshot.png'), join(hostTmp, 'linked.png'));
      const service = new WorkspaceFileService({ hostProcRoot: procRoot, hostUid: process.getuid() });

      await expect(service.previewTemporaryImage('/tmp/agent-screenshot.png', Number(pid))).resolves.toEqual({
        path: '/tmp/agent-screenshot.png',
        size: png.length,
        binary: true,
        truncated: false,
        image: { mediaType: 'image/png', base64: png.toString('base64') }
      });
      await expect(service.previewTemporaryImage('/tmp/agent-screenshot.png', Number(otherPid))).resolves.toMatchObject({ image: { mediaType: 'image/jpeg' } });
      await expect(service.previewTemporaryImage('/tmp/not-an-image.png', Number(pid))).resolves.toBeUndefined();
      await expect(service.previewTemporaryImage('/tmp/linked.png', Number(pid))).resolves.toBeUndefined();
      await expect(service.previewTemporaryImage('/tmp/nested/agent-screenshot.png', Number(pid))).resolves.toBeUndefined();
      await expect(service.previewTemporaryImage('/etc/agent-screenshot.png', Number(pid))).resolves.toBeUndefined();
      await expect(service.previewTemporaryImage('/tmp/agent-screenshot.png')).resolves.toBeUndefined();
      const unavailable = new WorkspaceFileService({ hostProcRoot: join(procRoot, 'missing'), hostUid: process.getuid() });
      await expect(unavailable.previewTemporaryImage('/tmp/agent-screenshot.png', Number(pid))).rejects.toMatchObject({ statusCode: 503 });
      const invalid = new WorkspaceFileService({ hostProcRoot: invalidProcRoot, hostUid: process.getuid() });
      await expect(invalid.previewTemporaryImage('/tmp/agent-screenshot.png', Number(pid))).rejects.toMatchObject({ statusCode: 503 });
    } finally {
      await Promise.all([
        rm(procRoot, { recursive: true, force: true }),
        rm(invalidProcRoot, { recursive: true, force: true })
      ]);
    }
  });
});
