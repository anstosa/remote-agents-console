// Command catalog scanner tests. (Named `skills.test.ts` for continuity — the
// deletion hook blocks a rename; the subject is now CommandCatalogService, which
// superseded the old SkillService.)
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandCatalogService } from '../src/commands/service.js';
import { codexAppServerCatalog } from '../src/commands/codex-app-server.js';
import { createCodexProtocolClient } from '../src/accounts/protocol.js';
import { codexAdapter } from '../src/adapters/codex.js';
import { claudeAdapter } from '../src/adapters/claude.js';

const roots: string[] = [];

async function tempRoot(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function writeSkill(base: string, directory: string, contents: string) {
  const path = join(base, '.codex', 'skills', directory);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'SKILL.md'), contents);
  return path;
}

const skill = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\n`;
// resolve one test codex state directory
const codexHome = (home: string) => join(home, '.codex');
// force filesystem compatibility discovery
const fallbackCatalog = () => new CommandCatalogService(async () => undefined);

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('command catalog', () => {
  it('scans the account home and workspace, follows symlinked skills, and appends the slash list', async () => {
    const home = await tempRoot('rac-home-');
    const workspace = await tempRoot('rac-workspace-');
    await writeSkill(home, 'release-notes', skill('release-notes', 'Draft release notes for this repository.'));
    await writeSkill(workspace, 'push', skill('push', 'Review, commit, and push the current branch.'));
    // a symlinked skill directory is followed, not skipped
    const target = join(await tempRoot('rac-linked-'), 'linked');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'SKILL.md'), skill('linked', 'A symlinked skill.'));
    await symlink(target, join(workspace, '.codex', 'skills', 'linked'));

    const catalog = await fallbackCatalog().catalog(codexAdapter, workspace, codexHome(home));

    expect(catalog.filter(command => command.value.startsWith('$'))).toEqual([
      { value: '$linked', description: 'A symlinked skill.' },
      { value: '$push', description: 'Review, commit, and push the current branch.' },
      { value: '$release-notes', description: 'Draft release notes for this repository.' }
    ]);
    expect(catalog.find(command => command.value === '/help')).toEqual({ value: '/help', description: 'Show available commands' });
    expect(catalog.find(command => command.value === '/permissions')).toEqual({ value: '/permissions', description: 'Choose what Codex is allowed to do' });
    expect(catalog.find(command => command.value === '/plugins')).toEqual({ value: '/plugins', description: 'Browse plugins' });
    expect(catalog.some(command => command.value === '/agent')).toBe(true);
    expect(catalog.some(command => command.value === '/agents')).toBe(true);
    // include public built-ins even without a runtime catalog
    expect(catalog.map(command => command.value)).toEqual(expect.arrayContaining([
      '/presets', '/daybreak', '/config', '/worktree', '/voice', '/tui', '/daemon', '/warnings',
    ]));
    // do not guess model tiers for codex
    expect(catalog.map(command => command.value)).not.toContain('/fast');
    // the default codex release does not support remote control
    expect(catalog.map(command => command.value)).not.toContain('/rc');
    // the slash list follows the skills
    expect(catalog.findIndex(command => command.value === '/help')).toBeGreaterThan(catalog.findIndex(command => command.value === '$push'));
  });

  it('lets a workspace skill shadow the same-named account skill', async () => {
    const home = await tempRoot('rac-home-');
    const workspace = await tempRoot('rac-workspace-');
    await writeSkill(home, 'push', skill('push', 'Global push.'));
    await writeSkill(workspace, 'push', skill('push', 'Workspace push.'));

    const catalog = await fallbackCatalog().catalog(codexAdapter, workspace, codexHome(home));

    expect(catalog.find(command => command.value === '$push')).toEqual({ value: '$push', description: 'Workspace push.' });
  });

  it('gives Claude one deduped / list where a skill wins over a same-named built-in', async () => {
    const home = await tempRoot('rac-home-');
    const workspace = await tempRoot('rac-workspace-');
    // a workspace skill named `review` collides with Claude's built-in `/review`
    const reviewSkill = join(workspace, '.claude', 'skills', 'review');
    await mkdir(reviewSkill, { recursive: true });
    await writeFile(join(reviewSkill, 'SKILL.md'), skill('review', 'Custom project review workflow.'));

    const catalog = await fallbackCatalog().catalog(claudeAdapter, workspace, join(home, '.claude'));

    // Claude invokes skills as `/name`, so the skill and built-in share the `/review` trigger;
    // the list carries it once, and the skill wins
    expect(catalog.filter(command => command.value === '/review')).toEqual([{ value: '/review', description: 'Custom project review workflow.' }]);
    // a built-in with no colliding skill is untouched
    expect(catalog.find(command => command.value === '/help')).toEqual({ value: '/help', description: 'Show available commands' });
    expect(catalog.map(command => command.value)).toEqual(expect.arrayContaining([
      '/fast', '/effort', '/plan', '/goal', '/btw', '/mcp', '/plugin', '/skills', '/tasks',
    ]));
  });

  it('tolerates a zero-byte file where a skills root should be', async () => {
    const home = await tempRoot('rac-home-');
    const workspace = await tempRoot('rac-workspace-');
    await writeSkill(home, 'release-notes', skill('release-notes', 'Draft release notes.'));
    // the workspace skills root is a zero-byte file, not a directory
    await mkdir(join(workspace, '.codex'), { recursive: true });
    await writeFile(join(workspace, '.codex', 'skills'), '');

    const catalog = await fallbackCatalog().catalog(codexAdapter, workspace, codexHome(home));

    expect(catalog.filter(command => command.value.startsWith('$'))).toEqual([{ value: '$release-notes', description: 'Draft release notes.' }]);
  });

  it('ignores malformed metadata and unavailable roots', async () => {
    const home = await tempRoot('rac-home-');
    const workspace = await tempRoot('rac-workspace-');
    await writeSkill(workspace, 'missing-description', `---\nname: missing-description\n---\n`);
    await writeSkill(workspace, 'invalid-name', skill('not a command', 'Invalid.'));

    const catalog = await fallbackCatalog().catalog(codexAdapter, workspace, codexHome(home));

    expect(catalog.some(command => command.value.startsWith('$'))).toBe(false);
  });

  it('finds bundled system and plugin skills when runtime discovery is unavailable', async () => {
    const home = await tempRoot('rac-home-');
    const workspace = await tempRoot('rac-workspace-');
    await writeSkill(home, '.system/imagegen', skill('imagegen', 'Generate images.'));
    await writeFile(join(home, '.codex', 'config.toml'), '[plugins."notion@openai-curated-remote"]\nenabled = true\n\n[plugins."canva@openai-curated"]\nenabled = false\n');
    const oldPluginSkill = join(home, '.codex', 'plugins', 'cache', 'openai-curated-remote', 'notion', '0.1.0', 'skills', 'meeting');
    await mkdir(oldPluginSkill, { recursive: true });
    await writeFile(join(oldPluginSkill, 'SKILL.md'), skill('meeting', 'Prepare old meetings.'));
    const activePluginSkill = join(home, '.codex', 'plugins', 'cache', 'openai-curated-remote', 'notion', '0.2.0', 'skills', 'meeting');
    await mkdir(activePluginSkill, { recursive: true });
    await writeFile(join(activePluginSkill, 'SKILL.md'), skill('meeting', 'Prepare meetings.'));
    const disabledPluginSkill = join(home, '.codex', 'plugins', 'cache', 'openai-curated', 'canva', '1.0.0', 'skills', 'design');
    await mkdir(disabledPluginSkill, { recursive: true });
    await writeFile(join(disabledPluginSkill, 'SKILL.md'), skill('design', 'Design with Canva.'));

    const catalog = await fallbackCatalog().catalog(codexAdapter, workspace, codexHome(home));

    expect(catalog).toContainEqual({ value: '$imagegen', description: 'Generate images.' });
    expect(catalog).toContainEqual({ value: '$notion:meeting', description: 'Prepare meetings.' });
    expect(catalog.some(command => command.value === '$canva:design')).toBe(false);
  });

  it('logs runtime failures and preserves the complete fallback catalog', async () => {
    const home = await tempRoot('rac-home-');
    const workspace = await tempRoot('rac-workspace-');
    await writeSkill(home, '.system/imagegen', skill('imagegen', 'Generate images.'));
    // capture one expected operational diagnostic
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // fail one deterministic runtime lookup
    const service = new CommandCatalogService(async () => { throw new Error('protocol unavailable'); });

    const catalog = await service.catalog(codexAdapter, workspace, codexHome(home));

    expect(catalog).toContainEqual({ value: '$imagegen', description: 'Generate images.' });
    expect(error).toHaveBeenCalled();
  });

  it('coalesces concurrent runtime catalog loads for one workspace', async () => {
    const home = await tempRoot('rac-home-');
    const workspace = await tempRoot('rac-workspace-');
    let loads = 0;
    // delay one deterministic runtime response
    const service = new CommandCatalogService(async () => {
      loads += 1;
      await new Promise(resolve => setTimeout(resolve, 10));
      return { skills: [{ name: 'imagegen', description: 'Generate images.' }], slash: [] };
    });

    await Promise.all([
      service.catalog(codexAdapter, workspace, codexHome(home)),
      service.catalog(codexAdapter, workspace, codexHome(home)),
    ]);
    await service.catalog(codexAdapter, workspace, codexHome(home));

    expect(loads).toBe(1);
  });

  it('uses Codex runtime skills and model-specific slash commands when available', async () => {
    const home = await tempRoot('rac-home-');
    const workspace = await tempRoot('rac-workspace-');
    await writeSkill(workspace, 'filesystem-only', skill('filesystem-only', 'Fallback only.'));
    // provide one deterministic runtime catalog
    const service = new CommandCatalogService(async (seenWorkspace, seenStateDirectory) => {
      expect(seenWorkspace).toBe(workspace);
      expect(seenStateDirectory).toBe(codexHome(home));
      return {
        skills: [
          { name: 'oh-my-codex:plan', description: 'Plan through the installed plugin.' },
          { name: 'imagegen', description: 'Generate images with the bundled system skill.' },
          { name: 'imagegen', description: 'Duplicate lower-precedence metadata.' },
        ],
        slash: [{ name: '/fast', description: '1.5x speed, increased usage' }],
      };
    });

    const catalog = await service.catalog(codexAdapter, workspace, codexHome(home));

    expect(catalog.filter(command => command.value.startsWith('$'))).toEqual([
      { value: '$imagegen', description: 'Generate images with the bundled system skill.' },
      { value: '$oh-my-codex:plan', description: 'Plan through the installed plugin.' },
    ]);
    expect(catalog).toContainEqual({ value: '/fast', description: '1.5x speed, increased usage' });
    expect(catalog).toContainEqual({ value: '/agents', description: 'View and switch between all active agent sessions' });
    expect(catalog).toContainEqual({ value: '/recap', description: 'Summarize the current conversation now' });
    expect(catalog).toContainEqual({ value: '/agent', description: 'Switch the active agent thread' });
    expect(catalog.some(command => command.value === '$filesystem-only')).toBe(false);
  });

  it('reads enabled skills and service-tier commands from the Codex app-server protocol', async () => {
    const workspace = await tempRoot('rac-workspace-');
    const executable = join(await tempRoot('rac-codex-'), 'fake-codex.mjs');
    await writeFile(executable, `#!/usr/bin/env node
