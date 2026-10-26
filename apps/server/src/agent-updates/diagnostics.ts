import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { agentKinds, type AgentKind } from '../adapters/types.js';
import { writePrivate } from '../settings/files.js';

export type AgentUpdateFailureReason =
  | 'command_failed'
  | 'launch_failed'
  | 'timed_out'
  | 'bridge_unavailable'
  | 'invalid_completion'
  | 'interrupted';

export const maxAgentUpdateOutputBytes = 16 * 1024;

const retainedFailureReports = 32;
const failureReportName = new RegExp(`^(?:${agentKinds.join('|')})-[a-f0-9]{24}\\.json$`, 'u');

type AgentUpdateFailure = {
  kind: AgentKind;
  code: number;
  output: string;
  reason: AgentUpdateFailureReason;
};

type FailureReport = {
  version: 1;
  id: string;
  kind: AgentKind;
  recordedAt: string;
  reason: AgentUpdateFailureReason;
  exitCode?: number;
  output: string;
};

// preserve one valid utf8 tail
function boundedOutput(output: string): string {
  const bytes = Buffer.from(output, 'utf8');
  // retain already bounded output
  if (bytes.length <= maxAgentUpdateOutputBytes) return output;
  let start = bytes.length - maxAgentUpdateOutputBytes;
  // skip a partial leading character
  while ((bytes[start]! & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString('utf8');
}

// require one owner-only report directory
async function diagnosticsDirectory(checkout: string): Promise<string> {
  const dataDirectory = join(checkout, '.data');
  const directory = join(dataDirectory, 'agent-updates');
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const dataDetails = await lstat(dataDirectory);
  // reject linked storage roots
  if (!dataDetails.isDirectory() || dataDetails.isSymbolicLink()) throw new Error('invalid private diagnostics directory');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const details = await lstat(directory);
  const owner = process.getuid?.();
  // reject linked or exposed storage
  if (!details.isDirectory() || details.isSymbolicLink() || (details.mode & 0o077) !== 0 || owner !== undefined && details.uid !== owner) {
    throw new Error('invalid private diagnostics directory');
  }
  return directory;
}

// prune only recognized failure reports
async function pruneFailureReports(directory: string, current: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  const reports = await Promise.all(entries
    .filter(entry => entry.isFile() && failureReportName.test(entry.name))
    .map(async entry => ({ name: entry.name, modifiedAt: (await lstat(join(directory, entry.name))).mtimeMs })));
  const removable = reports
    .filter(report => report.name !== current)
    .sort((left, right) => right.modifiedAt - left.modifiedAt || right.name.localeCompare(left.name))
    .slice(retainedFailureReports - 1);
  await Promise.all(removable.map(report => unlink(join(directory, report.name))));
}

// persist one private update failure
export async function saveAgentUpdateFailure(checkout: string, failure: AgentUpdateFailure): Promise<string> {
  const directory = await diagnosticsDirectory(checkout);
  const id = randomBytes(12).toString('hex');
  const filename = `${failure.kind}-${id}.json`;
  const validExitCode = Number.isInteger(failure.code) && failure.code >= 0 && failure.code <= 255;
  const report: FailureReport = {
    version: 1,
    id,
    kind: failure.kind,
    recordedAt: new Date().toISOString(),
    reason: failure.reason,
    ...(validExitCode ? { exitCode: failure.code } : {}),
    output: boundedOutput(failure.output)
  };
  await writePrivate(join(directory, filename), `${JSON.stringify(report)}\n`);
  await pruneFailureReports(directory, filename);
  return `.data/agent-updates/${filename}`;
}
