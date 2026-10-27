import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { constants } from 'node:fs';
import { lstat, open, readlink, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { run, safeEnv } from '../tmux/command.js';
import { classifyReviewPath } from './change-classification.js';
import { maxInlineImageBytes, previewFileBytes, previewImageMediaType, WorkspaceFileService, type PreviewImage } from '../workspace-files/service.js';
import type { GitComparisonSummary, GitStatusChange, GitStatusSummary } from '../domain/models.js';

// One place for the git comparison pipeline: the base-candidate / merge-base ladder, the
// porcelain status + name-status + numstat sequence, the pure parsers, untracked-patch
// synthesis, per-file patch capture, a file-at-revision helper, and a content-sensitive
// Comparison fingerprint. Both the dashboard's change summaries (discovery) and the Review
// tour read from here; the base of a Comparison is always a parameter.

const git = '/usr/bin/git';
// preserve the public patch tail's existing character budget
const maxCapturedPatchCharacters = 1_000_000;
// git's canonical empty-tree object; the base of a Working Comparison with no HEAD yet
const emptyTree = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const conflictCodes = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

// hash a trusted value into a compact, stable token
export function digest(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

// ---- Pure parsers -------------------------------------------------------------------------

type GitLineStats = { additions: number; deletions: number };
function gitNumstat(output: string): Map<string, GitLineStats> {
  const stats = new Map<string, GitLineStats>();
  const records = output.split('\0');
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (!record) continue;
    const firstTab = record.indexOf('\t');
    const secondTab = record.indexOf('\t', firstTab + 1);
    if (firstTab < 0 || secondTab < 0) continue;
    const additions = Number(record.slice(0, firstTab));
    const deletions = Number(record.slice(firstTab + 1, secondTab));
    let path = record.slice(secondTab + 1);
    if (!path) {
      index += 1;
      path = records[++index] ?? '';
    }
    if (!path || !Number.isInteger(additions) || !Number.isInteger(deletions)) continue;
    const current = stats.get(path);
    stats.set(path, { additions: (current?.additions ?? 0) + additions, deletions: (current?.deletions ?? 0) + deletions });
  }
  return stats;
}

export function gitStatusSummary(output: string, numstatOutputs: string[] = []): GitStatusSummary {
  const changes: GitStatusChange[] = [];
  const nulDelimited = output.includes('\0');
  const records = output.split(nulDelimited ? '\0' : '\n');
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (record.length < 3) continue;
    const code = record.slice(0, 2);
    let path = record.slice(3);
    let originalPath: string | undefined;
    if (code[0] === 'R' || code[0] === 'C') {
      if (nulDelimited) originalPath = records[++index] || undefined;
      else {
        const separator = path.indexOf(' -> ');
        if (separator >= 0) {
          originalPath = path.slice(0, separator);
          path = path.slice(separator + 4);
        }
      }
    }
    changes.push({ code, path, ...(originalPath === undefined ? {} : { originalPath }), category: classifyReviewPath(path) });
  }
  const lineStats = numstatOutputs.reduce((combined, numstat) => {
    for (const [path, stats] of gitNumstat(numstat)) {
      const current = combined.get(path);
      combined.set(path, { additions: (current?.additions ?? 0) + stats.additions, deletions: (current?.deletions ?? 0) + stats.deletions });
    }
    return combined;
  }, new Map<string, GitLineStats>());
  for (const change of changes) Object.assign(change, lineStats.get(change.path));
  const summary: GitStatusSummary = { files: changes.length, staged: 0, unstaged: 0, untracked: 0, conflicted: 0, changes };
  for (const { code } of changes) {
    if (code === '??') { summary.untracked += 1; continue; }
    if (conflictCodes.has(code)) { summary.conflicted += 1; continue; }
    if (code[0] !== ' ') summary.staged += 1;
    if (code[1] !== ' ') summary.unstaged += 1;
  }
  return summary;
}

// summarize changes from a merge base
export function gitComparisonSummary(base: string, nameStatusOutput: string, numstatOutput: string, untrackedChanges: GitStatusChange[] = []): GitComparisonSummary {
  const changes: GitStatusChange[] = [];
  const nulDelimited = nameStatusOutput.includes('\0');
  const records = nameStatusOutput.split(nulDelimited ? '\0' : '\n');
  // parse name-status records
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    // skip empty records
    if (!record) continue;
    let status: string;
    let path: string;
    let originalPath: string | undefined;
    // parse nul-delimited output
    if (nulDelimited) {
      status = record;
      path = records[++index] ?? '';
      // preserve rename origins
      if (status[0] === 'R' || status[0] === 'C') {
        originalPath = path;
        path = records[++index] ?? '';
      }
    } else {
      const parts = record.split('\t');
      status = parts[0] ?? '';
      path = parts[1] ?? '';
      // preserve rename origins
      if (status[0] === 'R' || status[0] === 'C') {
        originalPath = path;
        path = parts[2] ?? '';
      }
    }
    // ignore malformed records
    if (!status || !path) continue;
    const code = status[0] === 'U' ? 'UU' : `${status[0]} `;
    changes.push({ code, path, ...(originalPath === undefined ? {} : { originalPath }), category: classifyReviewPath(path) });
  }
  const lineStats = gitNumstat(numstatOutput);
  // attach line totals
  for (const change of changes) Object.assign(change, lineStats.get(change.path));
  const trackedPaths = new Set(changes.map(change => change.path));
  // include current untracked files
  for (const change of untrackedChanges) {
    // avoid duplicate paths
    if (!trackedPaths.has(change.path)) changes.push({ ...change });
  }
  return { base, files: changes.length, changes };
}

