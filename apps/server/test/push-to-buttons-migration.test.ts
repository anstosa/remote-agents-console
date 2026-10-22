import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultButtons, effectiveButtons, type ButtonSlots, type ConfiguredButton, type ProjectButtons } from '../src/config/buttons.js';
import { acquireConfig } from '../src/migrations/boot.js';
import { isLegacyConfig, MigrationError, runMigration } from '../src/migrations/runner.js';
import { needsPushToButtonsMigration, planPushToButtonsMigration } from '../src/migrations/push-to-buttons.js';
import { planMigration, type ResolvedFacts } from '../src/migrations/worktrees-to-projects.js';
import { contentHash } from '../src/settings/proof.js';

// expose the filesystem publication boundary without changing its default behavior
vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>() }));

const directories: string[] = [];
// restore filesystem spies before removing isolated fixtures
afterEach(async () => { vi.restoreAllMocks(); for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

// isolate every migration file beneath one temporary root
async function fixture(raw: unknown): Promise<{ root: string; configPath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'rac-buttons-migration-'));
  directories.push(root);
  const configPath = join(root, 'config.json');
  await writeFile(configPath, JSON.stringify(raw));
  return { root, configPath };
}

const dataEnv = (root: string): NodeJS.ProcessEnv => ({
  RAC_NOTES_FILE: join(root, 'notes.json'),
  RAC_SAVED_PROMPTS_FILE: join(root, 'saved.json'),
  RAC_QUEUED_PROMPTS_FILE: join(root, 'queued.json'),
  RAC_PROMPT_HISTORY_FILE: join(root, 'history.json'),
  RAC_REVIEW_TOURS_FILE: join(root, 'tours.json'),
  RAC_WORKTREES_FILE: join(root, 'worktrees.json')
});

