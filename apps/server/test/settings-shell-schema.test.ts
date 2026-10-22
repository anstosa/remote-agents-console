import { describe, expect, it } from 'vitest';
import { parseKeysConfig } from '../src/config/keys.js';
import { sourceSchema } from '../src/config/schema.js';
import type { SettingsSchema } from '../src/settings/contracts.js';
import { applicationSettingsSchema } from '../src/settings/schema.js';

// read one required property from presentation metadata
function property(schema: SettingsSchema | undefined, key: string): SettingsSchema {
  const value = schema?.properties?.[key];
  expect(value, `missing schema property ${key}`).toBeDefined();
  return value!;
}

describe('shell command settings metadata', () => {
  // mark application and adapter shell commands without marking literal launch values
  it('annotates application and adapter shell commands only', () => {
    const application = applicationSettingsSchema();
    const adapters = property(application, 'adapters');

    expect(property(application, 'editor')).toMatchObject({ editor: 'shell', singleLine: true });
    // verify every supported adapter has the same explicit command metadata
    for (const adapter of Object.values(adapters.properties ?? {})) {
      expect(property(adapter, 'setup').editor).toBe('shell');
      expect(property(adapter, 'teardown').editor).toBe('shell');
      expect(property(adapter, 'setup').singleLine).toBeUndefined();
      expect(property(adapter, 'teardown').singleLine).toBeUndefined();
      const updates = property(adapter, 'updates');
      // verify the complete update-command contract
      for (const command of ['current', 'latest', 'run']) {
        expect(property(updates, command).editor).toBe('shell');
        expect(property(updates, command).singleLine).toBeUndefined();
      }
      expect(property(adapter, 'program').editor).toBeUndefined();
      expect(property(adapter, 'args').items?.editor).toBeUndefined();
      expect(property(adapter, 'env').items?.editor).toBeUndefined();
    }
  });

  // mark project, override, process, and keyboard commands without marking names or prompts
  it('annotates project and keyboard shell commands only', () => {
    const application = applicationSettingsSchema();
    const project = property(application, 'projects').items!;
    const override = property(project, 'worktreeOverrides').items!;
    const terminal = property(application, 'keys').items!.items!.variants!.find(variant => variant.label === 'Terminal command')!;
    const review = property(application, 'review');

    expect(property(project, 'newTask').editor).toBe('shell');
    expect(property(project, 'newTask').singleLine).toBeUndefined();
    // verify project and override command sets use the same presentation metadata
    for (const owner of [project, override]) {
      const commands = property(owner, 'commands');
      // verify every one-shot stack command
      for (const command of ['start', 'stop', 'build', 'restart', 'migrate', 'status', 'setup']) {
        expect(property(commands, command).editor).toBe('shell');
        expect(property(commands, command).singleLine).toBeUndefined();
      }
      const process = property(commands, 'processes').items!;
      const scalar = process.variants!.find(variant => variant.type === 'string')!;
      const object = process.variants!.find(variant => variant.type === 'object')!;
      expect(process.editor).toBeUndefined();
      expect(scalar.editor).toBe('shell');
      expect(scalar.singleLine).toBeUndefined();
      expect(property(object, 'command').editor).toBe('shell');
      expect(property(object, 'command').singleLine).toBeUndefined();
      expect(property(object, 'dependsOn').items?.editor).toBeUndefined();
    }
    expect(property(terminal, 'terminal')).toMatchObject({ editor: 'shell', singleLine: true });
    expect(property(project, 'path').editor).toBeUndefined();
    const buttonAction = property(property(project, 'buttons'), 'pullRequest').items!.properties!.action!;
    expect(buttonAction.variants!.find(variant => variant.label === 'Shell command')!.properties?.shellCommand?.editor).toBe('shell');
    expect(buttonAction.variants!.find(variant => variant.label === 'Agent prompt')!.properties?.agentPrompt?.editor).toBeUndefined();
    expect(property(property(review, 'tour'), 'prompt').editor).toBeUndefined();
    expect(property(review, 'presets').items?.properties?.prompt?.editor).toBeUndefined();
  });

  // preserve the single-line validation contract for editor and keyboard commands
  it('keeps editor and keyboard terminal commands single-line', () => {
    expect(sourceSchema.parse({ publicOrigin: 'https://agents.example.com', editor: ' nvim -p ' }).editor).toBe('nvim -p');
    expect(() => sourceSchema.parse({ publicOrigin: 'https://agents.example.com', editor: 'nvim\nrm -rf ~' })).toThrow('newlines');
    expect(parseKeysConfig({ prefix: { e: { terminal: ' nvim -p ' } } })).toMatchObject({ prefix: { e: { terminal: 'nvim -p' } } });
    expect(() => parseKeysConfig({ prefix: { e: { terminal: 'nvim\nrm -rf ~' } } })).toThrow('newlines');
  });
});