export async function addUntrackedLineStats(workspace: string, summary: GitStatusSummary, limits = { files: 256, bytes: 20 * 1024 * 1024, bytesPerFile: 5 * 1024 * 1024 }) {
  let inspectedFiles = 0;
  let inspectedBytes = 0;
  for (const change of summary.changes ?? []) {
    if (change.code !== '??') continue;
    if (inspectedFiles >= limits.files || inspectedBytes >= limits.bytes) break;
    inspectedFiles += 1;
    try {
      const path = join(workspace, change.path);
      const info = await lstat(path);
      if (info.isSymbolicLink()) { change.additions = 1; change.deletions = 0; continue; }
      if (!info.isFile() || info.size > limits.bytesPerFile || inspectedBytes + info.size > limits.bytes) continue;
      inspectedBytes += info.size;
      const handle = await open(path, 'r');
      const content = Buffer.allocUnsafe(info.size);
      let offset = 0;
      try {
        while (offset < content.length) {
          const { bytesRead } = await handle.read(content, offset, content.length - offset, offset);
          if (bytesRead === 0) break;
          offset += bytesRead;
        }
      } finally { await handle.close(); }
      const inspected = content.subarray(0, offset);
      if (inspected.subarray(0, 8_000).includes(0)) continue;
      let lines = 0;
      for (const byte of inspected) if (byte === 10) lines += 1;
      change.additions = lines + (inspected.length > 0 && inspected[inspected.length - 1] !== 10 ? 1 : 0);
      change.deletions = 0;
    } catch { /* The worktree may change between status and file inspection. */ }
  }
}

// ---- Base-candidate / merge-base ladder ---------------------------------------------------

type BranchSource = { branch: string; local: boolean };
type ReflogRecord = { selector: string; sha: string; subject: string };
type GitRunner = typeof run;
const detachedHead = /^[0-9a-f]{7,64}$/u;

// parse bounded reflog records
function reflogRecords(output: string): ReflogRecord[] {
  return output.split('\n').flatMap(line => {
    const [selector, sha, subject] = line.split('\0');
    // ignore incomplete records
    if (selector === undefined || sha === undefined || subject === undefined) return [];
    return [{ selector, sha, subject }];
  });
}

// read one reflog selector timestamp
function reflogTime(selector: string): string | undefined {
  return selector.match(/@\{(\d+)\}$/u)?.[1];
}

// recognize remote prefixes without treating every slash as a remote
function isRemoteQualifiedBranch(branch: string, remotes: Set<string>): boolean {
  const separator = branch.indexOf('/');
  const prefix = branch.slice(0, separator);
  return separator >= 0 && (prefix === 'origin' || remotes.has(prefix));
}

// expand one branch without confusing slash names for remotes
function branchForms(branch: string | undefined, remotes: Set<string>, remoteFirst: boolean): string[] {
  const value = branch?.trim();
  // skip empty branch names
  if (value === undefined || value === '') return [];
  // preserve explicit local namespaces
  if (value.startsWith('refs/heads/')) {
    const remote = `origin/${value.slice('refs/heads/'.length)}`;
    return remoteFirst ? [remote, value] : [value, remote];
  }
  // preserve explicit remote namespaces
  if (value.startsWith('refs/remotes/')) {
    const qualified = value.slice('refs/remotes/'.length);
    const separator = qualified.indexOf('/');
    const local = separator < 0 ? qualified : `refs/heads/${qualified.slice(separator + 1)}`;
    return remoteFirst ? [value, local] : [local, value];
  }
  const localRef = value;
  const separator = localRef.indexOf('/');
  const qualified = isRemoteQualifiedBranch(localRef, remotes);
  const local = qualified ? localRef.slice(separator + 1) : localRef;
  const remote = qualified ? localRef : `origin/${local}`;
  return remoteFirst ? [remote, local] : [local, remote];
}

// resolve exact source refs while preserving operational failures
async function resolvedSource(workspace: string, source: string, current: string, remotes: Set<string>, command: GitRunner = run): Promise<BranchSource | null | undefined> {
  const value = source.trim();
  // reject symbolic and self sources
  if (value === '' || value === 'HEAD' || value === current) return undefined;
  // preserve explicit branch namespaces and their lookup outcomes
  if (value.startsWith('refs/heads/') || value.startsWith('refs/remotes/')) {
    const ref = await branchCandidateRef(workspace, value, command);
    return ref == null ? ref : { branch: value, local: value.startsWith('refs/heads/') };
  }
  const local = await branchCandidateRef(workspace, `refs/heads/${value}`, command);
  // a failed local lookup must not reinterpret the source as remote
  if (local === null) return null;
  // local creation names outrank same-shaped remote names
  if (local !== undefined) return { branch: value, local: true };
  // unresolved hexadecimal sources represent detached object ids
  if (detachedHead.test(value)) return undefined;
  // reject commit expressions and unknown qualifiers
  if (!isRemoteQualifiedBranch(value, remotes)) return undefined;
  const remote = await branchCandidateRef(workspace, `refs/remotes/${value}`, command);
  return remote == null ? remote : { branch: value, local: false };
}

// expand a proven source without reclassifying local slash names
function sourceForms(source: BranchSource, remotes: Set<string>): string[] {
  // keep remote sources remote-first
  if (!source.local) return branchForms(source.branch, remotes, true);
  // preserve explicit local refs
  if (source.branch.startsWith('refs/heads/')) return branchForms(source.branch, remotes, false);
  // disambiguate local names shaped like remote refs
  if (isRemoteQualifiedBranch(source.branch, remotes)) return [`refs/heads/${source.branch}`, `origin/${source.branch}`];
  return [source.branch, `origin/${source.branch}`];
}

