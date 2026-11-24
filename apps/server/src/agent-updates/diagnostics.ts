import { randomBytes } from 'node:crypto';
import { lstat, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { valid } from 'semver';
import { agentKinds, type AgentKind } from '../adapters/types.js';
import { writePrivate } from '../settings/files.js';
import { agentUpdateDirectory } from './storage.js';

const agentUpdateFailureReasons = [
  'command_failed',
  'launch_failed',
  'timed_out',
  'bridge_unavailable',
  'invalid_completion',
  'interrupted',
  'installer_busy',
  'installed_completion_unconfirmed',
  'installed_setup_failed',
  'version_check_failed',
  'verification_failed',
  'target_not_installed'
] as const;
const agentUpdateFailurePhases = ['preflight', 'install', 'verification'] as const;

export type AgentUpdateFailureReason = typeof agentUpdateFailureReasons[number];
type AgentUpdateFailurePhase = typeof agentUpdateFailurePhases[number];

export const maxAgentUpdateOutputBytes = 16 * 1024;

const retainedFailureReports = 32;
const failureReportName = new RegExp(`^(?:${agentKinds.join('|')})-[a-f0-9]{24}\\.json$`, 'u');

export type AgentUpdateFailure = {
  kind: AgentKind;
  code: number;
  output: string;
  reason: AgentUpdateFailureReason;
  jobId?: string;
  phase?: AgentUpdateFailurePhase;
  elapsedMs?: number;
  previousVersion?: string;
  targetVersion?: string;
  observedVersion?: string;
  installerFailure?: AgentUpdateFailureReason;
  probeFailure?: AgentUpdateFailureReason;
};

type FailureReport = {
  version: 1;
  id: string;
  kind: AgentKind;
  recordedAt: string;
  reason: AgentUpdateFailureReason;
  exitCode?: number;
  jobId?: string;
  phase?: AgentUpdateFailurePhase;
  elapsedMs?: number;
  previousVersion?: string;
  targetVersion?: string;
  observedVersion?: string;
  installerFailure?: AgentUpdateFailureReason;
  probeFailure?: AgentUpdateFailureReason;
  output: string;
};

const jobIdPattern = /^[a-f0-9]{24}$/u;
const maximumElapsedMs = 24 * 60 * 60_000;
const failurePhases = new Set<string>(agentUpdateFailurePhases);
const failureReasons = new Set<string>(agentUpdateFailureReasons);

// retain only one valid durable job identity
function validJobId(value: string | undefined): string | undefined {
  return value !== undefined && jobIdPattern.test(value) ? value : undefined;
}

// retain only a bounded lifecycle duration
function validElapsedMs(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 && value <= maximumElapsedMs ? value : undefined;
}

// retain only one known lifecycle phase
function validPhase(value: AgentUpdateFailurePhase | undefined): AgentUpdateFailurePhase | undefined {
  return value !== undefined && failurePhases.has(value) ? value : undefined;
}

// retain only one known originating installer failure
function validFailureReason(value: AgentUpdateFailureReason | undefined): AgentUpdateFailureReason | undefined {
  return value !== undefined && failureReasons.has(value) ? value : undefined;
}

// retain only a bounded semantic version
function validVersion(value: string | undefined): string | undefined {
  return value !== undefined && value.length <= 120 && valid(value) !== null ? value : undefined;
}

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
  const directory = await agentUpdateDirectory(checkout);
  // creation always returns the validated update directory
  if (directory === undefined) throw new Error('private agent update directory unavailable');
  const id = randomBytes(12).toString('hex');
  const filename = `${failure.kind}-${id}.json`;
  const validExitCode = Number.isInteger(failure.code) && failure.code >= 0 && failure.code <= 255;
  const jobId = validJobId(failure.jobId);
  const phase = validPhase(failure.phase);
  const elapsedMs = validElapsedMs(failure.elapsedMs);
  const previousVersion = validVersion(failure.previousVersion);
  const targetVersion = validVersion(failure.targetVersion);
  const observedVersion = validVersion(failure.observedVersion);
  const installerFailure = validFailureReason(failure.installerFailure);
  const probeFailure = validFailureReason(failure.probeFailure);
  const report: FailureReport = {
    version: 1,
    id,
    kind: failure.kind,
    recordedAt: new Date().toISOString(),
    reason: failure.reason,
    ...(validExitCode ? { exitCode: failure.code } : {}),
    ...(jobId === undefined ? {} : { jobId }),
    ...(phase === undefined ? {} : { phase }),
    ...(elapsedMs === undefined ? {} : { elapsedMs }),
    ...(previousVersion === undefined ? {} : { previousVersion }),
    ...(targetVersion === undefined ? {} : { targetVersion }),
    ...(observedVersion === undefined ? {} : { observedVersion }),
    ...(installerFailure === undefined ? {} : { installerFailure }),
    ...(probeFailure === undefined ? {} : { probeFailure }),
    output: boundedOutput(failure.output)
  };
  await writePrivate(join(directory, filename), `${JSON.stringify(report)}\n`);
  await pruneFailureReports(directory, filename);
  return `.data/agent-updates/${filename}`;
}
