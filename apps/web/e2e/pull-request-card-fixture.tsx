import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { PullRequestCard, type PullRequestSummary } from '../src/pull-request-card.js';

const pullRequests: PullRequestSummary[] = [
  { number: 7, title: 'Draft card', status: 'draft', url: 'https://github.com/octo/repo/pull/7', checks: 'passed' },
  { number: 8, title: 'Open card with a complete title that stays available while the visible label truncates', status: 'open', url: 'https://github.com/octo/repo/pull/8', checks: 'failed', issues: { mergeConflicts: true, failingChecks: true, unresolvedComments: true } },
  { number: 9, title: 'Merged card', status: 'merged', url: 'https://github.com/octo/repo/pull/9', checks: 'pending' }
];

// render each card with its own status indicators
export const renderPullRequestCards = (root: HTMLElement) => {
  createRoot(root).render(createElement('div', {}, pullRequests.map(pullRequest => /* retain card identity */ createElement(PullRequestCard, { key: pullRequest.number, pullRequest }))));
};
