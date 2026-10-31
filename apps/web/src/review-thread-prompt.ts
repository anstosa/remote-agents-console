import type { PullRequestReviewThread } from './pull-request-comments.js';

// How picked Review threads read in a prompt: "Add N to prompt" and a configured prompt button's
// "+N" (GitHub panel) send the same text.

export const hunkLines = 10;

export const threadLines = (thread: PullRequestReviewThread): string => thread.line === undefined ? '' : thread.startLine === undefined ? `${thread.line}` : `${thread.startLine}-${thread.line}`;
export const quote = (text: string): string => text.split('\n').map(line => line === '' ? '>' : `> ${line}`).join('\n');
// a fence longer than any backtick run inside, so a hunk that itself holds ``` stays one block
const fence = (text: string): string => '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/gu)].map(match => match[0].length + 1)));

export function reviewThreadBlock(thread: PullRequestReviewThread): string {
  const lines = threadLines(thread);
  const hunk = thread.diffHunk.split('\n').slice(-hunkLines).join('\n');
  const marker = fence(hunk);
  const code = hunk.trim() === '' ? [] : [`${marker}diff`, hunk, marker, ''];
  return [`Review thread on ${thread.path}${lines === '' ? '' : `:${lines}`}${thread.outdated ? ' (outdated: the code has changed since)' : ''}`, thread.comments[0]!.url, '', ...code, thread.comments.map(comment => quote(`@${comment.author}: ${comment.body}`)).join('\n>\n')].join('\n');
}

// the prompt for one or more pieces of feedback on pull request `number`, numbered when several
export function feedbackPrompt(number: number, blocks: readonly string[]): string {
  const body = blocks.length === 1 ? blocks[0]! : blocks.map((block, index) => `${index + 1}. ${block.split('\n').map((line, at) => at === 0 || line === '' ? line : `   ${line}`).join('\n')}`).join('\n\n');
  return `Address this feedback on PR #${number}:\n\n${body}`;
}
