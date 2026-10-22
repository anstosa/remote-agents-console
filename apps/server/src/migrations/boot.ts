import { readFile } from 'node:fs/promises';
import { applyListenOverrides, validateConfig, type ValidatedConfig } from '../config/schema.js';
import { isLegacyConfig, MigrationError, runMigration, type ConfigSourceMigration, type MigrationReport } from './runner.js';
import { contentHash } from '../settings/proof.js';

/** A migration/validation failure as one line per problem — `MigrationError` lists every one. */
export function migrationErrorLines(error: unknown): string[] {
  return error instanceof MigrationError ? error.errors : [error instanceof Error ? error.message : String(error)];
}

/** The migration report as log lines, for the boot log and `config:check`/`config:migrate`. */
export function formatReport(report: MigrationReport): string[] {
  const lines: string[] = [];
  for (const project of report.projects) lines.push(`project ${project.id}${project.mergedFrom.length > 1 ? ` (merged ${project.mergedFrom.join(', ')})` : ''}`);
  if (report.codexProgram !== undefined) lines.push(`adapters.codex.program ${report.codexProgram}`);
  if (report.buttons?.defaults === true) lines.push('application button defaults materialized');
  if ((report.buttons?.projects ?? 0) > 0) lines.push(`${report.buttons!.projects} Project push setting${report.buttons!.projects === 1 ? '' : 's'} migrated to buttons`);
  for (const [file, count] of Object.entries(report.counts)) lines.push(`${file}: ${count} record${count === 1 ? '' : 's'} re-keyed`);
  for (const backup of report.backups) lines.push(`backup ${backup}`);
  for (const warning of report.warnings) lines.push(`warning: ${warning}`);
  return lines;
}

/**
 * Read `RAC_CONFIG`, migrate it in place when it is legacy (the single boot-time migration
 * driven by the config), then validate the result. The migration writes the config last as
 * a commit marker, so a re-read here sees the migrated shape; a non-legacy config skips
 * everything and reads no data file. Errors propagate — the caller prints them as
 * `Configuration invalid:` lines and exits, replacing today's unhandled-rejection trace.
 */
export async function acquireConfig(env: NodeJS.ProcessEnv = process.env, log: (message: string) => void = message => process.stderr.write(message), loaded?: (content: string, migration?: ConfigSourceMigration) => void): Promise<ValidatedConfig> {
  const configPath = env.RAC_CONFIG;
  if (!configPath) throw new Error('RAC_CONFIG must point to a server-local configuration file');
  const raw = JSON.parse(await readFile(configPath, 'utf8')) as unknown;
  let sourceMigration: ConfigSourceMigration | undefined;
  // migrate only a legacy source and retain this boot's completed transition
  if (isLegacyConfig(raw)) {
    const report = await runMigration({ configPath, ...(env.RAC_CONFIG_WRITE_PATH === undefined ? {} : { configWritePath: env.RAC_CONFIG_WRITE_PATH }), bridge: env.RAC_HOST_TMUX_DIR !== undefined, env });
    sourceMigration = report.sourceMigration;
    log(`Configuration migrated: ${configPath}\n`);
    for (const line of formatReport(report)) log(`  ${line}\n`);
  }
  // capture the exact consumed revision for settings boot proof
  const finalContent = await readFile(configPath, 'utf8');
  // refuse edits between migration publication and configuration consumption
  if (sourceMigration !== undefined && sourceMigration.toHash !== contentHash(finalContent)) throw new MigrationError(['configuration changed after migration; retry from its current contents']);
  const finalRaw = JSON.parse(finalContent) as unknown;
  loaded?.(finalContent, sourceMigration);
  return validateConfig(applyListenOverrides(finalRaw, env), { warn: message => log(`Configuration warning: ${message}\n`) });
}
