import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { instanceIconSvg, listInstanceIcons, loadInstanceIconSvg } from '../src/instance-icon.js';
import { isInstanceIconName } from '../src/instance-icon-name.js';

const temporaryRoots: string[] = [];

// remove isolated icon fixtures
afterEach(async () => {
  vi.unstubAllEnvs();
  // clean every test-owned directory
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

// create one config-adjacent icon directory
async function iconFixtureDirectory(): Promise<{ configPath: string; iconDirectory: string }> {
  const root = await mkdtemp(join(tmpdir(), 'rac-instance-icons-'));
  temporaryRoots.push(root);
  const configPath = join(root, 'config', 'server.yaml');
  const iconDirectory = join(root, 'config', 'instance-icons');
  await mkdir(iconDirectory, { recursive: true });
  await writeFile(configPath, 'name: synthetic\n');
  return { configPath, iconDirectory };
}

// verify portable artwork and local file loading
describe('instance icon artwork', () => {
  // keep the portable fallback self-contained
  it('renders the generic terminal frame and scan lines by default', () => {
    const svg = instanceIconSvg();
    const scanLines = svg.indexOf('stroke-opacity=".42"');
    const terminalBadge = svg.indexOf('<circle');

    expect(svg).toContain('<rect width="64" height="64" rx="7.4"');
    expect(svg).toContain('<rect x=".75" y=".75" width="62.5" height="62.5"');
    expect(svg).not.toContain('<rect x="5" y="5"');
    expect(scanLines).toBeGreaterThan(-1);
    expect(scanLines).toBeLessThan(terminalBadge);
  });

  // accept any library name while refusing paths and malformed names
  it('recognizes icon names by the library name pattern', () => {
    for (const name of ['terminal', 'heart', 'potato', 'rocket-2', '0', 'a'.repeat(32)]) expect(isInstanceIconName(name)).toBe(true);
    for (const name of ['', '-lead', 'Upper', 'under_score', 'dot.ted', '../x', 'a/b', 'a'.repeat(33), ' heart']) expect(isInstanceIconName(name)).toBe(false);
  });

  // load private custom files without rewriting bytes
  it('loads custom icon aliases verbatim beside the configured file', async () => {
    const { configPath, iconDirectory } = await iconFixtureDirectory();
    const firstFixture = '<svg data-fixture="first"></svg>\n';
    const secondFixture = '<svg data-fixture="second"></svg>\n';
    await writeFile(join(iconDirectory, 'heart.svg'), firstFixture);
    await writeFile(join(iconDirectory, 'potato.svg'), secondFixture);

    await expect(loadInstanceIconSvg('heart', configPath)).resolves.toBe(firstFixture);
    await expect(loadInstanceIconSvg('potato', configPath)).resolves.toBe(secondFixture);
  });

  // list every valid library file after the built-in terminal
  it('lists the built-in terminal then each named svg file in the library', async () => {
    const { configPath, iconDirectory } = await iconFixtureDirectory();
    for (const file of ['potato.svg', 'heart.svg', 'rocket-2.svg', 'terminal.svg', 'notes.txt', 'Bad_Name.svg', '.hidden.svg']) await writeFile(join(iconDirectory, file), '<svg></svg>\n');
    await mkdir(join(iconDirectory, 'folder.svg'));

    await expect(listInstanceIcons(configPath)).resolves.toEqual(['terminal', 'heart', 'potato', 'rocket-2']);
  });

  // keep the library usable before any artwork exists
  it('lists only the terminal without a library directory or config', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rac-instance-icons-'));
    temporaryRoots.push(root);
    vi.stubEnv('RAC_CONFIG', undefined);

    await expect(listInstanceIcons(join(root, 'server.yaml'))).resolves.toEqual(['terminal']);
    await expect(listInstanceIcons()).resolves.toEqual(['terminal']);
  });

  // keep the portable terminal icon built in
  it('ignores a local terminal file when config is available', async () => {
    const { configPath, iconDirectory } = await iconFixtureDirectory();
    await writeFile(join(iconDirectory, 'terminal.svg'), '<svg data-fixture="ignored"></svg>\n');
    vi.stubEnv('RAC_CONFIG', configPath);

    await expect(loadInstanceIconSvg()).resolves.toBe(instanceIconSvg());
  });

  // never read outside the library, whoever passes the name
  it('falls back instead of reading a name that would traverse', async () => {
    const { configPath } = await iconFixtureDirectory();
    await writeFile(join(configPath, '..', 'x.svg'), '<svg data-fixture="outside"></svg>\n');

    await expect(loadInstanceIconSvg('../x', configPath)).resolves.toBe(instanceIconSvg());
  });

  // use the generic artwork without a config path
  it('falls back when no config file is configured', async () => {
    vi.stubEnv('RAC_CONFIG', undefined);

    await expect(loadInstanceIconSvg('heart')).resolves.toBe(instanceIconSvg());
  });

  // use the generic artwork for an absent private file
  it('falls back when a configured custom asset is missing', async () => {
    const { configPath } = await iconFixtureDirectory();

    await expect(loadInstanceIconSvg('potato', configPath)).resolves.toBe(instanceIconSvg());
  });

  // retain filesystem diagnostics behind a stable message
  it('preserves non-missing read failures without exposing local paths', async () => {
    const { configPath, iconDirectory } = await iconFixtureDirectory();
    await mkdir(join(iconDirectory, 'heart.svg'));

    await expect(loadInstanceIconSvg('heart', configPath)).rejects.toMatchObject({ message: 'icon unavailable', cause: { code: 'EISDIR' } });
  });

  // preserve the favicon silhouette after installation
  it('publishes the rounded icon without adaptive masking', async () => {
    const manifest = JSON.parse(await readFile(new URL('../../web/public/manifest.webmanifest', import.meta.url), 'utf8')) as { icons?: Array<{ src?: string; purpose?: string }> };

    expect(manifest.icons).toContainEqual(expect.objectContaining({ src: '/favicon.svg', purpose: 'any' }));
    expect(manifest.icons).not.toContainEqual(expect.objectContaining({ purpose: expect.stringContaining('maskable') }));
  });
});
