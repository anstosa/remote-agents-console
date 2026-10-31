import { createElement, Fragment } from 'react';
import { createRoot } from 'react-dom/client';
import { PullRequestCard, PullRequestIndicators, type PullRequestSummary } from '../src/pull-request-card.js';

const pullRequests: PullRequestSummary[] = [
  { number: 7, title: 'Draft card', status: 'draft', url: 'https://github.com/octo/repo/pull/7', checks: 'passed' },
  { number: 8, title: 'Open card', status: 'open', url: 'https://github.com/octo/repo/pull/8', checks: 'failed', issues: { mergeConflicts: true, failingChecks: true, unresolvedComments: true } },
  { number: 9, title: 'Merged card', status: 'merged', url: 'https://github.com/octo/repo/pull/9', checks: 'pending' }
];

// render each pr's card beside the indicators the summary button shows for it
export const renderPullRequestCards = (root: HTMLElement) => {
  createRoot(root).render(createElement('div', {}, pullRequests.map(pullRequest => createElement(Fragment, { key: pullRequest.number },
    createElement(PullRequestCard, { pullRequest }),
    createElement(PullRequestIndicators, { checks: pullRequest.checks, issues: pullRequest.issues })
  ))));
};
