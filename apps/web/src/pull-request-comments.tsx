export type PullRequestComment = { id: string; author: string; bot: boolean; mine?: true; body: string; createdAt: string; url: string };
// the server's PullRequestReviewThread (domain/models.ts)
export type PullRequestReviewThread = { id: string; path: string; line?: number; startLine?: number; leftSide?: true; pending?: true; resolved: boolean; resolvedBy?: { login: string; mine?: true }; outdated: boolean; diffHunk: string; comments: PullRequestComment[] };
// a comment as GitHub shows it: without the HTML comments, such as Post to PR's markers, it hides
export const shownBody = (body: string): string => body.replace(/<!--[\s\S]*?-->/gu, '').trim();
export type PullRequestReviewSummary = PullRequestComment & { state: string };
export type PullRequestComments = { number: number; url: string; description?: PullRequestComment; threads: PullRequestReviewThread[]; reviews: PullRequestReviewSummary[]; comments: PullRequestComment[] };

export const unresolvedThreadCount = (comments: PullRequestComments): number => comments.threads.filter(thread => !thread.resolved && !thread.outdated).length;

export function hunkClass(line: string): string | undefined {
  if (line.startsWith('@@')) return 'hunk-header';
  if (line.startsWith('+')) return 'added';
  if (line.startsWith('-')) return 'removed';
  return undefined;
}