// recover creation provenance without confusing missing refs with failed reads
async function creationSource(workspace: string, branch: string, remotes: Set<string>, command: GitRunner = run): Promise<BranchSource | null | undefined> {
  const ref = await branchCandidateRef(workspace, `refs/heads/${branch}`, command);
  // distinguish an absent current branch before reading its reflog
  if (ref == null) return ref;
  const reflog = await command(git, ['-C', workspace, 'reflog', 'show', '--date=unix', '--format=%gD%x00%H%x00%gs', `refs/heads/${branch}`]);
  // failed provenance reads must not select a lower-priority default
  if (reflog.code !== 0) return null;
  const created = reflogRecords(reflog.stdout).at(-1);
  // avoid later reflog events
  if (created === undefined || !created.subject.startsWith('branch: Created from ')) return undefined;
  const source = created.subject.slice('branch: Created from '.length);
  // resolve explicit creation names directly
  if (source !== 'HEAD') return await resolvedSource(workspace, source, branch, remotes, command);
  const createdAt = reflogTime(created.selector);
  // require a pairable creation time
  if (createdAt === undefined) return undefined;
  // exclude older history before the subprocess output cap can discard this checkout
  const head = await command(git, ['-C', workspace, 'reflog', 'show', `--since=@${createdAt}`, `--until=@${createdAt}`, '--date=unix', '--format=%gD%x00%H%x00%gs', 'HEAD']);
  // preserve failures while reading the linked worktree's HEAD reflog
  if (head.code !== 0) return null;
  const matching = reflogRecords(head.stdout).filter(record => {
    const checkout = record.subject.match(/^checkout: moving from (.+) to (.+)$/u);
    // pair only the exact creation checkout
    return record.sha === created.sha && reflogTime(record.selector) === createdAt && checkout?.[2] === branch;
  });
  // reject ambiguous same-second transitions
  if (matching.length !== 1) return undefined;
  const checkout = matching[0]!.subject.match(/^checkout: moving from (.+) to (.+)$/u);
  return checkout === null ? undefined : await resolvedSource(workspace, checkout[1]!, branch, remotes, command);
}

// build configured GitHub, PR, source, default, and main candidates in priority order
export async function prComparisonCandidates(workspace: string, branch: string | undefined, preferredBase?: string, defaultBranch?: string, command: GitRunner = run): Promise<string[]> {
  const [remoteOutput, configured] = await Promise.all([
    command(git, ['-C', workspace, 'remote']),
    branch === undefined ? Promise.resolve({ code: 1, stdout: '' }) : command(git, ['-C', workspace, 'config', '--get', `branch.${branch}.gh-merge-base`])
  ]);
  // only an absent setting may fall through after configuration lookup
  if (remoteOutput.code !== 0 || (configured.code !== 0 && configured.code !== 1)) return [];
  const remotes = new Set(remoteOutput.stdout.split('\n').filter(Boolean));
  const configuredBase = configured.code === 0 ? configured.stdout.trim() : undefined;
  const preferred = [...branchForms(configuredBase, remotes, true), ...branchForms(preferredBase, remotes, true)];
  const source = branch === undefined ? undefined : await creationSource(workspace, branch, remotes, command);
  // source failures block only lower priorities, not an already-known configured or PR base
  if (source === null) return [...new Set(preferred)];
  const sourceCandidates = source === undefined ? [] : sourceForms(source, remotes);
  return [...new Set([
    ...preferred,
    ...sourceCandidates,
    ...branchForms(defaultBranch, remotes, true),
    ...branchForms('main', remotes, true)
  ])];
}

// resolve exact branch namespaces; undefined is absent and null is an operational failure
async function branchCandidateRef(workspace: string, candidate: string, command: GitRunner = run): Promise<string | null | undefined> {
  let ref = candidate;
  // preserve the namespace of abbreviated remote candidates
  if (!candidate.startsWith('refs/')) {
    const remoteOutput = candidate.includes('/') && !candidate.startsWith('origin/') ? await command(git, ['-C', workspace, 'remote']) : undefined;
    // failed remote discovery must not reinterpret a branch namespace
    if (remoteOutput !== undefined && remoteOutput.code !== 0) return null;
    const remote = isRemoteQualifiedBranch(candidate, new Set(remoteOutput?.stdout.split('\n') ?? []));
    ref = `refs/${remote ? 'remotes' : 'heads'}/${candidate}`;
  }
  // reject tags and other nonbranch namespaces
  if (!ref.startsWith('refs/heads/') && !ref.startsWith('refs/remotes/')) return undefined;
  const exists = await command(git, ['-C', workspace, 'show-ref', '--verify', '--quiet', ref]);
  // only a missing ref allows another candidate
  if (exists.code === 1) return undefined;
  return exists.code === 0 ? ref : null;
}

// resolve the first existing, connected branch base while preserving operational failures
async function resolveComparisonBase(workspace: string, head: string, candidates: string[], command: GitRunner = run): Promise<{ base: string; gitBase: string } | undefined> {
  // inspect each distinct fallback in priority order
  for (const candidate of new Set(candidates)) {
    const candidateRef = await branchCandidateRef(workspace, candidate, command);
    // preserve unavailability after operational lookup failures
    if (candidateRef === null) return undefined;
    // skip missing or unsupported branch candidates
    if (candidateRef === undefined) continue;
    const mergeBase = await command(git, ['-C', workspace, 'merge-base', head, candidateRef]);
    // disconnected history may use the next candidate
    if (mergeBase.code === 1) continue;
    const gitBase = mergeBase.stdout.trim();
    // stop rather than substitute after an operational failure
    if (mergeBase.code !== 0 || gitBase === '') return undefined;
    return { base: candidate, gitBase };
  }
  return undefined;
}

// the checked-out branch (absent when detached), its saved All PR base — `branch.<b>.gh-merge-base`,
// which `gh` reads too — and the origin branches that base may name; undefined when listing fails
export async function mergeBaseChoices(workspace: string): Promise<{ branch?: string; configured?: string; branches: string[] } | undefined> {
  const [head, listed] = await Promise.all([
    run(git, ['-C', workspace, 'symbolic-ref', '--quiet', '--short', 'HEAD']),
    run(git, ['-C', workspace, 'for-each-ref', '--format=%(refname:lstrip=3)', 'refs/remotes/origin'])
  ]);
  if (listed.code !== 0) return undefined;
  const branches = listed.stdout.split('\n').filter(name => name !== '' && name !== 'HEAD');
  const branch = head.code === 0 ? head.stdout.trim() : '';
  if (branch === '') return { branches };
  const configured = await run(git, ['-C', workspace, 'config', '--get', `branch.${branch}.gh-merge-base`]);
  const value = configured.code === 0 ? configured.stdout.trim() : '';
  return { branch, ...(value === '' ? {} : { configured: value }), branches };
}