import { createInterface } from 'node:readline';
const input = createInterface({ input: process.stdin });
// serve the protocol responses
input.on('line', line => {
  const message = JSON.parse(line);
  // initialize the client
  if (message.id === 1) return process.stdout.write(JSON.stringify({ id: 1, result: { userAgent: 'remote-agent-console/0.151.0' } }) + '\\n');
  // return runtime skills
  if (message.method === 'skills/list') return process.stdout.write(JSON.stringify({ id: message.id, result: { data: [{ cwd: message.params.cwds[0], errors: [], skills: [
    { name: 'oh-my-codex:plan', description: '  Plugin   plan. ', enabled: true },
    { name: 'imagegen', description: 'Bundled image generation.', enabled: true },
    { name: 'disabled', description: 'Unavailable.', enabled: false }
  ] }] } }) + '\\n');
  // return dynamic commands
  if (message.method === 'model/list') return process.stdout.write(JSON.stringify({ id: message.id, result: { data: [
    { serviceTiers: [{ id: 'priority', name: 'Fast', description: '1.5x speed, increased usage' }] },
    { serviceTiers: [{ id: 'priority', name: 'Fast', description: '1.5x speed, increased usage' }] }
  ] } }) + '\\n');
});
`);
    await chmod(executable, 0o755);

    const home = await tempRoot('rac-home-');
    // verify the isolated protocol home and configured program
    const catalog = await codexAppServerCatalog(workspace, codexHome(home), executable, async (stateDirectory, options) => {
      expect(stateDirectory).toBe(codexHome(home));
      expect(options?.command).toBe(executable);
      return await createCodexProtocolClient(stateDirectory, options);
    });

    expect(catalog).toEqual({
      skills: [
        { name: 'oh-my-codex:plan', description: 'Plugin plan.' },
        { name: 'imagegen', description: 'Bundled image generation.' },
      ],
      slash: [{ name: '/fast', description: '1.5x speed, increased usage' }],
    });
  });
});