describe('push-to-buttons migration planner', () => {
  it('materializes defaults for zero-project and implicit-default configurations', () => {
    const empty = planPushToButtonsMigration({ publicOrigin: 'https://agents.example.com' });
    expect(empty.errors).toEqual([]);
    expect(empty.newConfig.buttons).toEqual(defaultButtons);
    const implicit = planPushToButtonsMigration({ publicOrigin: 'https://agents.example.com', projects: [{ id: 'p', path: '/p' }] });
    expect(implicit.newConfig.projects).toEqual([{ id: 'p', path: '/p' }]);
    expect(needsPushToButtonsMigration(implicit.newConfig)).toBe(false);
  });

  it('omits an exact default override and preserves custom prompt bytes', () => {
    const prompt = '  review this\n    then push\n';
    const plan = planPushToButtonsMigration({ publicOrigin: 'https://agents.example.com', projects: [
      { id: 'default', path: '/default', push: { label: 'Commit/Push', prompt: 'review, commit, and push' } },
      { id: 'custom', path: '/custom', push: { label: 'Commit/Push', prompt } }
    ] });
    const projects = plan.newConfig.projects as { buttons?: { pullRequest?: { action: { agentPrompt: string } }[] } }[];
    expect(projects[0]).not.toHaveProperty('push');
    expect(projects[0]).not.toHaveProperty('buttons');
    expect(projects[1]!.buttons!.pullRequest![0]!.action.agentPrompt).toBe(prompt);
    expect(effectiveButtons(defaultButtons, projects[1]!.buttons).pullRequest.map(button => button.text)).toEqual(['Commit/Push', '$fixup']);
  });

  // preserve a shared legacy label without retaining an extra application push
  it('lifts a common Push label and keeps each exact project prompt behind one button', () => {
    const customPrompt = '  review this project\nthen push\n';
    const plan = planPushToButtonsMigration({ projects: [
      { id: 'default', path: '/default', push: { label: 'Push', prompt: 'review, commit, and push' } },
      { id: 'custom', path: '/custom', push: { label: 'Push', prompt: customPrompt } }
    ] });
    const application = plan.newConfig.buttons as ButtonSlots;
    const projects = plan.newConfig.projects as { buttons?: ProjectButtons }[];

    expect(plan.errors).toEqual([]);
    expect(application.pullRequest.map(button => button.text)).toEqual(['Push', '$fixup']);
    expect(projects[0]).not.toHaveProperty('buttons');
    expect(effectiveButtons(application, projects[0]!.buttons).pullRequest.map(button => button.text)).toEqual(['Push', '$fixup']);
    const custom = effectiveButtons(application, projects[1]!.buttons).pullRequest;
    expect(custom.map(button => button.text)).toEqual(['Push', '$fixup']);
    expect(custom[0]!.action).toEqual({ agentPrompt: customPrompt });
    expect(needsPushToButtonsMigration(plan.newConfig)).toBe(false);
  });

  // do not rename an implicit default merely because another project chose a label
  it('leaves distinct legacy labels and fixup collisions on the exact-text merge path', () => {
    const mixed = planPushToButtonsMigration({ projects: [
      { id: 'implicit', path: '/implicit' },
      { id: 'custom', path: '/custom', push: { label: 'Push', prompt: 'push this project' } }
    ] });
    expect((mixed.newConfig.buttons as ButtonSlots).pullRequest.map(button => button.text)).toEqual(['Commit/Push', '$fixup']);
    const fixup = planPushToButtonsMigration({ projects: [{ id: 'fixup', path: '/fixup', push: { label: '$fixup', prompt: '$fixup' } }] });
    expect((fixup.newConfig.buttons as ButtonSlots).pullRequest.map(button => button.text)).toEqual(['Commit/Push', '$fixup']);
  });

  it('uses the generic merge for fixup collisions and unmatched labels', () => {
    const fixupPrompt = '  $fixup\nwith extra context\n';
    const plan = planPushToButtonsMigration({ projects: [
      { id: 'fix', path: '/fix', push: { label: '$fixup', prompt: fixupPrompt } },
      { id: 'ship', path: '/ship', push: { label: 'Ship', prompt: 'ship it' } }
    ] });
    const projects = plan.newConfig.projects as { buttons: Parameters<typeof effectiveButtons>[1] }[];
    const fixup = effectiveButtons(defaultButtons, projects[0]!.buttons);
    const ship = effectiveButtons(defaultButtons, projects[1]!.buttons);
    expect(fixup.pullRequest.map(button => button.text)).toEqual(['Commit/Push', '$fixup']);
    expect(fixup.pullRequest[1]!.action).toEqual({ agentPrompt: fixupPrompt });
    expect(ship.pullRequest.map(button => button.text)).toEqual(['Commit/Push', '$fixup', 'Ship']);
  });

  it('rejects mixed representations, whitespace prompts, and invalid legacy fields', () => {
    const mixed = planPushToButtonsMigration({ buttons: defaultButtons, projects: [{ id: 'p', path: '/p', push: { label: 'Push', prompt: 'push' } }] });
    expect(mixed.errors.join('\n')).toContain('both `buttons` and legacy `projects[].push`');
    const whitespace = planPushToButtonsMigration({ projects: [{ id: 'p', path: '/p', push: { label: 'Push', prompt: '   ' } }] });
    expect(whitespace.errors).toContain('projects.0.push.prompt cannot be blank');
    const wrong = planPushToButtonsMigration({ projects: [{ id: 'p', path: '/p', push: { label: 7, prompt: null } }] });
    expect(wrong.errors.join('\n')).toContain('projects.0.push.label');
    expect(wrong.errors.join('\n')).toContain('projects.0.push.prompt');
  });

  it('composes after worktrees-to-projects before validation', () => {
    const facts: ResolvedFacts = { entries: [{ realpath: '/repo', toplevel: '/repo', commonDir: '/repo/.git', main: true }], commands: {} };
    const projects = planMigration({ publicOrigin: 'https://agents.example.com', adapters: { codex: { program: '/usr/bin/codex' } }, worktrees: [{ id: 'p', path: '/repo', push: { label: 'Ship', prompt: 'ship it' } }] }, facts);
    const buttons = planPushToButtonsMigration(projects.newConfig);
    expect((buttons.newConfig.projects as { buttons: { pullRequest: ConfiguredButton[] } }[])[0]!.buttons.pullRequest[0]!.text).toBe('Ship');
    expect(buttons.newConfig).toHaveProperty('buttons');
  });
});

