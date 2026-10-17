import { classifyReviewPath } from '../git/change-classification.js';
import { capturePatch, digest, resolveCommitComparison, resolveComparison, synthesizeUntrackedPatch } from '../git/comparison.js';
import type { ComparisonKind } from '../git/comparison.js';
import type { GitStatusChange } from '../domain/models.js';
import type { ResolvedWorkspace } from '../workspaces/resolver.js';
import { MAX_REVIEW_CHANGES, MAX_REVIEW_DIFF_BYTES, MAX_REVIEW_FILES, MAX_REVIEW_FILE_BYTES, ReviewTourError, type ReviewChange, type ReviewChangeKind, type ReviewComparison, type ReviewTourInput } from './contracts.js';

// split one file patch into trusted atomic units
function atomicPatches(patch: string, fallbackKind: ReviewChangeKind): Array<{ patch: string; kind: ReviewChangeKind; oldStart?: number; oldLines?: number; newStart?: number; newLines?: number }> {
  const lines = patch.split('\n');
  const hunks: Array<{ index: number; oldStart: number; oldLines: number; newStart: number; newLines: number }> = [];
  // find unified hunk headers
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(lines[index]!);
    // collect valid ranges
    if (match !== null) hunks.push({ index, oldStart: Number(match[1]), oldLines: Number(match[2] ?? 1), newStart: Number(match[3]), newLines: Number(match[4] ?? 1) });
  }
  // retain metadata-only changes
  if (hunks.length === 0) return [{ patch, kind: fallbackKind }];
  const header = lines.slice(0, hunks[0]!.index).join('\n');
  // attach the shared file header to each hunk
  return hunks.map((hunk, index) => {
    const end = hunks[index + 1]?.index ?? lines.length;
    const body = lines.slice(hunk.index, end).join('\n');
    return { patch: `${header}\n${body}`, kind: 'hunk' as const, oldStart: hunk.oldStart, oldLines: hunk.oldLines, newStart: hunk.newStart, newLines: hunk.newLines };
  });
}

// resolve a fresh comparison summary through the shared git comparison module
async function comparison(resolved: ResolvedWorkspace, input: ReviewTourInput): Promise<{ base: string; gitBase: string; head?: string; changes: GitStatusChange[] }> {
  const kind: ComparisonKind = input.scope === 'working' ? 'working' : 'pr';
  // the dashboard's resolved merge target is the only PR base; a working snapshot needs none
  const preferred = resolved.agent.gitPrStatus?.base;
  const candidates = kind === 'pr' && preferred !== undefined ? [preferred] : [];
  const result = input.scope === 'commit' ? await resolveCommitComparison(resolved.workspace, input.commit ?? '') : await resolveComparison(resolved.workspace, kind, candidates);
  // map the module's failure reasons onto the tour's typed errors
  if (!result.ok) throw new ReviewTourError(result.reason === 'conflicted' ? 'conflicted_unavailable' : 'scope_unavailable', true);
  return { base: result.comparison.base, gitBase: result.comparison.gitBase, ...(result.comparison.head === undefined ? {} : { head: result.comparison.head }), changes: result.comparison.changes };
}

// capture a canonical review Comparison
export async function captureReviewComparison(resolved: ResolvedWorkspace, input: ReviewTourInput): Promise<ReviewComparison> {
  const current = await comparison(resolved, input);
  const selected = current.changes.filter(change => {
    const category = classifyReviewPath(change.path);
    // apply independent support filters
    return category === 'implementation' || category === 'test' && input.includeTests || category === 'doc' && input.includeDocs;
  });
  // enforce selected file limits
  if (selected.length > MAX_REVIEW_FILES) throw new ReviewTourError('too_large', false);
  const changes: ReviewChange[] = [];
  let bytes = 0;
  // capture every selected file
  for (const change of selected) {
    const category = classifyReviewPath(change.path);
    let captured: { patch: string; kind: ReviewChangeKind };
    if (change.code === '??') {
      const synth = await synthesizeUntrackedPatch(resolved.workspace, change, MAX_REVIEW_FILE_BYTES);
      // reject untracked files past the stored change limit
      if ('tooLarge' in synth) throw new ReviewTourError('too_large', false);
      captured = synth;
    } else {
      const tracked = await capturePatch(resolved.workspace, current.gitBase, change, current.head);
      // surface git failures as unavailable scope
      if (!tracked.ok) throw new ReviewTourError('scope_unavailable', true);
      captured = { patch: tracked.patch, kind: change.code.trim().startsWith('R') ? 'rename' : 'metadata' };
    }
    const units = atomicPatches(captured.patch, captured.kind);
    // capture every atomic unit
    for (const unit of units) {
      const unitBytes = Buffer.byteLength(unit.patch);
      // enforce the stored change limit after hunk splitting
      if (unitBytes > MAX_REVIEW_FILE_BYTES) throw new ReviewTourError('too_large', false);
      bytes += unitBytes;
      // enforce aggregate limits
      if (bytes > MAX_REVIEW_DIFF_BYTES || changes.length >= MAX_REVIEW_CHANGES) throw new ReviewTourError('too_large', false);
      const key = JSON.stringify([change.path, change.originalPath, category, unit.kind, unit.patch]);
      changes.push({ id: `chg_${digest(key).slice(0, 28)}`, file: change.path, ...(change.originalPath === undefined ? {} : { originalFile: change.originalPath }), category, kind: unit.kind, ...(unit.oldStart === undefined ? {} : { oldStart: unit.oldStart, oldLines: unit.oldLines, newStart: unit.newStart, newLines: unit.newLines }), patch: unit.patch });
    }
  }
  const fingerprint = digest(JSON.stringify({ scope: input.scope, commit: input.commit, base: current.base, gitBase: current.gitBase, includeTests: input.includeTests, includeDocs: input.includeDocs, changes }));
  return { agentId: resolved.agent.id, worktreeId: resolved.worktree.id, workspace: resolved.workspace, ...(resolved.agent.branch === undefined ? {} : { branch: resolved.agent.branch }), scope: input.scope, ...(input.commit === undefined ? {} : { commit: input.commit }), base: current.base, includeTests: input.includeTests, includeDocs: input.includeDocs, fingerprint, changes };
}
