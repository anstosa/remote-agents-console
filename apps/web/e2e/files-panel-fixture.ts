import type { Page, Route } from '@playwright/test';

export type FilesRequestRecord = { path: string; method: string; body?: unknown; headers: Record<string, string>; bytes?: Buffer };
export type FavoriteReadHold = { started: Promise<void>; finished: Promise<void>; release: () => void };
export type FilesFixture = {
  records: FilesRequestRecord[];
  currentPath: () => string;
  setPath: (path: string) => void;
  holdNextFavoriteRead: () => FavoriteReadHold;
  queueFavoriteRead: (response: { status?: number; json: unknown }) => void;
};

// issue one bounded opaque fixture capability
const objectToken = (name: string) => `object-token:${name}:00000000`;

// build one exact file-entry wire object
const fileEntry = (name: string, kind: 'file' | 'directory', token = objectToken(name), directory = '/home/ubuntu/project') => ({
  name,
  hostPath: directory === '/' ? `/${name}` : `${directory}/${name}`,
  kind,
  owner: { uid: 1000, label: 'ubuntu' },
  permissions: kind === 'directory' ? 'drwxr-xr-x' : '-rw-r--r--',
  mode: kind === 'directory' ? 0o40755 : 0o100644,
  modifiedAt: '2026-10-06T12:34:00.000Z',
  size: kind === 'directory' ? 4096 : 1536,
  objectToken: token
});

