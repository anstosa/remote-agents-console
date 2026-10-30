import { createServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { TicketStore } from '../src/auth/tickets.js';
import { GithubService } from '../src/github/service.js';
import { testConfig, testProject } from './helpers/config.js';
import { graphqlGithub, manualTimer, settled } from './helpers/github-graphql.js';

// Browsers report over the real /ws/dashboard socket whether they show the console; the GitHub
// poll runs while any does. Node's WebSocket has no header control, so the app's public origin is
// its loopback address, as in the pane socket's tests.

const auth = { unsign: () => 'session', get: () => ({ id: 'session', csrf: 'csrf' }), csrf: () => true } as never;
const control = { connect: () => true, active: () => true } as never;
const dashboardUpdates = { setLoader: () => {}, refresh: async () => undefined, subscribe: () => () => {}, close: () => {} } as never;
const project = testProject({ id: 'proj', path: '/src/octo/repo' });
const apps: FastifyInstance[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close().catch(() => undefined);
});

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

// a console whose GitHub is scripted and whose poll timer the test runs
async function consoleWithGithub() {
  const scripted = graphqlGithub({ 'octo/repo': {} });
  const timers = manualTimer();
  const github = new GithubService({ request: scripted.request, token: async () => 'token', now: () => 0, timer: timers.timer, command: async () => ({ code: 0, stdout: 'git@github.com:octo/repo.git\n' }), projects: () => [project] });
  const port = await freePort();
  const tickets = new TicketStore();
  const app = await buildApp(testConfig({ publicOrigin: new URL(`http://127.0.0.1:${port}`), projects: [project] as never }), { auth, control, dashboardUpdates, tickets, github, discovery: { worktreesNow: () => [] } as never } as never);
  apps.push(app);
  await app.listen({ host: '127.0.0.1', port });
  // one browser's dashboard socket, open
  const browser = async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/dashboard`, ['rac', tickets.mint('session', 'dashboard', 'dashboard').id]);
    await new Promise<void>((resolve, reject) => { ws.addEventListener('open', () => resolve()); ws.addEventListener('error', () => reject(new Error('socket failed'))); });
    // the server reads a frame a moment after it is sent
    const report = async (visible: boolean) => { ws.send(JSON.stringify({ v: 1, type: 'visibility', visible })); await pause(); };
    return { report, close: async () => { ws.close(); await pause(); } };
  };
  // run the poll's timer, if one is waiting, and count GitHub reads
  const poll = async () => { await timers.fire(); return scripted.calls.length; };
  return { browser, poll, timers };
}

const pause = async () => await new Promise(resolve => setTimeout(resolve, 50));

describe('GitHub polling follows the browsers that show the console', () => {
  it('polls while a browser reports visible, and stops when it hides or disconnects', async () => {
    const { browser, poll, timers } = await consoleWithGithub();
    const first = await browser();
    await settled();
    expect(await poll()).toBe(0);

    await first.report(true);
    expect(await poll()).toBe(1);
    // reporting visible again holds no second handle
    await first.report(true);
    await first.report(false);
    expect(timers.delays()).toEqual([]);

    const second = await browser();
    await second.report(true);
    await first.report(true);
    await second.close();
    expect(timers.delays()).toHaveLength(1);
    await first.close();
    expect(timers.delays()).toEqual([]);
  });
});
