import { expect, test, type Page } from '@playwright/test';
import { dropPane, dropPaneSocket, installPaneMock, openPaneSocketCount, paneConnectCount, paneFrameTypes, paneSocketCount, pushBytes } from './pane-stream-mock.js';

// The multiplexing pane connector on its own, against the scripted `/ws/panes` server in
// pane-stream-mock.ts: every stream shares one socket that opens lazily and closes when idle,
// stream ids keep their frames apart, and a dropped socket ends every stream.

type Events = Record<string, string[]>;
type MuxWindow = { __mux: { open: (name: string, target: string, pane?: string) => void; close: (name: string) => void; send: (name: string, frame: unknown) => void }; __events: Events };

const idleCloseMs = 400;

const setup = async (page: Page) => {
  await installPaneMock(page);
  await page.route('**/api/**', route => new URL(route.request().url()).pathname === '/api/panes/ticket'
    ? route.fulfill({ json: { ticket: 'pane-ticket' } })
    : route.fulfill({ status: 404, json: { error: 'not mocked' } }));
  await page.goto('/');
  await page.evaluate(async idleCloseMs => {
    const { createPaneMux } = await import('/src/pane-socket-client.ts');
    const connector = createPaneMux((url, init) => fetch(url, init), idleCloseMs);
    const events: Events = {};
    const connections = new Map<string, { send: (frame: unknown) => void; close: () => void }>();
    const log = (name: string, entry: string) => { (events[name] ??= []).push(entry); };
    (window as unknown as MuxWindow).__events = events;
    (window as unknown as MuxWindow).__mux = {
      open: (name, target, pane) => {
        connections.set(name, connector(target, pane)({
          onOpen: () => log(name, 'open'),
          onBytes: bytes => log(name, `bytes:${new TextDecoder().decode(bytes)}`),
          onFrame: frame => log(name, `frame:${frame.type}`),
          onClose: ({ code }) => log(name, `close:${code}`)
        }) as never);
      },
      close: name => connections.get(name)?.close(),
      send: (name, frame) => connections.get(name)?.send(frame as never)
    };
  }, idleCloseMs);
};

const events = (page: Page, name: string) => page.evaluate(name => (window as unknown as MuxWindow).__events[name] ?? [], name);
const open = (page: Page, name: string, target: string, pane?: string) => page.evaluate(({ name, target, pane }) => (window as unknown as MuxWindow).__mux.open(name, target, pane), { name, target, pane });
const close = (page: Page, name: string) => page.evaluate(name => (window as unknown as MuxWindow).__mux.close(name), name);

test('opens the shared socket with the first stream and carries every later stream on it', async ({ page }) => {
  await setup(page);
  expect(await paneSocketCount(page)).toBe(0);

  await open(page, 'agent', 'agent-1');
  await expect.poll(() => events(page, 'agent')).toEqual(['open']);
  await open(page, 'terminal', 'cora', '%5');
  await expect.poll(() => events(page, 'terminal')).toEqual(['open']);
  expect(await paneSocketCount(page)).toBe(1);
  expect(await paneConnectCount(page, 'agent-1')).toBe(1);
  expect(await paneConnectCount(page, '%5')).toBe(1);
});

test('holds streams opened while the socket connects, frames they sent included', async ({ page }) => {
  await setup(page);
  // both requested in one task, and one sends before its stream is on the wire
  await page.evaluate(() => {
    const mux = (window as unknown as MuxWindow).__mux;
    mux.open('agent', 'agent-1');
    mux.send('agent', { type: 'viewport', cols: 80, rows: 24, scrollback: 100 });
    mux.open('terminal', 'cora', '%5');
  });
  await expect.poll(() => events(page, 'terminal')).toEqual(['open']);
  expect((await events(page, 'agent')).slice(0, 1)).toEqual(['open']);
  expect(await paneSocketCount(page)).toBe(1);
  // the queued viewport followed the stream's open, and the server's size answer came back
  expect(await paneFrameTypes(page, 'agent-1')).toEqual(['viewport']);
  await expect.poll(() => events(page, 'agent')).toContain('frame:size');
});

test('keeps each stream\'s bytes apart, and ends only the stream the server closes', async ({ page }) => {
  await setup(page);
  await open(page, 'agent', 'agent-1');
  await open(page, 'terminal', 'cora', '%5');
  await expect.poll(() => events(page, 'terminal')).toContain('open');

  await pushBytes(page, '%5', 'shell');
  await pushBytes(page, 'agent-1', 'agent');
  await pushBytes(page, '%5', 'more');
  const bytes = async (name: string) => (await events(page, name)).filter(entry => entry.startsWith('bytes:'));
  await expect.poll(() => bytes('terminal')).toEqual(['bytes:shell', 'bytes:more']);
  expect(await bytes('agent')).toEqual(['bytes:agent']);

  await dropPane(page, '%5', 1011);
  await expect.poll(() => events(page, 'terminal')).toContain('close:1011');
  await pushBytes(page, 'agent-1', 'still');
  await expect.poll(() => events(page, 'agent')).toContain('bytes:still');
  expect(await events(page, 'agent')).not.toContain('close:1011');
  expect(await openPaneSocketCount(page)).toBe(1);
});

test('a dropped socket ends every stream, and the next stream opens a new one', async ({ page }) => {
  await setup(page);
  await open(page, 'agent', 'agent-1');
  await open(page, 'terminal', 'cora', '%5');
  await expect.poll(() => events(page, 'terminal')).toContain('open');

  await dropPaneSocket(page, 1008, 'control lost');
  await expect.poll(() => events(page, 'agent')).toContain('close:1008');
  await expect.poll(() => events(page, 'terminal')).toContain('close:1008');

  await open(page, 'again', 'agent-1');
  await expect.poll(() => events(page, 'again')).toEqual(['open']);
  expect(await paneSocketCount(page)).toBe(2);
});

test('closes the socket once it has carried no stream for a while, and keeps it through a switch', async ({ page }) => {
  await setup(page);
  await open(page, 'agent', 'agent-1');
  await expect.poll(() => events(page, 'agent')).toContain('open');

  // a workspace switch: the old stream closes and a new one opens inside the idle window
  await close(page, 'agent');
  await open(page, 'next', 'cora', '%5');
  await expect.poll(() => events(page, 'next')).toEqual(['open']);
  await page.waitForTimeout(idleCloseMs + 200);
  expect(await openPaneSocketCount(page)).toBe(1);

  await close(page, 'next');
  expect(await openPaneSocketCount(page)).toBe(1);
  await expect.poll(() => openPaneSocketCount(page), { timeout: idleCloseMs * 5 }).toBe(0);
  expect(await paneSocketCount(page)).toBe(1);
  // a closed stream got no onClose: the page closed it, nothing was lost
  expect(await events(page, 'next')).toEqual(['open']);
});