// install a complete authenticated files fixture
export async function installFilesFixture(page: Page): Promise<FilesFixture> {
  const records: FilesRequestRecord[] = [];
  let currentPath = '/home/ubuntu/project';
  let favorites: unknown[] = [];
  let operationKind = 'create-file';
  let operationTotal = 1;
  let operationCount = 0;
  let favoriteCount = 0;
  let operationName: string | undefined;
  let operationSourceToken: string | undefined;
  let nextFavoriteHold: { wait: Promise<void>; markStarted: () => void; markFinished: () => void } | undefined;
  const favoriteReadQueue: Array<{ status?: number; json: unknown }> = [];
  // hold one favorite response after its request captures a snapshot
  const holdNextFavoriteRead = (): FavoriteReadHold => {
    let release!: () => void;
    let markStarted!: () => void;
    let markFinished!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const finished = new Promise<void>(resolve => { markFinished = resolve; });
    nextFavoriteHold = { wait, markStarted, markFinished };
    return { started, finished, release };
  };
  // describe the canonical current directory as a favorite-capable object
  const directoryEntry = (path: string) => ({ ...fileEntry(path === '/' ? '/' : path.slice(path.lastIndexOf('/') + 1), 'directory', `object-token:directory:${path}`, path === '/' ? '/' : path.slice(0, path.lastIndexOf('/')) || '/'), hostPath: path });
  // list deterministic entries at one canonical path
  const entriesAt = (path: string) => path === '/home/ubuntu/project/sub'
    ? []
    : [
        fileEntry('sub', 'directory', objectToken('sub'), path),
        { ...fileEntry('.hidden', 'file', objectToken('.hidden'), path), owner: { uid: 1001, label: 'alex' }, modifiedAt: '2026-10-06T09:00:00.000Z', size: 64 },
        { ...fileEntry('alpha.txt', 'file', objectToken('alpha.txt'), path), modifiedAt: '2026-10-06T12:34:00.000Z', size: 1536 },
        { ...fileEntry('zeta.bin', 'file', objectToken('zeta.bin'), path), owner: { uid: 1002, label: 'zoe' }, permissions: '-rwx------', mode: 0o100700, modifiedAt: '2026-10-07T12:00:00.000Z', size: 8192 }
      ];
  await page.route('**/api/**', async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const contentType = request.headers()['content-type'] ?? '';
    const body = contentType.includes('application/json') && request.postData() !== null ? request.postDataJSON() : undefined;
    records.push({ path: url.pathname, method, body, headers: request.headers(), ...(contentType.includes('application/octet-stream') ? { bytes: request.postDataBuffer() ?? undefined } : {}) });
    // authenticate one active worktree workspace
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Files test' } });
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', home: '/home/ubuntu/project', placeId: 'cora', worktreeId: 'cora', worktreeLabel: 'Cora', title: 'Ready', branch: 'main', queuedPromptCount: 0 }], projects: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/panes/ticket') return route.fulfill({ json: { ticket: 'pane-ticket' } });
    if (/^\/api\/agents\/agent-1\/(?:saved-prompts|prompt-history|queued-prompts)$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-1/message-files') return route.fulfill({ json: { files: [] } });
    if (url.pathname === '/api/worktrees/cora/notes') return route.fulfill({ json: { notes: [] } });
    if (url.pathname === '/api/worktrees/cora/panes') return route.fulfill({ json: { panes: [{ paneId: '%1', session: '$1', window: '@0', command: 'codex', path: '/home/ubuntu/project', title: '', agent: true }] } });
    if (url.pathname === '/api/worktrees/cora/comparison') return route.fulfill({ json: { kind: 'working', base: 'HEAD', gitBase: 'HEAD', files: [], fingerprint: '', truncated: false } });
    // return server-saved favorites for this place only
    if (url.pathname === '/api/worktrees/cora/file-favorites' && method === 'GET') {
      const queued = favoriteReadQueue.shift();
      const response = queued ?? { json: { favorites: structuredClone(favorites) } };
      const hold = nextFavoriteHold;
      nextFavoriteHold = undefined;
      // release this exact captured response on demand
      if (hold !== undefined) { hold.markStarted(); await hold.wait; }
      await route.fulfill({ status: response.status, json: response.json });
      hold?.markFinished();
      return;
    }
    if (url.pathname === '/api/worktrees/cora/file-favorites' && method === 'PUT') {
      const token = (body as { objectToken?: string } | undefined)?.objectToken;
      const candidate = token === `object-token:directory:${currentPath}` ? directoryEntry(currentPath) : entriesAt(currentPath).find(entry => entry.objectToken === token);
      if (candidate === undefined) return route.fulfill({ status: 409, json: { error: { code: 'stale_object', message: 'The selected object is no longer available.' } } });
      favoriteCount += 1;
      const id = `favorite-record-${String(favoriteCount).padStart(4, '0')}`;
      const favorite = { id, path: candidate.hostPath, state: 'available', entry: { ...candidate, favorite: { id, state: 'available' } } };
      favorites = [...favorites, favorite];
      return route.fulfill({ json: { favorite } });
    }
    if (url.pathname.startsWith('/api/worktrees/cora/file-favorites/') && method === 'DELETE') {
      const id = decodeURIComponent(url.pathname.split('/').at(-1)!);
      favorites = favorites.filter(favorite => (favorite as { id: string }).id !== id);
      return route.fulfill({ status: 204 });
    }
    // list canonical paths and hidden metadata
    if (url.pathname === '/api/worktrees/cora/files/list') {
      const requested = (body as { path?: string } | undefined)?.path;
      // default to the place host home
      currentPath = requested ?? '/home/ubuntu/project';
      const directory = entriesAt(currentPath).map(entry => {
        const favorite = favorites.find(item => (item as { path: string }).path === entry.hostPath) as { id: string; state: string } | undefined;
        return favorite === undefined ? entry : { ...entry, favorite: { id: favorite.id, state: favorite.state } };
      });
      const currentFavorite = favorites.find(item => (item as { path: string }).path === currentPath) as { id: string; state: string } | undefined;
      const currentEntry = directoryEntry(currentPath);
      return route.fulfill({ json: { path: currentPath, parent: currentPath === '/' ? undefined : currentPath.slice(0, currentPath.lastIndexOf('/')) || '/', destinationDirectoryToken: `directory:${currentPath}`, directoryEntry: currentFavorite === undefined ? currentEntry : { ...currentEntry, favorite: { id: currentFavorite.id, state: currentFavorite.state } }, entries: directory, inaccessibleEntries: 0, limits: { maxEntries: 1000 } } });
    }
    if (url.pathname === '/api/worktrees/cora/files/preview') {
      return route.fulfill({ json: { path: '/home/ubuntu/project/alpha.txt', size: 16, binary: false, truncated: false, content: 'outside root preview\n' } });
    }
    // prepare deterministic operation manifests
    if (url.pathname === '/api/worktrees/cora/files/operations/prepare') {
      operationCount += 1;
      operationKind = (body as { kind?: string }).kind ?? 'copy';
      operationTotal = Array.isArray((body as { sourceTokens?: unknown[] }).sourceTokens) ? (body as { sourceTokens: unknown[] }).sourceTokens.length : 1;
      operationName = (body as { name?: string; newName?: string }).name ?? (body as { newName?: string }).newName;
      operationSourceToken = (body as { sourceToken?: string }).sourceToken;
      const name = operationName;
      const conflicts = name === 'existing.txt' ? [{ id: 'collision-record-0001', sourceName: name, destinationName: name, allowed: ['replace', 'skip', 'keep-both'] }] : [];
      return route.fulfill({ json: { operationId: `operation-${String(operationCount).padStart(16, '0')}`, kind: operationKind, totalItems: operationTotal, conflicts, ...(operationKind === 'delete' ? { confirmation: { count: operationTotal } } : {}) } });
    }
    if (/^\/api\/worktrees\/cora\/files\/operations\/operation-\d{16}\/execute$/u.test(url.pathname)) {
      // mirror the server's favorite rewrite after a successful rename
      if (operationKind === 'rename' && operationName !== undefined && operationSourceToken !== undefined) {
        const source = entriesAt(currentPath).find(entry => entry.objectToken === operationSourceToken);
        // rewrite only the favorite bound to the renamed source object
        if (source !== undefined) favorites = favorites.map(value => {
          const favorite = value as { id?: string; path?: string; entry?: Record<string, unknown> };
          // retain unrelated favorite records byte-for-byte
          if (favorite.path !== source.hostPath || favorite.id === undefined) return value;
          const hostPath = `${currentPath}/${operationName}`;
          return { ...favorite, path: hostPath, entry: { ...favorite.entry, name: operationName, hostPath, objectToken: objectToken(operationName), favorite: { id: favorite.id, state: 'available' } } };
        });
      }
      return route.fulfill({ status: 202, json: { operationId: url.pathname.split('/').at(-2), kind: operationKind, state: 'completed', phase: 'complete', completedItems: operationTotal, totalItems: operationTotal, bytesCompleted: 0, bytesTotal: 0, results: [] } });
    }
    // authorize and capture raw upload bytes
    if (url.pathname === '/api/worktrees/cora/files/uploads/prepare') return route.fulfill({ json: { uploadId: 'upload-record-0001', conflicts: [] } });
    if (url.pathname === '/api/worktrees/cora/files/uploads/upload-record-0001/authorize') return route.fulfill({ json: { files: [{ clientId: 'file-0', token: 'upload-token', destinationName: 'raw.bin' }] } });
    if (url.pathname === '/api/worktrees/cora/files/uploads/upload-record-0001/file-0') return route.fulfill({ json: { outcome: 'uploaded' } });
    // prepare and serve one session ticket download
    if (url.pathname === '/api/worktrees/cora/files/downloads' && method === 'POST') return route.fulfill({ json: { downloadId: 'download-record-0001', url: '/api/files/downloads/download-record-0001?ticket=one-use', filename: 'alpha.txt' } });
    if (url.pathname === '/api/files/downloads/download-record-0001') return route.fulfill({ headers: { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="alpha.txt"' }, body: 'download bytes' });
    if (url.pathname === '/api/worktrees/cora/files/downloads/download-record-0001/status') return route.fulfill({ json: { state: 'completed', bytesCompleted: 14 } });
    return route.fulfill({ status: 404, json: { error: { code: 'not_found', message: `Not mocked: ${url.pathname}` } } });
  });
  return {
    records,
    currentPath: () => currentPath,
    setPath: path => { currentPath = path; },
    holdNextFavoriteRead,
    // queue one bounded favorite response for the next read
    queueFavoriteRead: response => { favoriteReadQueue.push(response); }
  };
}
