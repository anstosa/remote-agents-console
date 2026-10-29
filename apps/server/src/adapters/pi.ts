import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { piClient, piEfforts } from '../transports/pi.js';
import { locatePiSession, piConversationName, piConversationSummaries, validPiSessionId } from './pi-conversations.js';
import type { StructuredAdapter } from './types.js';

const piPackage = '@earendil-works/pi-coding-agent';

/**
 * The pinned Pi's CLI from the server's own dependencies (ADR 0017). The package exports no
 * `package.json` and no CommonJS entry to resolve, so its directory is found on the module paths.
 */
function piProgram(): string {
  const roots = createRequire(import.meta.url).resolve.paths(piPackage) ?? [];
  const root = roots.map(directory => join(directory, piPackage)).find(directory => existsSync(join(directory, 'package.json')));
  if (root === undefined) throw new Error(`${piPackage} is not installed`);
  return join(root, 'dist', 'bundle', 'cli.js');
}

// the RAC Pi extension beside this module, compiled in a build, its source otherwise (Pi loads both)
const extension = (): string => {
  const compiled = fileURLToPath(new URL('./pi-extension.js', import.meta.url));
  return existsSync(compiled) ? compiled : compiled.replace(/\.js$/u, '.ts');
};

/**
 * The Pi Adapter: structured-only (ADR 0002 amendment). Pi is never recognised in a pane, so it
 * has no `recognizes` match and no pane members; the console drives `pi --mode rpc` through the
 * Pi client, with the RAC extension always loaded. Its program is the console's own Node, which
 * runs the pinned CLI. A resume names the session file and no model, since `--model` would
 * override the model the Conversation was on.
 */
export const piAdapter = {
  kind: 'pi',
  launch: ({ resume, models }) => ({ args: [
    piProgram(), '--mode', 'rpc', '-e', extension(),
    ...(models === undefined || models.allowed.length === 0 ? [] : ['--models', models.allowed.join(',')]),
    ...(resume !== undefined ? ['--session', resume] : models?.start === undefined ? [] : ['--model', models.start.model, ...(models.start.effort === undefined ? [] : ['--thinking', models.start.effort])])
  ] }),
  client: piClient,
  steers: true,
  efforts: piEfforts,
  conversations: { validId: validPiSessionId, list: piConversationSummaries, readName: piConversationName, locate: locatePiSession }
} satisfies StructuredAdapter;
