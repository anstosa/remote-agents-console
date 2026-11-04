import { describe, expect, it } from 'vitest';
import { validateConfig } from '../src/config/schema.js';

const base = { publicOrigin: 'https://agents.example.com', projects: [] as unknown[] };

describe('configured launch model policy', () => {
  // preserve ordered native lists and explicit empty presence for every kind
  it('accepts safe non-Pi model and Effort tokens without a provider slash', async () => {
    const allowedModels = [{ model: 'native-model', effort: 'xhigh' }, { model: 'provider/model' }];
    const config = await validateConfig({ ...base, adapters: {
      codex: { program: process.execPath, allowedModels },
      omx: { program: process.execPath, allowedModels },
      claude: { program: process.execPath, allowedModels },
      opencode: { program: process.execPath, allowedModels: [] }
    } });

    expect(config.adapters.codex?.allowedModels).toEqual(allowedModels);
    expect(config.adapters.omx?.allowedModels).toEqual(allowedModels);
    expect(config.adapters.claude?.allowedModels).toEqual(allowedModels);
    expect(config.adapters.opencode?.allowedModels).toEqual([]);
  });

  // reject duplicate, unsafe, and oversized persisted policies at boot
  it('bounds and validates every native Allowed-model list', async () => {
    await expect(validateConfig({ ...base, adapters: { codex: { program: process.execPath, allowedModels: [{ model: 'a' }, { model: 'a' }] } } })).rejects.toThrow(/once/u);
    await expect(validateConfig({ ...base, adapters: { claude: { program: process.execPath, allowedModels: [{ model: 'a', effort: 'bad effort' }] } } })).rejects.toThrow(/bounded native token/u);
    await expect(validateConfig({ ...base, adapters: { omx: { program: process.execPath, allowedModels: Array.from({ length: 51 }, (_value, index) => ({ model: `model-${index}` })) } } })).rejects.toThrow();
    await expect(validateConfig({ ...base, adapters: { pi: { allowedModels: [{ model: 'native-model' }] } } })).rejects.toThrow(/provider\/id/u);
  });
});