// save `base` as the checked-out branch's All PR base, or clear it with null. A named base must be
// an origin branch: the candidate ladder silently skips one that does not resolve.
export async function saveMergeBase(workspace: string, base: string | null): Promise<'saved' | 'detached' | 'unknown_base' | 'failed'> {
  const choices = await mergeBaseChoices(workspace);
  if (choices === undefined) return 'failed';
  if (choices.branch === undefined) return 'detached';
  const key = `branch.${choices.branch}.gh-merge-base`;
  if (base === null) {
    const unset = await run(git, ['-C', workspace, 'config', '--unset', key]);
    // 5: the key was not set
    return unset.code === 0 || unset.code === 5 ? 'saved' : 'failed';
  }
  if (!choices.branches.includes(base)) return 'unknown_base';
  return (await run(git, ['-C', workspace, 'config', key, base])).code === 0 ? 'saved' : 'failed';
}

// try each candidate base against HEAD; the first whose merge base resolves yields the
// comparison summary (its `base` is the candidate label) and the merge-base sha (`gitBase`)
export async function comparisonAgainst(workspace: string, candidates: string[], untracked: GitStatusChange[] = []): Promise<{ comparison: GitComparisonSummary; gitBase: string } | undefined> {
  const resolved = await resolveComparisonBase(workspace, 'HEAD', candidates);
  // require one usable base before reading the comparison
  if (resolved === undefined) return undefined;
  const [names, lines] = await Promise.all([
    run(git, ['--no-optional-locks', '-C', workspace, 'diff', '--name-status', '-z', '--find-renames', resolved.gitBase, '--']),
    run(git, ['--no-optional-locks', '-C', workspace, 'diff', '--numstat', '-z', resolved.gitBase, '--'])
  ]);
  // keep the resolved target authoritative when either comparison read fails
  if (names.code !== 0 || lines.code !== 0) return undefined;
  return { comparison: gitComparisonSummary(resolved.base, names.stdout, lines.stdout, untracked), gitBase: resolved.gitBase };
}

// ---- Commit log -----------------------------------------------------------------------------

// one commit an All PR Comparison spans: `pushed` when the branch's upstream already has it, and
// `changes` against its first parent (a merge commit lists none)
export type GitCommit = { sha: string; subject: string; body: string; author: string; authoredAt: string; merge: boolean; pushed: boolean; changes: GitStatusChange[] };
export type CommitLog = { base: string; commits: GitCommit[]; truncated: boolean };
export type BranchCommitSummary = { subject: string; count: number };
export const objectId = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

// cap every optional history subprocess at the remaining shared budget
function deadlineRunner(deadline: number, command: GitRunner = run): GitRunner {
  return async (binary, args, input, timeoutMs = 5_000) => {
    const remaining = deadline - Date.now();
    // avoid starting work after the caller's enrichment budget expires
    if (remaining <= 0) return { code: -1, stdout: '', stderr: 'branch summary deadline expired' };
    return await command(binary, args, input, Math.min(timeoutMs, remaining));
  };
}

// summarize the commits unique to one exact local branch using the standard comparison-base ladder
export async function branchCommitSummary(workspace: string, branch: string, defaultBranch?: string, deadline?: number): Promise<BranchCommitSummary | undefined> {
  const boundedRun = deadline === undefined ? run : deadlineRunner(deadline);
  // report abnormal git exits without warning for missing refs or an exhausted budget
  const command: GitRunner = async (binary, args, input, timeoutMs) => {
    const result = await boundedRun(binary, args, input, timeoutMs);
    const expectedAbsence = result.code === 1 && (args.includes('show-ref') || args.includes('config') || args.includes('merge-base'));
    const expired = result.code === -1 && deadline !== undefined && Date.now() >= deadline;
    // keep optional metadata failures visible while preserving expected absence
    if (result.code !== 0 && !expectedAbsence && !expired) {
      console.warn('[branch-summary] git history read failed', { workspace, branch, args, code: result.code, stderr: result.stderr });
    }
    return result;
  };
  const candidateRef = await branchCandidateRef(workspace, `refs/heads/${branch}`, command);
  // require the requested local branch rather than falling back to the checked-out HEAD
  if (candidateRef == null) return undefined;
  const resolvedTip = await command(git, ['-C', workspace, 'rev-parse', '--verify', `${candidateRef}^{commit}`]);
  const tip = resolvedTip.stdout.trim();
  // pin one concrete tip so the count and oldest-message lookup describe the same branch state
  if (resolvedTip.code !== 0 || !objectId.test(tip)) return undefined;
  const candidates = await prComparisonCandidates(workspace, branch, undefined, defaultBranch, command);
  const resolved = await resolveComparisonBase(workspace, tip, candidates, command);
  // retain object-id validation at the summary boundary
  if (resolved === undefined || !objectId.test(resolved.gitBase)) return undefined;
  const range = `${resolved.gitBase}..${tip}`;
  const counted = await command(git, ['-C', workspace, 'rev-list', '--count', range, '--']);
  const countText = counted.stdout.trim();
  // omit branches with no unique commits or unreadable counts
  if (counted.code !== 0 || !/^[1-9]\d*$/u.test(countText)) return undefined;
  const count = Number(countText);
  const oldest = await command(git, [
    '--no-optional-locks', '-C', workspace, 'log', '--topo-order', `--skip=${count - 1}`,
    '--max-count=1', '--format=%B', range, '--'
  ]);
  // use the literal first message line rather than git's paragraph-folded subject
  if (oldest.code !== 0) return undefined;
  return { subject: oldest.stdout.split(/\r?\n/u)[0] ?? '', count };
}

