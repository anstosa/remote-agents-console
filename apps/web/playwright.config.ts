import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  use: {
    baseURL: 'http://127.0.0.1:4173',
    // preserve failure evidence in ci without changing local screenshot behavior
    screenshot: process.env.CI ? 'only-on-failure' : 'off',
  },
  webServer: {
    // exercise emitted assets when the suite enables production page and worker policies
    command: process.env.RAC_E2E_PRODUCTION_POLICY === '1'
      ? 'pnpm exec vite preview --host 127.0.0.1 --port 4173'
      : 'pnpm exec vite --host 127.0.0.1 --port 4173',
    wait: { stdout: /Local:/u },
  },
});
