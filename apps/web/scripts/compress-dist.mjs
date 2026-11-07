// Write .br and .gz siblings of the built text files for @fastify/static's preCompressed option.
import { readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { brotliCompress, constants, gzip } from 'node:zlib';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const compressible = /\.(?:js|mjs|css|html|svg|json|webmanifest|txt|wasm)$/u;
const br = promisify(brotliCompress);
const gz = promisify(gzip);
// a running server must never serve a half-written sibling, which immutable caching would keep for a year
const writeAtomically = async (path, data) => { await writeFile(`${path}.tmp`, data); await rename(`${path}.tmp`, path); };

await Promise.all((await readdir(dist, { recursive: true })).filter(name => compressible.test(name)).map(async name => {
  const path = join(dist, name);
  const { size } = await stat(path);
  if (size < 1024) return;
  const source = await readFile(path);
  await writeAtomically(`${path}.br`, await br(source, { params: { [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY, [constants.BROTLI_PARAM_SIZE_HINT]: size } }));
  await writeAtomically(`${path}.gz`, await gz(source, { level: constants.Z_BEST_COMPRESSION }));
}));