// parse `git log -z --format=%H%x00%P%x00%an%x00%aI%x00%s%x00%b`: six fields per commit
export function parseCommitLog(output: string) {
  const fields = output.split('\0');
  const entries: { sha: string; parents: string[]; author: string; authoredAt: string; subject: string; body: string }[] = [];
  for (let index = 0; index + 5 < fields.length; index += 6) {
    const [sha, parents, author, authoredAt, subject, body] = fields.slice(index, index + 6) as [string, string, string, string, string, string];
    entries.push({ sha: sha.trim(), parents: parents.split(' ').filter(Boolean), author, authoredAt, subject, body: body.trim() });
  }
  return entries;
}

// split `git log -z --format=%H` output carrying a name-status or numstat diff into each commit's
// records, NUL-joined so the Comparison parsers read them unchanged. A record always starts with a
// status (`M`, `R100`) or numstat (`3\t1\t…`) token, so a bare object id in that position is the
// next commit's header; the paths that follow are consumed by count, never inspected.
export function commitDiffRecords(output: string, format: 'name-status' | 'numstat'): Map<string, string> {
  const tokens = output.split('\0');
  const records = new Map<string, string[]>();
  let current: string[] | undefined;
  for (let index = 0; index < tokens.length; index += 1) {
    // the first record after a header is newline-prefixed
    const token = tokens[index]!.replace(/^\n/u, '');
    if (!token) continue;
    if (objectId.test(token)) { current = []; records.set(token, current); continue; }
    // a rename or copy carries its origin and destination paths
    const paths = format === 'name-status' ? (/^[RC]/u.test(token) ? 2 : 1) : (token.endsWith('\t') ? 2 : 0);
    current?.push(token, ...tokens.slice(index + 1, index + 1 + paths));
    index += paths;
  }
  return new Map([...records].map(([sha, record]) => [sha, record.join('\0')]));
}

// the commits between the All PR merge base (the first candidate that resolves) and HEAD, newest
// first, at most `limit` of them
export async function commitLog(workspace: string, candidates: string[], limit = 200): Promise<CommitLog | undefined> {
  const resolved = await resolveComparisonBase(workspace, 'HEAD', candidates);
  // require one usable base before reading commit metadata
  if (resolved === undefined) return undefined;
  const range = `${resolved.gitBase}..HEAD`;
  // read each bounded log projection consistently
  const log = (...args: string[]) => run(git, ['--no-optional-locks', '-C', workspace, 'log', '-z', `--max-count=${limit + 1}`, ...args, range, '--']);
  const [meta, names, lines, unpushed] = await Promise.all([
    log('--format=%H%x00%P%x00%an%x00%aI%x00%s%x00%b'),
    log('--format=%H', '--name-status', '--find-renames'),
    log('--format=%H', '--numstat', '--find-renames'),
    // fails without an upstream, which leaves every commit unpushed
    run(git, ['-C', workspace, 'rev-list', range, '^@{upstream}', '--'])
  ]);
  // require every mandatory log read
  if (meta.code !== 0 || names.code !== 0 || lines.code !== 0) return undefined;
  const nameRecords = commitDiffRecords(names.stdout, 'name-status');
  const lineRecords = commitDiffRecords(lines.stdout, 'numstat');
  const local = unpushed.code === 0 ? new Set(unpushed.stdout.split('\n')) : undefined;
  const entries = parseCommitLog(meta.stdout);
  // attach parsed change records to each visible commit
  const commits = entries.slice(0, limit).map(({ sha, parents, author, authoredAt, subject, body }) => ({
    sha, subject, body, author, authoredAt, merge: parents.length > 1, pushed: local !== undefined && !local.has(sha),
    changes: gitComparisonSummary(resolved.base, nameRecords.get(sha) ?? '', lineRecords.get(sha) ?? '').changes ?? []
  }));
  return { base: resolved.base, commits, truncated: entries.length > limit };
}

// ---- Working-tree status --------------------------------------------------------------------

// parse `git status --porcelain`; with `lineStats`, enrich additions/deletions from numstat
// (HEAD, falling back to the staged + unstaged passes when HEAD is unavailable)
export async function workingStatus(workspace: string, options: { lineStats?: boolean } = {}): Promise<GitStatusSummary | undefined> {
  if (options.lineStats !== true) {
    const status = await run(git, ['--no-optional-locks', '-C', workspace, 'status', '--porcelain=v1', '-z', '--untracked-files=all']);
    return status.code === 0 ? gitStatusSummary(status.stdout) : undefined;
  }
  const [status, diff] = await Promise.all([
    run(git, ['--no-optional-locks', '-C', workspace, 'status', '--porcelain=v1', '-z', '--untracked-files=all']),
    run(git, ['--no-optional-locks', '-C', workspace, 'diff', '--numstat', '-z', 'HEAD', '--'])
  ]);
  if (status.code !== 0) return undefined;
  let numstatOutputs = diff.code === 0 ? [diff.stdout] : [];
  if (diff.code !== 0) {
    const [staged, unstaged] = await Promise.all([
      run(git, ['--no-optional-locks', '-C', workspace, 'diff', '--cached', '--numstat', '-z', '--']),
      run(git, ['--no-optional-locks', '-C', workspace, 'diff', '--numstat', '-z', '--'])
    ]);
    numstatOutputs = [staged, unstaged].filter(result => result.code === 0).map(result => result.stdout);
  }
  return gitStatusSummary(status.stdout, numstatOutputs);
}

// resolve HEAD as a Working Comparison base; a repository with no commit compares the empty tree
export async function resolveHead(workspace: string): Promise<{ base: string; gitBase: string }> {
  const head = await run(git, ['-C', workspace, 'rev-parse', '--verify', 'HEAD']);
  return head.code === 0 ? { base: 'HEAD', gitBase: head.stdout.trim() } : { base: 'empty tree', gitBase: emptyTree };
}

