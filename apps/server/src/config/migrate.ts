import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runCli, type CliContext } from './cli.js';
import { formatReport, migrationErrorLines } from '../migrations/boot.js';
import { isLegacyConfig, runMigration } from '../migrations/runner.js';

/**
 * Migrate one legacy configuration in place without booting the server — the escape hatch
 * for a config a read-only deployment cannot rewrite at boot (systemd, Docker). Takes a
 * positional path or `RAC_CONFIG`, honours the `RAC_*_FILE` data overrides, and writes to
 * the file it read; no Compose path mapping. Returns the process exit code.
 */
export async function migrateMain({ args, env, cwd, out, err }: CliContext): Promise<number> {
  const argument = args.find(value => value !== '--' && !value.startsWith('--'));
  const configured = argument ?? env.RAC_CONFIG;
  if (!configured) { err('Configuration invalid: Pass a configuration path or set RAC_CONFIG.\n'); return 1; }
  const path = resolve(cwd, configured);
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as unknown;
    // a config already in the new shape has nothing to migrate
    if (!isLegacyConfig(raw)) { out(`Configuration already uses the current schema; nothing to migrate: ${path}\n`); return 0; }
    const report = await runMigration({ configPath: path, bridge: env.RAC_HOST_TMUX_DIR !== undefined, env });
    out(`Configuration migrated: ${path}\n`);
    for (const line of formatReport(report)) out(`  ${line}\n`);
    return 0;
  } catch (error) {
    // list every content or writability problem
    for (const message of migrationErrorLines(error)) err(`Configuration invalid: ${message}\n`);
    return 1;
  }
}

await runCli(import.meta.url, migrateMain);
