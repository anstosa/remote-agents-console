import { spawn } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(scriptRoot, '..');
const repositoryRoot = resolve(webRoot, '../..');
const imageRoot = join(repositoryRoot, 'docs/images');
const baseUrl = 'http://127.0.0.1:4174';

const dashboard = {
  generation: 1,
  cleanupPending: 2,
  agents: [
    {
      id: 'agent-atlas',
      pane: { paneId: '%1', sessionId: 'local:$1', socketFingerprint: 'local' },
      home: '/worktrees/atlas',
      worktreeId: 'atlas',
      worktreeLabel: 'Atlas',
      worktreeOrder: 1,
      branch: 'feat/queued-prompt-management',
      gitStatus: {
        files: 4,
        staged: 1,
        unstaged: 2,
        untracked: 1,
        conflicted: 0,
        changes: [
          { code: 'M ', path: 'apps/server/src/prompts/queue.ts' },
          { code: ' M', path: 'apps/web/src/main.tsx' },
          { code: ' M', path: 'apps/web/src/styles.css' },
          { code: '??', path: 'apps/web/e2e/queued-prompts.spec.ts' }
        ]
      },
      title: '⠋ Implementing queued prompt management',
      projectUrl: 'https://atlas.example.test',
      stack: { actions: ['restart', 'build'], tunnel: true },
      newTaskConfigured: true,
      push: { label: 'Commit/Push', prompt: 'review, commit, and push' },
      pullRequest: {
        number: 42,
        title: 'Add persistent queued prompt management',
        status: 'open',
        url: 'https://github.com/example/atlas/pull/42',
        checks: 'passed'
      }
    },
    {
      id: 'agent-docs',
      pane: { paneId: '%2', sessionId: 'local:$2', socketFingerprint: 'local' },
      home: '/worktrees/docs',
      worktreeId: 'docs',
      worktreeLabel: 'Docs',
      worktreeOrder: 2,
      branch: 'docs/readme-refresh',
      gitStatus: { files: 1, staged: 0, unstaged: 1, untracked: 0, conflicted: 0 },
      title: 'Ready',
      unread: true
    },
    {
      id: 'agent-api',
      pane: { paneId: '%3', sessionId: 'local:$3', socketFingerprint: 'local' },
      home: '/worktrees/api',
      worktreeId: 'api',
      worktreeLabel: 'API migration',
      worktreeOrder: 3,
      branch: 'refactor/api-boundary',
      gitStatus: { files: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
      title: 'Action required | Choose migration strategy',
      question: { id: 'question-migration', text: 'How should the migration proceed?', field: { kind: 'choice', choices: ['Compatibility layer', 'Clean break'] }, source: 'structured' }
    }
  ],
  worktrees: [
    { id: 'mobile', label: 'Mobile UI', path: '/worktrees/mobile', branch: 'main', gitStatus: { files: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 }, available: true, pinned: true, order: 4 }
  ]
};

const queuedPrompts = [
  { id: 'queued-prompt-001', text: 'Run the focused browser tests and fix any queue flyout regressions.', createdAt: '2026-08-04T15:20:00.000Z' },
  { id: 'queued-prompt-002', text: 'Review the final diff for accessibility and responsive layout issues.', createdAt: '2026-08-04T15:21:00.000Z' },
  { id: 'queued-prompt-003', text: 'Prepare a concise deployment summary.', createdAt: '2026-08-04T15:22:00.000Z', attachments: [{ name: 'acceptance-criteria.md', size: 1840 }] }
];

const history = [
  { id: 'prompt-history-001', text: 'Inspect the prompt queue architecture and propose a safe implementation.', createdAt: '2026-08-04T15:00:00.000Z' },
  { id: 'prompt-history-002', text: 'Implement persistent queued prompt management with reorder, edit, and cancel.', createdAt: '2026-08-04T15:10:00.000Z' },
  { id: 'prompt-history-003', text: 'Run the full validation suite and deploy the local stack.', createdAt: '2026-08-04T15:15:00.000Z' }
];

const notes = [{
  id: 'note-identifier-001',
  text: '# Release checklist\n\n- [x] Persistent queue storage\n- [x] Reorder, edit, and cancel APIs\n- [x] Browser coverage\n- [ ] Final review and deployment\n\nKeep the queue **oldest-first** and preserve attachments.'
}];

const terminalText = [
  '\u001b[38;5;111mRemote Agent Console\u001b[0m  /worktrees/atlas',
  '',
  '\u001b[38;5;147m•\u001b[0m Added persistent, per-worktree prompt queues.',
  '\u001b[38;5;147m•\u001b[0m Connected the queue clock and management flyout.',
  '\u001b[38;5;147m•\u001b[0m Preserved prompt attachments until dispatch.',
  '',
  '\u001b[38;5;114m✓\u001b[0m Typecheck passed',
  '\u001b[38;5;114m✓\u001b[0m 154 server tests passed',
  '\u001b[38;5;114m✓\u001b[0m Browser workflow passed',
  '',
  '\u001b[38;5;221m◆\u001b[0m Reviewing accessibility and deployment readiness…'
].join('\n');

const waitForServer = async () => {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch { /* Vite is still starting. */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('Vite did not start in time.');
};

const capture = async (page, name) => {
  const path = join(imageRoot, name);
  await page.screenshot({ path, fullPage: true });
  const file = await stat(path);
  if (file.size < 10_000) throw new Error(`${name} is unexpectedly small.`);
  process.stdout.write(`captured docs/images/${name} (${Math.round(file.size / 1024)} KiB)\n`);
};

await mkdir(imageRoot, { recursive: true });
const vite = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', '4174', '--strictPort'], { cwd: webRoot, stdio: ['ignore', 'pipe', 'pipe'] });
let viteErrors = '';
vite.stderr.on('data', chunk => { viteErrors += String(chunk); });

try {
  await waitForServer();
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    await page.addInitScript(({ output, latestAssistantMessage }) => {
      // The Agent panel streams its pane over `/ws/pane/:id`: deliver the seed as binary bytes
      // and the latest response as a metadata frame, echoing the browser's viewport as the size.
      const seed = output.replace(/\n/gu, '\r\n');
      class MockPaneSocket {
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSING = 2;
        static CLOSED = 3;
        readyState = MockPaneSocket.CONNECTING;
        binaryType = 'blob';
        onopen = null;
        onclose = null;
        onerror = null;
        onmessage = null;
        constructor(url) {
          this.url = String(url);
          this.isPane = this.url.includes('/ws/pane/');
          this.painted = false;
          window.setTimeout(() => {
            if (this.readyState !== MockPaneSocket.CONNECTING) return;
            this.readyState = MockPaneSocket.OPEN;
            this.onopen?.(new Event('open'));
          }, 20);
        }
        send(data) {
          if (!this.isPane) return;
          let frame;
          try { frame = JSON.parse(data); } catch { return; }
          if (frame.type !== 'viewport' || typeof frame.cols !== 'number' || typeof frame.rows !== 'number') return;
          const { cols, rows } = frame;
          window.setTimeout(() => {
            if (this.readyState !== MockPaneSocket.OPEN) return;
            this.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'size', cols, rows }) }));
            if (this.painted) return;
            this.painted = true;
            const bytes = new TextEncoder().encode(seed);
            this.onmessage?.(new MessageEvent('message', { data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }));
            this.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'metadata', metadata: { message: latestAssistantMessage, overflow: false } }) }));
          }, 60);
        }
        close() {
          if (this.readyState === MockPaneSocket.CLOSED) return;
          this.readyState = MockPaneSocket.CLOSED;
          this.onclose?.(new CloseEvent('close'));
        }
      }
      Object.defineProperty(window, 'WebSocket', { configurable: true, value: MockPaneSocket });
    }, {
      output: terminalText,
      latestAssistantMessage: 'Queued prompt management is implemented and all validation checks pass.'
    });
    await page.route('**/api/**', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'readme-csrf', active: true, deviceName: 'README capture' } });
      if (url.pathname === '/api/dashboard') return route.fulfill({ json: dashboard });
      if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
      if (url.pathname === '/api/dashboard/ticket') return route.fulfill({ json: { ticket: 'dashboard-ticket' } });
      if (/^\/api\/agents\/agent-(?:atlas|docs|api)\/tickets$/u.test(url.pathname)) return route.fulfill({ json: { ticket: 'log-ticket' } });
      if (url.pathname === '/api/agents/agent-atlas/saved-prompts') return route.fulfill({ json: { prompts: [
        { id: 'saved-prompt-001', text: 'Review the diff without changing behavior.' },
        { id: 'saved-prompt-002', text: 'Run targeted validation.', attachments: [{ name: 'test-plan.md', size: 920 }] }
      ] } });
      if (url.pathname === '/api/agents/agent-atlas/queued-prompts') return route.fulfill({ json: { prompts: queuedPrompts } });
      if (url.pathname === '/api/agents/agent-atlas/prompt-history') return route.fulfill({ json: { prompts: history } });
      if (url.pathname === '/api/agents/agent-atlas/skills') return route.fulfill({ json: { skills: [] } });
      if (url.pathname === '/api/worktrees/atlas/notes') return route.fulfill({ json: { notes } });
      if (url.pathname === '/api/worktrees/atlas/switch-prs') return route.fulfill({ json: { enabled: true, pullRequests: [] } });
      if (url.pathname === '/api/agents/agent-atlas/github-actions') return route.fulfill({ json: { url: 'https://github.com/example/atlas/actions' } });
      return route.fulfill({ status: 404, json: { error: 'not mocked for README capture' } });
    });

    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    await page.locator('.log-canvas .xterm-screen').waitFor();
    await page.evaluate(async () => { await document.fonts.ready; });
    await page.waitForTimeout(1_000);
    await capture(page, 'console-overview.png');

    await page.getByRole('button', { name: 'Saved prompts (2)' }).click();
    await page.getByLabel('Saved prompts', { exact: true }).waitFor();
    await page.waitForTimeout(150);
    await capture(page, 'saved-prompts.png');

    await page.getByRole('button', { name: 'Saved prompts (2)' }).click();
    await page.getByRole('button', { name: 'Queued prompts (3)' }).click();
    await page.getByLabel('Queued prompts', { exact: true }).waitFor();
    await page.waitForTimeout(150);
    await capture(page, 'queued-prompts.png');

    await page.getByRole('button', { name: 'Queued prompts (3)' }).click();
    await page.getByRole('button', { name: 'Notes (1)' }).click();
    const noteChoice = page.getByRole('button', { name: /Release checklist/u });
    if (await noteChoice.isVisible()) await noteChoice.click();
    await page.getByRole('dialog', { name: 'Worktree note' }).waitFor();
    await page.waitForTimeout(250);
    await capture(page, 'worktree-notes.png');

    await page.getByRole('button', { name: 'Close note' }).click();
    await page.setViewportSize({ width: 430, height: 932 });
    await page.waitForTimeout(250);
    await capture(page, 'mobile-console.png');

    await context.close();
  } finally {
    await browser.close();
  }
} catch (error) {
  if (viteErrors) process.stderr.write(viteErrors);
  throw error;
} finally {
  vite.kill('SIGTERM');
}