// ---- Comparison resolution ------------------------------------------------------------------

export type ComparisonKind = 'working' | 'pr';
// a resolved Comparison: its base label, the diffable base ref, the working-tree status, and its
// Changes. A single-commit Comparison ends at `head` rather than the working tree, and has no status.
export type Comparison = { kind: ComparisonKind | 'commit'; base: string; gitBase: string; head?: string; status?: GitStatusSummary; changes: GitStatusChange[] };
export type ComparisonFailure = 'unavailable' | 'conflicted' | 'no_base';
export type ComparisonResult = { ok: true; comparison: Comparison } | { ok: false; reason: ComparisonFailure };

// resolve a Comparison's Changes. Working folds HEAD vs the working tree (staged and unstaged
// together, untracked included); All PR compares the merge base of HEAD and the first resolvable
// candidate. A conflicted working tree is refused before any base is chosen. `lineStats` enriches
// the Working Changes' additions/deletions (All PR always carries them) — set it when the caller
// fingerprints the Comparison, so an edit inside a capped file still moves the fingerprint.
export async function resolveComparison(workspace: string, kind: ComparisonKind, candidates: string[] = [], options: { lineStats?: boolean } = {}): Promise<ComparisonResult> {
  const status = await workingStatus(workspace, { lineStats: kind === 'working' && options.lineStats });
  if (status === undefined) return { ok: false, reason: 'unavailable' };
  if (status.conflicted > 0) return { ok: false, reason: 'conflicted' };
  if (kind === 'working') {
    const head = await resolveHead(workspace);
    return { ok: true, comparison: { kind, base: head.base, gitBase: head.gitBase, status, changes: status.changes ?? [] } };
  }
  const untracked = status.changes?.filter(change => change.code === '??') ?? [];
  const resolved = await comparisonAgainst(workspace, candidates, untracked);
  if (resolved === undefined) return { ok: false, reason: 'no_base' };
  return { ok: true, comparison: { kind, base: resolved.comparison.base, gitBase: resolved.gitBase, status, changes: resolved.comparison.changes ?? [] } };
}

// resolve one commit of HEAD's history against its first parent (a root commit compares the empty
// tree), so later commits and working-tree edits to the same files stay out. Only a full object id
// HEAD contains is accepted: the caller names the revision, so it must never reach git as an option.
export async function resolveCommitComparison(workspace: string, commit: string): Promise<ComparisonResult> {
  if (!objectId.test(commit)) return { ok: false, reason: 'unavailable' };
  const [contained, parents] = await Promise.all([
    run(git, ['-C', workspace, 'merge-base', '--is-ancestor', commit, 'HEAD']),
    run(git, ['-C', workspace, 'rev-list', '--parents', '--max-count=1', commit, '--'])
  ]);
  if (contained.code !== 0 || parents.code !== 0) return { ok: false, reason: 'unavailable' };
  const parent = parents.stdout.trim().split(' ')[1];
  const gitBase = parent ?? emptyTree;
  const [names, lines] = await Promise.all([
    run(git, ['--no-optional-locks', '-C', workspace, 'diff', '--name-status', '-z', '--find-renames', gitBase, commit, '--']),
    run(git, ['--no-optional-locks', '-C', workspace, 'diff', '--numstat', '-z', '--find-renames', gitBase, commit, '--'])
  ]);
  if (names.code !== 0 || lines.code !== 0) return { ok: false, reason: 'unavailable' };
  const base = parent === undefined ? 'empty tree' : `${commit.slice(0, 7)}^`;
  return { ok: true, comparison: { kind: 'commit', base, gitBase, head: commit, changes: gitComparisonSummary(base, names.stdout, lines.stdout).changes ?? [] } };
}

// ---- Per-file patch capture -----------------------------------------------------------------

export type UntrackedPatchKind = 'metadata' | 'binary' | 'untracked';
export type UntrackedPatch = { patch: string; kind: UntrackedPatchKind; fingerprint: string } | { tooLarge: true; fingerprint: string };

// identify one untracked metadata result without exposing its contents
const untrackedMetadata = (change: GitStatusChange, patch: string): UntrackedPatch => ({ patch, kind: 'metadata', fingerprint: digest(JSON.stringify(['untracked-metadata', change.code, change.path, patch])) });

// synthesise a bounded patch for one untracked path without following symlinks; returns
// `tooLarge` when the file exceeds `maxBytes`, and a metadata note for anything not a plain file
export async function synthesizeUntrackedPatch(workspace: string, change: GitStatusChange, maxBytes: number): Promise<UntrackedPatch> {
  const path = join(workspace, change.path);
  const info = await lstat(path).catch(() => undefined);
  // reject disappearing or unsupported paths
  if (info === undefined) return untrackedMetadata(change, `untracked file ${change.path} disappeared`);
  // represent symlinks without following them
  if (info.isSymbolicLink()) {
    const target = await readlink(path).catch(() => 'unavailable');
    return untrackedMetadata(change, `new symlink ${change.path} -> ${target}`);
  }
  // represent non-files as metadata
  if (!info.isFile()) return untrackedMetadata(change, `untracked non-file ${change.path}`);
  const root = await realpath(workspace).catch(() => undefined);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => undefined);
  // reject files replaced during inspection
  if (root === undefined || handle === undefined) return untrackedMetadata(change, `untracked file ${change.path} disappeared`);
  let content: Buffer;
  try {
    const [opened, openedInfo] = await Promise.all([realpath(`/proc/self/fd/${handle.fd}`).catch(() => undefined), handle.stat({ bigint: true })]);
    const local = opened === undefined ? undefined : relative(root, opened);
    // bind containment and size checks to the opened descriptor
    if (opened === undefined || local === undefined || !local || local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local) || !openedInfo.isFile()) return untrackedMetadata(change, `untracked file ${change.path} changed during capture`);
    const statFingerprint = digest(JSON.stringify(['untracked-stat', change.code, change.path, openedInfo.dev.toString(), openedInfo.ino.toString(), openedInfo.size.toString(), openedInfo.mtimeNs.toString(), openedInfo.ctimeNs.toString()]));
    // fingerprint oversized files from opened-descriptor metadata only
    if (openedInfo.size > BigInt(maxBytes)) return { tooLarge: true, fingerprint: statFingerprint };
    const bounded = Buffer.alloc(maxBytes + 1);
    const read = await handle.read(bounded, 0, bounded.length, 0);
    // reject files that grew beyond the validated limit
    if (read.bytesRead > maxBytes) return { tooLarge: true, fingerprint: statFingerprint };
    content = bounded.subarray(0, read.bytesRead);
  } finally { await handle.close(); }
  const fingerprint = digest(JSON.stringify(['untracked-content', change.code, change.path, digest(content.toString('base64'))]));
  // represent binary data without exposing bytes
  if (content.subarray(0, 8_000).includes(0)) return { patch: `new binary file ${change.path} (${content.length} bytes)`, kind: 'binary', fingerprint };
  const text = content.toString('utf8');
  const lines = text === '' ? [] : text.split('\n');
  const additions = lines.length - (text.endsWith('\n') ? 1 : 0);
  const body = lines.slice(0, additions).map(line => `+${line}`).join('\n');
  return { patch: `--- /dev/null\n+++ b/${change.path}\n@@ -0,0 +1,${additions} @@\n${body}${body === '' ? '' : '\n'}`, kind: 'untracked', fingerprint };
}

