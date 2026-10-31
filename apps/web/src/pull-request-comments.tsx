export type PullRequestComment = { id: string; author: string; bot: boolean; mine?: true; body: string; createdAt: string; url: string };
export type PullRequestReviewThread = { id: string; path: string; line?: number; startLine?: number; resolved: boolean; outdated: boolean; diffHunk: string; comments: PullRequestComment[] };
export type PullRequestReviewSummary = PullRequestComment & { state: string };
export type PullRequestComments = { number: number; url: string; description?: PullRequestComment; threads: PullRequestReviewThread[]; reviews: PullRequestReviewSummary[]; comments: PullRequestComment[] };

export const unresolvedThreadCount = (comments: PullRequestComments): number => comments.threads.filter(thread => !thread.resolved && !thread.outdated).length;

export function hunkClass(line: string): string | undefined {
  if (line.startsWith('@@')) return 'hunk-header';
  if (line.startsWith('+')) return 'added';
  if (line.startsWith('-')) return 'removed';
  return undefined;
}
