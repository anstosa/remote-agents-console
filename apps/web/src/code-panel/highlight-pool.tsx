import { preloadHighlighter } from '@pierre/diffs';
import { WorkerPoolContextProvider } from '@pierre/diffs/react';
import type { ReactNode } from 'react';
import { codeTheme } from './items.js';

// Highlights tokenizes a 12k-line TSX file in ~35 ms where shiki-js took ~16 s, so a file expanded
// to its full length stays highlighted under the library's default line cap. It runs in a worker
// because the page may not compile WebAssembly. One worker is plenty at that speed.
const poolOptions = { workerFactory: () => new Worker(new URL('./diff-highlight-worker.ts', import.meta.url), { type: 'module' }), poolSize: 1 };
const highlighterOptions = { theme: codeTheme, preferredHighlighter: 'highlights' as const };

// The pool also loads a highlighter on the page, for plain-text passes and as its fallback should the
// worker fail, and it takes the pool's type unless one is already loaded. Loading shiki-js first keeps
// Highlights, and its WebAssembly, out of the page.
void preloadHighlighter({ themes: [codeTheme.dark, codeTheme.light], langs: ['text'], preferredHighlighter: 'shiki-js' }).catch(() => {});

// Every CodeView highlights through this pool. The library shares one pool across all mounted
// providers and terminates its worker when the last one unmounts.
export function HighlightPool({ children }: { children: ReactNode }) {
  return <WorkerPoolContextProvider poolOptions={poolOptions} highlighterOptions={highlighterOptions}>{children}</WorkerPoolContextProvider>;
}