// capture the unified patch for one tracked Change from `base` to `head` (default: the working
// tree); `ok: false` means git failed
export async function capturePatch(workspace: string, base: string, change: GitStatusChange, head?: string): Promise<{ ok: true; patch: string } | { ok: false }> {
  const captured = await captureTrackedPatch(workspace, base, change, head);
  return captured.ok ? { ok: true, patch: captured.patch } : { ok: false };
}

// retain the bounded public patch while hashing every stdout byte for revision identity
async function captureTrackedPatch(workspace: string, base: string, change: GitStatusChange, head?: string): Promise<{ ok: true; patch: string; streamFingerprint: string } | { ok: false }> {
  const paths = [change.originalPath, change.path].filter((path): path is string => path !== undefined);
  // force the standard a/ b/ path prefixes so the patch parses regardless of the user's git config:
  // diff.mnemonicPrefix (c/ w/ i/ …), diff.noprefix, and custom diff.srcPrefix/dstPrefix would
  // otherwise flow into the header, and @pierre/diffs' parser rejects a non-a/b header ("invalid git
  // diff header") — leaving the diff nameless, which breaks file-at-revision loads (full context,
  // Load anyway) and the Review tour. explicit --src-prefix/--dst-prefix override every prefix config.
  const args = ['--no-optional-locks', '-C', workspace, 'diff', '--binary', '--no-ext-diff', '--no-color', '--src-prefix=a/', '--dst-prefix=b/', '--unified=3', '--find-renames', base, ...(head === undefined ? [] : [head]), '--', ...paths];
  return new Promise(resolve => {
    const child = spawn(git, args, { shell: false, env: safeEnv(), stdio: ['ignore', 'pipe', 'ignore'] });
    const fingerprint = createHash('sha256');
    const decoder = new StringDecoder('utf8');
    let patch = '';
    let failed = false;
    // preserve the existing command deadline without accepting a killed stream as complete
    const timer = setTimeout(() => { failed = true; child.kill('SIGKILL'); }, 20_000);
    // hash raw bytes independently of the bounded utf-8 text tail
    child.stdout.on('data', (chunk: Buffer) => {
      fingerprint.update(chunk);
      patch = (patch + decoder.write(chunk)).slice(-maxCapturedPatchCharacters);
    });
    // spawn failures cannot produce a valid revision identity
    child.on('error', () => { failed = true; });
    // finalize only after all process output has arrived
    child.on('close', code => {
      clearTimeout(timer);
      // preserve the public failure outcome for errors and deadline kills
      if (failed || code !== 0) { resolve({ ok: false }); return; }
      patch = (patch + decoder.end()).slice(-maxCapturedPatchCharacters);
      resolve({ ok: true, patch: patch || `${change.code.trim() || 'metadata'} ${change.originalPath === undefined ? change.path : `${change.originalPath} -> ${change.path}`}`, streamFingerprint: fingerprint.digest('base64url') });
    });
  });
}

// ---- Comparison patch (all files) + fingerprint --------------------------------------------

export type ComparisonFileKind = 'tracked' | UntrackedPatchKind;
export type ComparisonFile = { change: GitStatusChange; kind: ComparisonFileKind; patch: string; capped: boolean; fingerprint: string };
export type ComparisonPatch = { base: string; gitBase: string; files: ComparisonFile[]; fingerprint: string; truncated: boolean };
export type PatchLimits = { perFileBytes: number; totalBytes: number; maxFiles: number };