describe('push-to-buttons migration runner', () => {
  // preserve a concurrent writer at the config publication boundary
  it.each(['edit', 'replacement'])('refuses a concurrent config %s after migration planning', async kind => {
    const { root, configPath } = await fixture({ publicOrigin: 'https://agents.example.com', projects: [] });
    const original = await readFile(configPath, 'utf8');
    const external = JSON.stringify({ publicOrigin: 'https://edited.example.com', projects: [] });
    const write = writeFile;
    vi.spyOn(fs, 'writeFile').mockImplementation(async (...args: Parameters<typeof writeFile>) => {
      // introduce the competing edit after the planned output has been staged
      if (String(args[0]).endsWith('.tmp')) {
        // identical replacement bytes must not conceal a changed file identity
        if (kind === 'replacement') {
          await write(`${configPath}.external`, original);
          await fs.rename(`${configPath}.external`, configPath);
        } else await write(configPath, external);
      }
      return write(...args);
    });
    await expect(runMigration({ configPath, env: dataEnv(root) })).rejects.toThrow('configuration changed during migration');
    const retained = kind === 'replacement' ? original : external;
    expect(await readFile(configPath, 'utf8')).toBe(retained);
    expect((await fs.readdir(root)).filter(name => name.endsWith('.tmp'))).toEqual([]);
    await expect(readFile(`${configPath}.pre-buttons.bak`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    vi.restoreAllMocks();
    // retry from the winning writer's bytes with its own fresh rollback copy
    await runMigration({ configPath, env: dataEnv(root) });
    expect(await readFile(`${configPath}.pre-buttons.bak`, 'utf8')).toBe(retained);
  });

  // data-store migrations cannot claim a config-only transition
  it('omits app-only evidence when the projects migration also runs', async () => {
    const { root, configPath } = await fixture({ publicOrigin: 'https://agents.example.com', adapters: { codex: { program: '/usr/bin/codex' } }, worktrees: [] });
    const report = await runMigration({ configPath, env: dataEnv(root) });
    expect(report.buttons?.defaults).toBe(true);
    expect(report).not.toHaveProperty('sourceMigration');
    expect(report.backups).toContain(`${configPath}.pre-projects.bak`);
  });

  // malformed project collections cannot be silently replaced with an empty list
  it.each([null, 'invalid', { id: 'retained-project' }])('rejects malformed projects without writes: %j', async projects => {
    const { root, configPath } = await fixture({ publicOrigin: 'https://agents.example.com', projects });
    const original = await readFile(configPath, 'utf8');

    await expect(runMigration({ configPath, env: dataEnv(root) })).rejects.toBeInstanceOf(MigrationError);
    expect(await readFile(configPath, 'utf8')).toBe(original);
    await expect(readFile(`${configPath}.pre-buttons.bak`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  // bind replacement proof to the exact migration input and output
  it('writes one validated config last, creates a private backup, and is byte-idempotent', async () => {
    const { root, configPath } = await fixture({ publicOrigin: 'https://agents.example.com', projects: [{ id: 'p', path: '/missing', push: { label: 'Ship', prompt: 'ship it' } }] });
    // the earlier migration's backup must not replace this stage's rollback copy
    await writeFile(`${configPath}.pre-projects.bak`, 'earlier migration backup');
    const original = await readFile(configPath, 'utf8');
    const report = await runMigration({ configPath, env: dataEnv(root) });
    const first = await readFile(configPath, 'utf8');
    expect(report.buttons).toEqual({ defaults: true, projects: 1 });
    expect(report.sourceMigration).toEqual({ kind: 'push-to-buttons-v1', fromHash: contentHash(original), toHash: contentHash(first) });
    expect(isLegacyConfig(JSON.parse(first))).toBe(false);
    expect((await stat(`${configPath}.pre-buttons.bak`)).mode & 0o777).toBe(0o600);
    expect(await readFile(`${configPath}.pre-buttons.bak`, 'utf8')).toBe(original);
    expect(await readFile(`${configPath}.pre-projects.bak`, 'utf8')).toBe('earlier migration backup');
    expect(isLegacyConfig(JSON.parse(first))).toBe(false);
    const second = await readFile(configPath, 'utf8');
    expect(second).toBe(first);
  });

  it('refuses mixed representations without writing or backing up', async () => {
    const raw = { publicOrigin: 'https://agents.example.com', buttons: defaultButtons, projects: [{ id: 'p', path: '/missing', push: { label: 'Ship', prompt: 'ship it' } }] };
    const { root, configPath } = await fixture(raw);
    const original = await readFile(configPath, 'utf8');
    await expect(runMigration({ configPath, env: dataEnv(root) })).rejects.toBeInstanceOf(MigrationError);
    expect(await readFile(configPath, 'utf8')).toBe(original);
    await expect(readFile(`${configPath}.pre-buttons.bak`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  // carry only this boot's completed transition into its attestation
  it('boot rereads the exact migrated content before returning validated defaults', async () => {
    const { root, configPath } = await fixture({ publicOrigin: 'https://agents.example.com', projects: [] });
    const original = await readFile(configPath, 'utf8');
    let loaded = '';
    let transition: unknown;
    const config = await acquireConfig({ RAC_CONFIG: configPath, ...dataEnv(root) }, () => {}, (content, migration) => { loaded = content; transition = migration; });
    expect(loaded).toBe(await readFile(configPath, 'utf8'));
    expect(transition).toEqual({ kind: 'push-to-buttons-v1', fromHash: contentHash(original), toHash: contentHash(loaded) });
    expect(config.buttons).toEqual(defaultButtons);
    // a later boot must not replay evidence from an earlier migration
    await acquireConfig({ RAC_CONFIG: configPath, ...dataEnv(root) }, () => {}, (_content, migration) => { transition = migration; });
    expect(transition).toBeUndefined();
  });
});