// capture per-file patches for every Change in a Comparison, honouring per-file, total, and
// file-count caps (a file past the per-file or running-total cap is marked `capped` with its patch
// withheld for lazy loading; reaching the file-count cap stops capture and marks the result
// truncated), and derive a deterministic, content-sensitive fingerprint over the base, the
// captured patches, and each Change's line counts
export async function captureComparisonPatch(workspace: string, comparison: Comparison, limits: PatchLimits): Promise<ComparisonPatch> {
  const files: ComparisonFile[] = [];
  let total = 0;
  let truncated = false;
  for (const change of comparison.changes) {
    // bound the number of captured Changes, not only their bytes
    if (files.length >= limits.maxFiles) { truncated = true; break; }
    let kind: ComparisonFileKind;
    let patch: string;
    let fingerprint: string;
    if (change.code === '??') {
      const synth = await synthesizeUntrackedPatch(workspace, change, limits.perFileBytes);
      // a file past the per-file cap is withheld without reading it whole
      if ('tooLarge' in synth) { files.push({ change, kind: 'untracked', patch: '', capped: true, fingerprint: synth.fingerprint }); continue; }
      kind = synth.kind;
      patch = synth.patch;
      fingerprint = synth.fingerprint;
    } else {
      const captured = await captureTrackedPatch(workspace, comparison.gitBase, change, comparison.head);
      // an unavailable per-file diff is surfaced as an empty entry rather than failing the whole Comparison
      kind = 'tracked';
      patch = captured.ok ? captured.patch : '';
      fingerprint = digest(JSON.stringify(['tracked', comparison.gitBase, comparison.head ?? null, change.code, change.path, change.originalPath ?? null, captured.ok ? captured.streamFingerprint : null]));
    }
    const bytes = Buffer.byteLength(patch);
    // withhold a patch that breaches either the per-file or the running-total cap
    if (bytes > limits.perFileBytes || total + bytes > limits.totalBytes) {
      if (total + bytes > limits.totalBytes) truncated = true;
      files.push({ change, kind, patch: '', capped: true, fingerprint });
      continue;
    }
    total += bytes;
    files.push({ change, kind, patch, capped: false, fingerprint });
  }
  // fold each per-file content token and line count into the aggregate fingerprint
  const fingerprint = digest(JSON.stringify([comparison.base, comparison.gitBase, files.map(file => [file.change.code, file.change.path, file.change.originalPath ?? null, file.change.additions ?? null, file.change.deletions ?? null, file.capped, file.patch, file.fingerprint])]));
  return { base: comparison.base, gitBase: comparison.gitBase, files, fingerprint, truncated };
}

// ---- File at a revision ---------------------------------------------------------------------

// whole enough to expand a large source file's unchanged lines in a diff
const maxRevisionBytes = 2 * 1024 * 1024;
export type RevisionFile = { path: string; size: number; binary: boolean; truncated: boolean; content?: string; image?: PreviewImage };
// which side of a Comparison to read a file from: a committed revision, or the live working tree
export type FileRevision = { commit: string } | { workingTree: true };

// read git's `show` output for one blob, collecting at most `maxBytes` before stopping; resolves
// undefined when the object is absent (git exits non-zero having produced nothing)
function gitShowBounded(workspace: string, object: string, maxBytes: number): Promise<Buffer | undefined> {
  return new Promise(resolve => {
    const child = spawn(git, ['--no-optional-locks', '-C', workspace, 'show', object], { shell: false, env: safeEnv(), stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    let total = 0;
    let failed = false;
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    // retain only bytes inside the requested allocation bound
    child.stdout.on('data', (chunk: Buffer) => {
      const remaining = maxBytes - total;
      // ignore queued output after the process has been stopped
      if (remaining <= 0) return;
      const bounded = chunk.subarray(0, remaining);
      chunks.push(bounded);
      total += bounded.length;
      // stop reading once the cap is reached; the close handler keeps what was collected
      if (total >= maxBytes) child.kill('SIGKILL');
    });
    child.on('error', () => { failed = true; });
    child.on('close', code => {
      clearTimeout(timer);
      // a genuine miss exits non-zero with no output; a capped read exits non-zero with bytes in hand
      if (failed || (code !== 0 && chunks.length === 0)) resolve(undefined);
      else resolve(Buffer.concat(chunks));
    });
  });
}

// read revisions securely with a 2 MiB text cap and a 5 MiB complete-raster cap
// return undefined when the path is absent
export async function fileAtRevision(workspace: string, revision: FileRevision, path: string): Promise<RevisionFile | undefined> {
  // a NUL in the path makes spawn throw; treat it as absent, matching the working-tree branch
  if (path.includes('\0')) return undefined;
  if ('workingTree' in revision) {
    const preview = await new WorkspaceFileService().preview(workspace, path, maxRevisionBytes);
    if (preview === undefined) return undefined;
    return { path: preview.path, size: preview.size, binary: preview.binary, truncated: preview.truncated, ...(preview.content === undefined ? {} : { content: preview.content }), ...(preview.image === undefined ? {} : { image: preview.image }) };
  }
  // refuse a revision git would read as an option (e.g. `--output=…`, an arbitrary-file-write
  // primitive) or that would corrupt the `<rev>:<path>` object spec; a real ref/sha has none of these
  if (revision.commit === '' || revision.commit.startsWith('-') || /[\0:]/u.test(revision.commit)) return undefined;
  const object = `${revision.commit}:${path}`;
  const [type, size] = await Promise.all([
    run(git, ['-C', workspace, 'cat-file', '-t', object]),
    run(git, ['-C', workspace, 'cat-file', '-s', object])
  ]);
  // require a regular file: a missing path fails, and a directory resolves to a tree object we must not read as text
  if (type.code !== 0 || type.stdout.trim() !== 'blob' || size.code !== 0) return undefined;
  const total = Number(size.stdout.trim());
  if (!Number.isInteger(total) || total < 0) return undefined;
  // sniff blobs above the text cap before choosing the bounded body read
  const header = total > maxRevisionBytes ? await gitShowBounded(workspace, object, 12) : undefined;
  const image = header === undefined ? false : previewImageMediaType(header) !== undefined;
  // return oversized supported images as metadata without reading their bodies
  if (image && total > maxInlineImageBytes) return { path, size: total, binary: true, truncated: false };
  const readLimit = image ? maxInlineImageBytes : maxRevisionBytes;
  const bytes = await gitShowBounded(workspace, object, readLimit);
  if (bytes === undefined) return undefined;
  const content = bytes.subarray(0, Math.min(bytes.length, readLimit, total));
  const preview = previewFileBytes(path, content, maxRevisionBytes, total);
  return { path: preview.path, size: preview.size, binary: preview.binary, truncated: preview.truncated, ...(preview.content === undefined ? {} : { content: preview.content }), ...(preview.image === undefined ? {} : { image: preview.image }) };
}
