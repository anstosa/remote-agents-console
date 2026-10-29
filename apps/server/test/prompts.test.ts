import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { maxPromptAttachmentBytes, PromptService, type UndeliveredDrain } from '../src/prompts/service.js';
import { promptAttachmentData, promptAttachmentName, validPromptAttachments } from '../src/prompts/validation.js';
import { codexAdapter } from '../src/adapters/codex.js';
import { inlineQuestionId } from '../src/adapters/inline-questions.js';
import { QueuedPromptService, type QueuedPrompt } from '../src/prompts/queue.js';
import { PromptHistoryService } from '../src/prompt-history/service.js';
import { stated } from './helpers/agent.js';
const socket={fingerprint:'socket',path:'/tmp/sock',device:1,inode:1}; const agent=stated({id:'socket:%1',pane: { paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket' },home:'/tmp',title:''});
// records every prompt a halted queue drains into Notes, in drain order (front of the queue first)
const drainRecorder = () => { const drained: QueuedPrompt[] = []; const drain: UndeliveredDrain = async (_scope, prompt) => { drained.push(prompt); return true; }; return { drained, drain }; };
it('allows prompt attachments totaling 25 MiB', () => {
  expect(maxPromptAttachmentBytes).toBe(25 * 1024 * 1024);
});
// retain byte limits without imposing a file-count limit
it('allows more than ten valid prompt attachments', () => {
  // create distinct one-byte files beyond the former count cap
  const attachments = Array.from({ length: 11 }, (_, index) => ({ name: `context-${index}.txt`, data: 'eA==' }));
  expect(validPromptAttachments(attachments)).toBe(true);
});
// validate the advertised maximum without recursive regular-expression overflow
it('decodes a 25 MiB attachment and rejects malformed base64', () => {
  const encoded = Buffer.alloc(maxPromptAttachmentBytes, 1).toString('base64');
  expect(promptAttachmentData(encoded)?.length).toBe(maxPromptAttachmentBytes);
  expect(promptAttachmentData('AAAA=')).toBeUndefined();
  expect(promptAttachmentData('A===')).toBeUndefined();
  expect(promptAttachmentData('****')).toBeUndefined();
  expect(promptAttachmentName('.')).toBeUndefined();
  expect(promptAttachmentName('..')).toBeUndefined();
});
describe('safe prompt flow',()=>{it('pastes through a generated buffer and submits an idle Codex composer with Enter',async()=>{const calls:string[][]=[];const discovery={worktreesNow:()=>[],target:async()=>({agent,socket})};const tmux={pastePrompt:async(_s:unknown,_p:string,b:string,p:string)=>{calls.push(['paste',b,p]);return true},sendKeys:async(_s:unknown,p:string,keys:string[])=>{calls.push([keys.join('+'),p]);return true}};const service=new PromptService(discovery as never,tmux as never);await expect(service.submit(agent.id,'hello; $(not-a-command)')).resolves.toBe(true);expect(calls[0]?.[0]).toBe('paste');expect(calls[0]?.[2]).toBe('hello; $(not-a-command) ');expect(calls.slice(1)).toEqual([['Enter','%1']]);expect(calls[0]?.[1]).toMatch(/^rac-/)});

// preserve unanswered questions when prompt submission fails
it('invalidates a prose question only after prompt delivery succeeds', async () => {
  const invalidated: string[] = [];
  let submissions = 0;
  const discovery = {
    // use a non-worktree pane
    worktreesNow: () => [],
    // retain the same idle target
    target: async () => ({ agent, socket }),
    // record accepted-delivery invalidations
    invalidateMessageQuestion: (id: string) => invalidated.push(id)
  };
  const tmux = {
    // accept both paste attempts
    pastePrompt: async () => true,
    // reject only the second submission
    sendKeys: async () => ++submissions === 1
  };
  const service = new PromptService(discovery as never, tmux as never);

  await expect(service.submit(agent.id, 'accepted prompt')).resolves.toBe(true);
  await expect(service.submit(agent.id, 'rejected prompt')).resolves.toBe(false);

  expect(invalidated).toEqual([agent.id]);
});

// clear prose questions only after a reset reaches the pane
it('invalidates a prose question only after reset delivery succeeds', async () => {
  const invalidated: string[] = [];
  let submissions = 0;
  const discovery = {
    // use a non-worktree pane
    worktreesNow: () => [],
    // retain the same idle target
    target: async () => ({ agent, socket }),
    // record accepted-delivery invalidations
    invalidateMessageQuestion: (id: string) => invalidated.push(id)
  };
  const tmux = {
    // accept both paste attempts
    pastePrompt: async () => true,
    // reject only the second submission
    sendKeys: async () => ++submissions === 1
  };
  const service = new PromptService(discovery as never, tmux as never);

  await expect(service.submitReset(agent.id, '/new')).resolves.toBe(true);
  await expect(service.submitReset(agent.id, '/new')).resolves.toBe(false);

  expect(invalidated).toEqual([agent.id]);
});

it('uses the Adapter queue key if the pane becomes active while the prompt is pasted', async () => {
  const working = stated({ ...agent, title: '⠋ Working' });
  let targets = 0;
  const sent: string[][] = [];
  // expose the idle-to-working race across target revalidation
  const discovery = { worktreesNow: () => [], target: async () => ({ agent: targets++ === 0 ? agent : working, socket }) };
  const tmux = {
    pastePrompt: async () => true,
    sendKeys: async (_socket: unknown, _pane: string, keys: string[]) => { sent.push(keys); return true; }
  };
  const service = new PromptService(discovery as never, tmux as never);
  await expect(service.submit(agent.id, 'follow active work')).resolves.toBe(true);
  expect(sent).toEqual([['Tab']]);
});

it('stages attached files in a Git-ignored location and references each one in the queued prompt', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'rac-attachments-'));
  await writeFile(join(workspace, '.gitignore'), 'node_modules/\n');
  execFileSync('/usr/bin/git', ['init', '--quiet', workspace]);
  const attachedAgent = { ...agent, home: workspace };
  const pasted: string[] = [];
  const discovery = { worktreesNow: () => [], target: async () => ({ agent: attachedAgent, socket }) };
  const tmux = { pastePrompt: async (_s: unknown, _p: string, _b: string, prompt: string) => { pasted.push(prompt); return true; }, sendKeys: async () => true };
  try {
    const service = new PromptService(discovery as never, tmux as never);
    await expect(service.submit(attachedAgent.id, 'Review this.', [{ name: 'notes.txt', data: Buffer.from('attachment body').toString('base64') }])).resolves.toBe(true);
    expect(pasted[0]).toMatch(/Attached files:\n@node_modules\/\.remote-agent-console\/attachments\/.+\/notes\.txt /);
    const path = /@(node_modules\/[^\s]+)/.exec(pasted[0] ?? '')?.[1];
    expect(path).toBeDefined();
    await expect(readFile(join(workspace, path!), 'utf8')).resolves.toBe('attachment body');
    expect(execFileSync('/usr/bin/git', ['-C', workspace, 'status', '--porcelain'], { encoding: 'utf8' })).not.toContain('node_modules');
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

// reproduce image-only delivery outside repositories
it('submits attachment-only prompts from a non-Git workspace', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rac-non-git-attachments-'));
  const queue = new QueuedPromptService(join(directory, 'queue.json'));
  const attachedAgent = { ...agent, home: directory };
  const attachment = { name: 'photo.jpg', data: Buffer.from('image data').toString('base64') };
  let pasted = '';
  let submitted = false;
  const discovery = { worktreesNow: () => [], target: async () => ({ agent: attachedAgent, socket }) };
  const tmux = {
    // retain the staged reference
    pastePrompt: async (_socket: unknown, _pane: string, _buffer: string, prompt: string) => { pasted = prompt; return true; },
    // expose the collapsed live draft until submission
    capture: async () => submitted ? '› ' : `› [Pasted Content ${pasted.length} chars]`,
    // accept the idle prompt
    sendKeys: async () => { submitted = true; return true; }
  };
  try {
    const service = new PromptService(discovery as never, tmux as never, undefined, queue);
    await expect(service.submit(attachedAgent.id, '', [attachment])).resolves.toBe(true);
    expect(pasted).toMatch(/Attached files:\n@node_modules\/\.remote-agent-console\/attachments\/.+\/photo\.jpg /);
    const path = /@(node_modules\/[^\s]+)/u.exec(pasted)?.[1];
    // require the staged reference
    if (path === undefined) throw new Error('staged attachment path missing');
    await expect(readFile(join(directory, path), 'utf8')).resolves.toBe('image data');
    await expect(service.listQueued(attachedAgent.id)).resolves.toEqual([]);
  } finally {
    // remove staged test state
    await rm(directory, { recursive: true, force: true });
  }
});

// retain configured worktree staging even when shared scratch storage is configured
it('maps a discovered host worktree path to its mounted workspace before staging attachments', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'rac-mounted-'));
  await writeFile(join(workspace, '.gitignore'), 'node_modules/\n');
  execFileSync('/usr/bin/git', ['init', '--quiet', workspace]);
  const discoveredAgent = { ...agent, home: '/host/worktree' };
  const pasted: string[] = [];
  const worktree = { id: 'p:/host/worktree', projectId: 'p', label: 'Worktree', path: workspace, identity: workspace, hostPath: '/host/worktree', available: true, pinned: true, main: true, detached: false, locked: false };
  const discovery = { worktreesNow: () => [worktree], target: async () => ({ agent: discoveredAgent, socket }) };
  const tmux = { pastePrompt: async (_s: unknown, _p: string, _b: string, prompt: string) => { pasted.push(prompt); return true; }, sendKeys: async () => true };
  try {
    const service = new PromptService(discovery as never, tmux as never, undefined, undefined, undefined, undefined, undefined, { workspace: join(workspace, 'unused-shared-checkout'), hostWorkspace: '/host/console-checkout' });
    await expect(service.submit(discoveredAgent.id, 'Read.', [{ name: 'notes.txt', data: Buffer.from('mounted').toString('base64') }])).resolves.toBe(true);
    const path = /@(node_modules\/[^\s]+)/.exec(pasted[0] ?? '')?.[1];
    await expect(readFile(join(workspace, path!), 'utf8')).resolves.toBe('mounted');
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

it('records successful submissions in the Agent\'s own history', async () => {
  const recorded: Array<[string, string]> = [];
  let submissions = 0;
  const worktree = { id: 'cora:/tmp', projectId: 'cora', label: 'Cora', path: '/tmp', identity: '/tmp', available: true, pinned: true, main: true, detached: false, locked: false };
  const discovery = { worktreesNow: () => [worktree], target: async () => ({ agent, socket }) };
  const tmux = { pastePrompt: async () => true, sendKeys: async () => ++submissions === 1 };
  const history = { record: async (scope: string, text: string) => { recorded.push([scope, text]); } };
  const service = new PromptService(discovery as never, tmux as never, history as never);

  await expect(service.submit(agent.id, 'first prompt')).resolves.toBe(true);
  await expect(service.submit(agent.id, 'failed prompt')).resolves.toBe(false);

  expect(recorded).toEqual([[`agent:${agent.id}`, 'first prompt']]);
});

// preserve advisor isolation for ordinary and Unicode-rich collapsed pastes
it.each(['ordinary', 'unicode'] as const)('isolates %s update advisor prompts from the configured repository queue', async mode => {
  const directory = await mkdtemp(join(tmpdir(), 'rac-advisor-scope-'));
  const queue = new QueuedPromptService(join(directory, 'queue.json'));
  const normalAgent = { ...agent, id: 'socket:%1', pane: { ...agent.pane, paneId: '%1' }, home: '/tmp' };
  const advisorAgent = { ...agent, id: 'socket:%2', pane: { ...agent.pane, paneId: '%2' }, home: '/tmp', displayLabel: 'Update Advisor Starting v4 2222222' };
  const pasted: string[][] = [];
  const entered: string[] = [];
  const queued: string[] = [];
  const advisorPrompt = mode === 'unicode' ? '😀'.repeat(80) : 'Review the pending update with enough additional instructions that the composer may clip the trailing content before submission';
  let advisorStarted = false;
  let captureCount = 0;
  const worktree = { id: 'remoteagents:/tmp', projectId: 'remoteagents', label: 'Remote Agents', path: '/tmp', identity: '/tmp', available: true, pinned: true, main: true, detached: false, locked: false };
  const discovery = { worktreesNow: () => [worktree], target: async (id: string) => ({ agent: id === advisorAgent.id ? stated({ ...advisorAgent, title: advisorStarted ? '⠋ Reviewing' : 'Ready' }) : normalAgent, socket }) };
  const tmux = { pastePrompt: async (_socket: unknown, pane: string, _buffer: string, prompt: string) => { pasted.push([pane, prompt]); return true; }, capture: async () => ++captureCount < 3 ? 'Starting Codex' : pasted.length === 0 ? '› ' : `› [Pasted Content ${[...advisorPrompt].length + 1} chars]`, sendKeys: async (_socket: unknown, pane: string, keys: string[]) => { if (keys.includes('Enter')) { entered.push(pane); advisorStarted = entered.length >= 2; } else queued.push(pane); return true; } };
  const history = { record: async (scope: string, text: string) => ({ id: 'history-advisor', scope, text }) };
  const service = new PromptService(discovery as never, tmux as never, history as never, queue);
  try {
    const release = await service.acquireRestartLock(normalAgent.id);
    await expect(service.submitUpdateAdvisor(advisorAgent.id, '2'.repeat(40), advisorPrompt)).resolves.toBe(true);

    expect(pasted).toEqual([['%2', `${advisorPrompt} `]]);
    expect(captureCount).toBeGreaterThanOrEqual(8);
    expect(entered).toEqual(['%2', '%2']);
    expect(queued).toEqual([]);
    await expect(queue.list('remoteagents:/tmp')).resolves.toEqual([]);
    await expect(queue.list(`agent:${advisorAgent.id}`)).resolves.toEqual([]);
    release?.();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('queues prompts that arrive while an idle restart holds the Agent lock', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rac-restart-lock-'));
  const queue = new QueuedPromptService(join(directory, 'queue.json'));
  const pasted: string[] = [];
  const worktree = { id: 'cora:/tmp', projectId: 'cora', label: 'Cora', path: '/tmp', identity: '/tmp', available: true, pinned: true, main: true, detached: false, locked: false };
  const discovery = { worktreesNow: () => [worktree], target: async () => ({ agent, socket }) };
  const tmux = {
    pastePrompt: async (_socket: unknown, _pane: string, _buffer: string, prompt: string) => { pasted.push(prompt); return true; },
    sendKeys: async () => true
  };
  const service = new PromptService(discovery as never, tmux as never, undefined, queue);
  try {
    const release = await service.acquireRestartLock(agent.id);
    expect(release).toBeTypeOf('function');
    await expect(service.submit(agent.id, 'Run after restart')).resolves.toBe(true);
    expect(pasted).toEqual([]);
    await expect(queue.list(`agent:${agent.id}`)).resolves.toMatchObject([{ text: 'Run after restart' }]);
    release?.();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('keeps a Review run prompt out of the Worktree queue the operator Agent drains', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rac-review-run-scope-'));
  const queue = new QueuedPromptService(join(directory, 'queue.json'));
  const pasted: string[][] = [];
  const worktree = { id: 'cora:/tmp', projectId: 'cora', label: 'Cora', path: '/tmp', identity: '/tmp', available: true, pinned: true, main: true, detached: false, locked: false };
  const operator = { ...agent, id: 'socket:%1', pane: { ...agent.pane, paneId: '%1' } };
  const reviewer = { ...agent, id: 'socket:%2', pane: { ...agent.pane, paneId: '%2' }, reviewRun: 'run-1' };
  const discovery = { worktreesNow: () => [worktree], target: async (id: string) => ({ agent: id === reviewer.id ? reviewer : operator, socket }) };
  const tmux = {
    pastePrompt: async (_socket: unknown, pane: string, _buffer: string, prompt: string) => { pasted.push([pane, prompt]); return true; },
    sendKeys: async () => true
  };
  const service = new PromptService(discovery as never, tmux as never, undefined, queue);
  try {
    // the operator's Agent holds the Worktree scope, as a busy or restarting Agent does
    const release = await service.acquireRestartLock(operator.id);
    await expect(service.submit(reviewer.id, 'Narrate the tour')).resolves.toBe(true);
    expect(pasted).toEqual([['%2', 'Narrate the tour ']]);
    await expect(queue.list('cora:/tmp')).resolves.toEqual([]);
    release?.();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('blocks restart acquisition while a submitted prompt awaits its working state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rac-awaiting-start-'));
  const queue = new QueuedPromptService(join(directory, 'queue.json'));
  const discovery = { worktreesNow: () => [], target: async () => ({ agent, socket }) };
  const tmux = { pastePrompt: async () => true, sendKeys: async () => true };
  const service = new PromptService(discovery as never, tmux as never, undefined, queue);
  try {
    await expect(service.submit(agent.id, 'Start working')).resolves.toBe(true);
    await expect(service.acquireRestartLock(agent.id)).resolves.toBeUndefined();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

describe('per-Agent prompt scope', () => {
  const worktree = { id: 'cora:/tmp', projectId: 'cora', label: 'Cora', path: '/tmp', identity: '/tmp', available: true, pinned: true, main: true, detached: false, locked: false };

  it('keeps a prompt queued for a busy Agent out of its idle sibling at the same Worktree', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-sibling-scope-'));
    const queue = new QueuedPromptService(join(directory, 'queue.json'));
    const idle = { id: 'socket:%1', pane: { paneId: '%1' }, home: '/tmp', kind: 'claude' as const, title: '', attention: 'finished' as 'finished' | 'working' };
    const busy = { ...idle, id: 'socket:%2', pane: { ...idle.pane, paneId: '%2' }, attention: 'working' as 'finished' | 'working' };
    const pasted: string[] = [];
    const discovery = { worktreesNow: () => [worktree], target: async (id: string) => ({ agent: id === busy.id ? busy : idle, socket }) };
    const tmux = { pastePrompt: async (_socket: unknown, pane: string) => { pasted.push(pane); return true; }, sendKeys: async () => true, capture: async () => '' };
    const service = new PromptService(discovery as never, tmux as never, undefined, queue);
    try {
      await expect(service.submit(busy.id, 'For the busy one')).resolves.toBe(true);
      await service.observe(idle);
      expect(pasted).toEqual([]);
      await expect(queue.list(`agent:${busy.id}`)).resolves.toMatchObject([{ text: 'For the busy one' }]);
      await expect(queue.list(`agent:${idle.id}`)).resolves.toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('drains a departed Agent\'s queue into Notes and drops its history once the grace window passes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(100_000);
    const directory = await mkdtemp(join(tmpdir(), 'rac-departed-'));
    const queue = new QueuedPromptService(join(directory, 'queue.json'));
    const history = new PromptHistoryService(join(directory, 'history.json'));
    const { drained, drain } = drainRecorder();
    const service = new PromptService({ worktreesNow: () => [worktree], target: async () => undefined } as never, {} as never, history, queue, drain);
    try {
      await queue.enqueue('agent:socket:%9', 'Left behind', [], { home: '/tmp', placeId: 'place-1' });
      await history.record('agent:socket:%9', 'Earlier prompt');
      await history.record('agent:socket:%1', 'Live prompt');
      await service.retireDeparted(['socket:%1']);
      // a pane that reappears within the window restarts its grace
      vi.setSystemTime(129_999);
      await service.retireDeparted(['socket:%1', 'socket:%9']);
      vi.setSystemTime(150_000);
      await service.retireDeparted(['socket:%1']);
      expect(drained).toEqual([]);

      vi.setSystemTime(180_000);
      await service.retireDeparted(['socket:%1']);
      expect(drained).toMatchObject([{ text: 'Left behind', origin: { home: '/tmp', placeId: 'place-1' } }]);
      await expect(queue.list('agent:socket:%9')).resolves.toEqual([]);
      await expect(history.list('agent:socket:%9')).resolves.toEqual([]);
      await expect(history.list('agent:socket:%1')).resolves.toMatchObject([{ text: 'Live prompt' }]);
    } finally {
      vi.useRealTimers();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps a departed Agent\'s queue when its prompts have nowhere to go', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(100_000);
    const directory = await mkdtemp(join(tmpdir(), 'rac-departed-refused-'));
    const queue = new QueuedPromptService(join(directory, 'queue.json'));
    const history = new PromptHistoryService(join(directory, 'history.json'));
    const service = new PromptService({ worktreesNow: () => [], target: async () => undefined } as never, {} as never, history, queue, async () => false);
    try {
      await queue.enqueue('agent:socket:%9', 'Nowhere to save');
      await history.record('agent:socket:%9', 'Earlier prompt');
      await service.retireDeparted([]);
      vi.setSystemTime(130_000);
      await service.retireDeparted([]);
      await expect(queue.list('agent:socket:%9')).resolves.toMatchObject([{ text: 'Nowhere to save' }]);
      await expect(history.list('agent:socket:%9')).resolves.toMatchObject([{ text: 'Earlier prompt' }]);
    } finally {
      vi.useRealTimers();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('hands a restarted Agent\'s queue and history to its replacement', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-hand-over-'));
    const queue = new QueuedPromptService(join(directory, 'queue.json'));
    const history = new PromptHistoryService(join(directory, 'history.json'));
    const service = new PromptService({ worktreesNow: () => [worktree], target: async () => undefined } as never, {} as never, history, queue);
    try {
      await queue.enqueue('agent:socket:%1', 'Queued during restart');
      await history.record('agent:socket:%1', 'Before restart');
      await service.handOver('socket:%1', 'socket:%2');
      await expect(queue.list('agent:socket:%2')).resolves.toMatchObject([{ text: 'Queued during restart' }]);
      await expect(queue.list('agent:socket:%1')).resolves.toEqual([]);
      await expect(history.list('agent:socket:%2')).resolves.toMatchObject([{ text: 'Before restart' }]);
      await expect(history.list('agent:socket:%1')).resolves.toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

it('rejects restart acquisition after the selected mutation generation changes', async () => {
  const discovery = { worktreesNow: () => [], target: async () => ({ agent, socket }) };
  const service = new PromptService(discovery as never, {} as never);
  const selectedVersion = service.mutationVersion(agent.id);
  const releaseMutation = service.beginAgentMutation(agent.id);
  releaseMutation?.();

  await expect(service.acquireRestartLock(agent.id, selectedVersion)).resolves.toBeUndefined();
});

it('rejects a completed mutation between dashboard selection and the agent snapshot', async () => {
  const discovery = { worktreesNow: () => [], target: async () => ({ agent, socket }) };
  const service = new PromptService(discovery as never, {} as never);
  const selectionGeneration = service.mutationGeneration();
  const releaseMutation = service.beginAgentMutation(agent.id);
  releaseMutation?.();
  const selectedVersion = service.mutationVersion(agent.id);

  await expect(service.acquireRestartLock(agent.id, selectedVersion, selectionGeneration)).resolves.toBeUndefined();
});

// capture fast responses between dashboard polls
it('records the final assistant answer when the busy state is missed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rac-prompt-answer-'));
  const queue = new QueuedPromptService(join(directory, 'queue.json'));
  const mutableAgent = stated({ ...agent, title: 'Ready' });
  const completed: Array<[string, string, string]> = [];
  const historyEntry = { id: 'prompt-history-001', text: 'Summarize this', createdAt: '2026-08-07T01:00:00.000Z' };
  let submitted = false;
  const discovery = { worktreesNow: () => [], target: async () => ({ agent: mutableAgent, socket }) };
  const tmux = {
    pastePrompt: async () => true,
    capture: async () => submitted ? ['› Summarize this', '', '• Final summary', '', '  - One detail', '─ Worked for 2s', '', '› '].join('\n') : '› Summarize this ',
    sendKeys: async () => { submitted = true; return true; }
  };
  const history = {
    record: async () => historyEntry,
    recordAnswer: async (scope: string, entryId: string, answer: string) => {
      completed.push([scope, entryId, answer]);
      return { ...historyEntry, answer, answeredAt: '2026-08-07T01:00:02.000Z' };
    }
  };
  const service = new PromptService(discovery as never, tmux as never, history as never, queue);
  try {
    await expect(service.submit(agent.id, 'Summarize this')).resolves.toBe(true);
    await service.observe(mutableAgent);

    expect(completed).toEqual([['agent:socket:%1', historyEntry.id, 'Final summary\n\n- One detail']]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// reconcile restart-lost answer tracking
it('records a recovered answer before dispatching queued work after a restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rac-prompt-answer-restart-'));
  const queue = new QueuedPromptService(join(directory, 'queue.json'));
  const mutableAgent = stated({ ...agent, title: 'Ready' });
  const events: string[] = [];
  const historyEntry = { id: 'prompt-history-restart', text: 'Active prompt', createdAt: '2026-08-07T01:00:00.000Z' };
  let capture = ['› Active prompt', '', '• Answer still rendering'].join('\n');
  const discovery = {
    worktreesNow: () => [],
    // resolve the stable pane
    target: async () => ({ agent: mutableAgent, socket })
  };
  const tmux = {
    // submit released queued work
    pastePrompt: async (_socket: unknown, _pane: string, _buffer: string, prompt: string) => { events.push('dispatch'); capture = `› ${prompt}`; return true; },
    // accept queued Codex input
    // expose current terminal history
    capture: async () => capture,
    // support prompt cancellation
    sendKeys: async () => { capture = '› '; return true; }
  };
  const history = {
    // expose the unanswered prompt
    list: async () => [historyEntry],
    // track dispatched prompts
    record: async (_scope: string, text: string) => ({ id: 'prompt-history-next', text, createdAt: '2026-08-07T01:01:00.000Z' }),
    // record completion ordering
    recordAnswer: async (_scope: string, _entryId: string, answer: string) => {
      events.push('answer');
      return { ...historyEntry, answer, answeredAt: '2026-08-07T01:00:02.000Z' };
    }
  };
  const service = new PromptService(discovery as never, tmux as never, history as never, queue);
  try {
    await queue.enqueue('agent:socket:%1', 'Next prompt');
    await service.observe(mutableAgent);

    expect(events).toEqual([]);
    await expect(service.listQueued(agent.id)).resolves.toMatchObject([{ text: 'Next prompt' }]);

    capture = ['› Active prompt', '', '• ## Recovered answer', '', '  Completed before restart.', '────────', ''].join('\n');

    await service.observe(mutableAgent);
    await service.observe(mutableAgent);

    expect(events).toEqual(['answer', 'dispatch']);
    await expect(service.listQueued(agent.id)).resolves.toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// retain completion tracking until the terminal response is capturable
it('retries answer recording after the agent first appears finished', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rac-prompt-answer-race-'));
  const queue = new QueuedPromptService(join(directory, 'queue.json'));
  const mutableAgent = stated({ ...agent, title: 'Ready' });
  const completed: string[] = [];
  const historyEntry = { id: 'prompt-history-race', text: 'Explain the race', createdAt: '2026-08-07T01:00:00.000Z' };
  let submitted = false;
  let capture = ['› Explain the race', '', '• Still rendering', '', '› '].join('\n');
  const discovery = { worktreesNow: () => [], target: async () => ({ agent: mutableAgent, socket }) };
  const tmux = {
    pastePrompt: async () => true,
    capture: async () => submitted ? capture : '› Explain the race ',
    sendKeys: async () => { submitted = true; return true; }
  };
  const history = {
    record: async () => historyEntry,
    // collect persisted answers
    recordAnswer: async (_scope: string, _entryId: string, answer: string) => {
      completed.push(answer);
      return { ...historyEntry, answer, answeredAt: '2026-08-07T01:00:02.000Z' };
    }
  };
  const service = new PromptService(discovery as never, tmux as never, history as never, queue);
  try {
    await expect(service.submit(agent.id, 'Explain the race')).resolves.toBe(true);
    mutableAgent.title = '⠋ Working';
    await service.observe(mutableAgent);

    mutableAgent.title = 'Ready';
    await service.observe(mutableAgent);
    expect(completed).toEqual([]);

    capture = ['› Explain the race', '', '• Final answer', '', '─ Worked for 1s', '', '› '].join('\n');
    await service.observe(mutableAgent);

    expect(completed).toEqual(['Final answer']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// retain tracked answers after their prompts leave tmux history
it('records a completed answer after long output scrolls its prompt out of capture', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rac-prompt-answer-scrolled-'));
  const queue = new QueuedPromptService(join(directory, 'queue.json'));
  const mutableAgent = stated({ ...agent, title: 'Ready' });
  const completed: string[] = [];
  const historyEntry = { id: 'prompt-history-scrolled', text: 'Run the long task', createdAt: '2026-08-07T01:00:00.000Z' };
  let submitted = false;
  let capture = ['• Previous answer', '─ Worked for 1s', '', '› '].join('\n');
  const discovery = { worktreesNow: () => [], target: async () => ({ agent: mutableAgent, socket }) };
  const tmux = {
    pastePrompt: async () => true,
    capture: async () => submitted ? capture : ['• Previous answer', '─ Worked for 1s', '', '› Run the long task '].join('\n'),
    sendKeys: async () => { submitted = true; return true; }
  };
  const history = {
    record: async () => historyEntry,
    // collect the recovered long answer
    recordAnswer: async (_scope: string, _entryId: string, answer: string) => {
      completed.push(answer);
      return { ...historyEntry, answer, answeredAt: '2026-08-07T01:00:02.000Z' };
    }
  };
  const service = new PromptService(discovery as never, tmux as never, history as never, queue);
  try {
    await expect(service.submit(agent.id, 'Run the long task')).resolves.toBe(true);
    mutableAgent.title = '⠋ Working';
    await service.observe(mutableAgent);

    mutableAgent.title = 'Ready';
    capture = ['• Previous answer', '─ Worked for 1s', ''].join('\n');
    await service.observe(mutableAgent);
    expect(completed).toEqual([]);

    capture = ['• Long task complete', '', '  All checks passed.', '─ Worked for 2m', ''].join('\n');
    await service.observe(mutableAgent);

    expect(completed).toEqual(['Long task complete\n\nAll checks passed.']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// recover a restart-lost answer without its scrolled prompt
it('records the newest unanswered completion after observing restarted work', async () => {
  const mutableAgent = stated({ ...agent, title: '⠋ Working' });
  const completed: string[] = [];
  const historyEntry = { id: 'prompt-history-restarted-long', text: 'Run the restarted long task', createdAt: '2026-08-07T01:01:00.000Z' };
  const olderEntry = { id: 'prompt-history-older', text: 'Earlier task', createdAt: '2026-08-07T01:00:00.000Z', answer: 'Earlier answer', answeredAt: '2026-08-07T01:00:02.000Z' };
  const discovery = { worktreesNow: () => [], target: async () => ({ agent: mutableAgent, socket }) };
  const tmux = {
    capture: async () => ['• Recovered after restart', '', '─ Worked for 3m', ''].join('\n')
  };
  const history = {
    list: async () => [historyEntry, olderEntry],
    // collect restart reconciliation
    recordAnswer: async (_scope: string, _entryId: string, answer: string) => {
      completed.push(answer);
      return { ...historyEntry, answer, answeredAt: '2026-08-07T01:04:00.000Z' };
    }
  };
  const service = new PromptService(discovery as never, tmux as never, history as never);

  await service.observe(mutableAgent);
  mutableAgent.title = 'Ready';
  await service.observe(mutableAgent);

  expect(completed).toEqual(['Recovered after restart']);
});

// recover native completion after a mid-turn server restart
it('records a rollout-only answer after restarting during submitted work', async () => {
  const mutableAgent = stated({ ...agent, title: '⠋ Working' });
  const completed: Array<[string, string]> = [];
  const historyEntry = { id: 'prompt-history-restarted-rollout', text: 'Run across restart', createdAt: '2026-09-07T15:58:00.000Z' };
  let turnDone = false;
  const discovery = {
    worktreesNow: () => [],
    // retain one active pane
    target: async () => ({ agent: mutableAgent, socket }),
    // expose its rollout owner
    paneProcessId: () => 4242
  };
  const tmux = {
    // model native Codex without a completion footer
    capture: async () => '• Native Codex output'
  };
  const history = {
    // expose the submitted unanswered prompt
    list: async () => [historyEntry],
    // collect recovered completion
    recordAnswer: async (_scope: string, entryId: string, answer: string) => {
      completed.push([entryId, answer]);
      return { ...historyEntry, answer, answeredAt: '2026-09-07T16:07:09.000Z' };
    }
  };
  const view = {
    ...codexAdapter,
    completion: {
      // snapshot the resumed in-flight rollout
      baseline: async () => ({ rollout: 'rollout.jsonl', ordinal: 100 }),
      // publish its later terminal event
      since: async (baseline: { ordinal: number }) => turnDone
        ? { kind: 'completed' as const, ordinal: baseline.ordinal + 50, answer: 'Recovered rollout answer.' }
        : { kind: 'pending' as const }
    }
  };
  const service = new PromptService(discovery as never, tmux as never, history as never, undefined, undefined, () => view);

  await service.observe(mutableAgent);
  turnDone = true;
  mutableAgent.title = 'Ready';
  await service.observe(mutableAgent);

  expect(completed).toEqual([['prompt-history-restarted-rollout', 'Recovered rollout answer.']]);
});

// leave stale unanswered history detached from new work
it('does not adopt an older unanswered prompt during rollout recovery', async () => {
  const mutableAgent = stated({ ...agent, title: '⠋ Working' });
  const completed: string[] = [];
  const latestEntry = { id: 'prompt-history-latest', text: 'Latest task', createdAt: '2026-09-07T16:00:00.000Z', answer: 'Latest answer', answeredAt: '2026-09-07T16:01:00.000Z' };
  const staleEntry = { id: 'prompt-history-stale-rollout', text: 'Stale task', createdAt: '2026-09-07T15:00:00.000Z' };
  let turnDone = false;
  const discovery = {
    worktreesNow: () => [],
    // retain one active pane
    target: async () => ({ agent: mutableAgent, socket }),
    // expose its rollout owner
    paneProcessId: () => 4242
  };
  const tmux = {
    // omit terminal completion evidence
    capture: async () => '• Unrelated native Codex output'
  };
  const history = {
    // keep the stale unanswered entry behind completed work
    list: async () => [latestEntry, staleEntry],
    // flag accidental reassignment
    recordAnswer: async (_scope: string, entryId: string) => {
      completed.push(entryId);
      return staleEntry;
    }
  };
  const view = {
    ...codexAdapter,
    completion: {
      // snapshot the unrelated rollout
      baseline: async () => ({ rollout: 'rollout.jsonl', ordinal: 200 }),
      // publish its later terminal event
      since: async (baseline: { ordinal: number }) => turnDone
        ? { kind: 'completed' as const, ordinal: baseline.ordinal + 50, answer: 'Unrelated answer.' }
        : { kind: 'pending' as const }
    }
  };
  const service = new PromptService(discovery as never, tmux as never, history as never, undefined, undefined, () => view);

  await service.observe(mutableAgent);
  turnDone = true;
  mutableAgent.title = 'Ready';
  await service.observe(mutableAgent);

  expect(completed).toEqual([]);
});

// reject pre-restart output before a pending prompt starts
it('does not assign a promptless completion to work not observed running', async () => {
  const mutableAgent = stated({ ...agent, title: 'Ready' });
  const recorded: string[] = [];
  const pendingEntry = { id: 'prompt-history-pending', text: 'Pending task', createdAt: '2026-08-07T01:01:00.000Z' };
  const discovery = { worktreesNow: () => [], target: async () => ({ agent: mutableAgent, socket }) };
  const tmux = {
    capture: async () => ['• Previous answer', '', '─ Worked for 1m', ''].join('\n')
  };
  const history = {
    list: async () => [pendingEntry],
    // flag accidental pending writes
    recordAnswer: async (_scope: string, entryId: string) => {
      recorded.push(entryId);
      return pendingEntry;
    }
  };
  const service = new PromptService(discovery as never, tmux as never, history as never);

  await service.observe(mutableAgent);

  expect(recorded).toEqual([]);
});

// avoid assigning an answered turn to stale unanswered history
it('does not duplicate a promptless completion onto an older unanswered entry', async () => {
  const mutableAgent = stated({ ...agent, title: 'Ready' });
  const recorded: string[] = [];
  const newestEntry = { id: 'prompt-history-newest', text: 'Newest task', createdAt: '2026-08-07T01:01:00.000Z', answer: 'Newest answer', answeredAt: '2026-08-07T01:01:02.000Z' };
  const staleEntry = { id: 'prompt-history-stale', text: 'Stale task', createdAt: '2026-08-07T01:00:00.000Z' };
  const discovery = { worktreesNow: () => [], target: async () => ({ agent: mutableAgent, socket }) };
  const tmux = {
    capture: async () => ['• Newest answer', '', '─ Worked for 1m', ''].join('\n')
  };
  const history = {
    list: async () => [newestEntry, staleEntry],
    // flag accidental stale writes
    recordAnswer: async (_scope: string, entryId: string) => {
      recorded.push(entryId);
      return staleEntry;
    }
  };
  const service = new PromptService(discovery as never, tmux as never, history as never);

  await service.observe(mutableAgent);

  expect(recorded).toEqual([]);
});

// retry transient history storage failures
it('does not settle completion until the answer is stored in history', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rac-prompt-answer-storage-'));
  const queue = new QueuedPromptService(join(directory, 'queue.json'));
  const mutableAgent = stated({ ...agent, title: 'Ready' });
  const historyEntry = { id: 'prompt-history-storage', text: 'Persist this', createdAt: '2026-08-07T01:00:00.000Z' };
  let attempts = 0;
  let submitted = false;
  const discovery = { worktreesNow: () => [], target: async () => ({ agent: mutableAgent, socket }) };
  const tmux = {
    pastePrompt: async () => true,
    capture: async () => submitted ? ['› Persist this', '', '• Durable answer', '', '─ Worked for 1s', '', '› '].join('\n') : '› Persist this ',
    sendKeys: async () => { submitted = true; return true; }
  };
  const history = {
    record: async () => historyEntry,
    // fail the first persistence attempt
    recordAnswer: async (_scope: string, _entryId: string, answer: string) => {
      attempts += 1;
      return attempts === 1 ? undefined : { ...historyEntry, answer, answeredAt: '2026-08-07T01:00:02.000Z' };
    }
  };
  const service = new PromptService(discovery as never, tmux as never, history as never, queue);
  try {
    await expect(service.submit(agent.id, 'Persist this')).resolves.toBe(true);
    mutableAgent.title = '⠋ Working';
    await service.observe(mutableAgent);

    mutableAgent.title = 'Ready';
    await service.observe(mutableAgent);
    await service.observe(mutableAgent);

    expect(attempts).toBe(2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('submits Codex shell-mode commands with Enter instead of queueing Tab', async () => {
  const calls: string[][] = [];
  const discovery = { worktreesNow: () => [], target: async () => ({ agent, socket }) };
  const tmux = {
    pastePrompt: async (_socket: unknown, _pane: string, buffer: string, prompt: string) => { calls.push(['paste', buffer, prompt]); return true; },
    sendKeys: async (_socket: unknown, pane: string, keys: string[]) => { calls.push([keys.join('+'), pane]); return true; }
  };

  await expect(new PromptService(discovery as never, tmux as never).submit(agent.id, '!git status')).resolves.toBe(true);

  expect(calls[0]?.[0]).toBe('paste');
  expect(calls[0]?.[2]).toBe('!git status');
  expect(calls.slice(1)).toEqual([['Enter', '%1']]);
});

it('holds prompts while an agent works and dispatches them in the managed order', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rac-managed-queue-'));
  const queue = new QueuedPromptService(join(directory, 'queue.json'));
  const mutableAgent = stated({ ...agent, title: '⠋ Working' });
  const calls: string[] = [];
  const recorded: string[] = [];
  let capture = ['› Active prompt', '', '• Working'].join('\n');
  const discovery = { worktreesNow: () => [], target: async () => ({ agent: mutableAgent, socket }) };
  const tmux = {
    pastePrompt: async (_socket: unknown, _pane: string, _buffer: string, prompt: string) => { calls.push(prompt.trimEnd()); capture = `› ${prompt}`; return true; },
    capture: async () => capture,
    sendKeys: async () => { capture = '› '; return true; }
  };
  const history = { record: async (_scope: string, text: string) => { recorded.push(text); } };
  const service = new PromptService(discovery as never, tmux as never, history as never, queue);
  try {
    await expect(service.submit(agent.id, 'First managed prompt')).resolves.toBe(true);
    await expect(service.submit(agent.id, 'Second managed prompt')).resolves.toBe(true);
    const waiting = await service.listQueued(agent.id);
    expect(waiting?.map(prompt => prompt.text)).toEqual(['First managed prompt', 'Second managed prompt']);
    await service.moveQueued(agent.id, waiting![1]!.id, 'earlier');

    capture = ['› Active prompt', '', '• Completed successfully', '', '─ Worked for 1s', ''].join('\n');
    mutableAgent.title = 'Ready';
    await service.observe(mutableAgent);
    expect(calls).toEqual(['Second managed prompt']);
    await expect(service.listQueued(agent.id)).resolves.toMatchObject([{ text: 'First managed prompt' }]);

    await service.observe(mutableAgent);
    expect(calls).toHaveLength(1);
    mutableAgent.title = '⠋ Working';
    await service.observe(mutableAgent);
    capture = ['› Second managed prompt', '', '• Completed successfully', '', '─ Worked for 1s', ''].join('\n');
    mutableAgent.title = 'Ready';
    await service.observe(mutableAgent);
    expect(calls).toEqual(['Second managed prompt', 'First managed prompt']);
    expect(recorded).toEqual(['Second managed prompt', 'First managed prompt']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('drains queued prompts into Notes instead of dispatching them after active work fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rac-failed-queue-'));
  const queue = new QueuedPromptService(join(directory, 'queue.json'));
  const { drained, drain } = drainRecorder();
  const mutableAgent = stated({ ...agent, title: '⠋ Working' });
  const pasted: string[] = [];
  let capture = ['› Earlier prompt', '', '• Earlier answer', '', '─ Worked for 1s', '', '› Active prompt', '', '• Working'].join('\n');
  const discovery = { worktreesNow: () => [], target: async () => ({ agent: mutableAgent, socket }) };
  const tmux = {
    pastePrompt: async (_socket: unknown, _pane: string, _buffer: string, prompt: string) => { pasted.push(prompt.trimEnd()); return true; },
    capture: async () => capture,
    sendKeys: async () => true
  };
  const service = new PromptService(discovery as never, tmux as never, undefined, queue, drain);
  try {
    await expect(service.submit(agent.id, 'First queued prompt')).resolves.toBe(true);
    await expect(service.submit(agent.id, 'Second queued prompt', [{ name: 'context.txt', data: Buffer.from('context').toString('base64') }])).resolves.toBe(true);

    capture = ['› Earlier prompt', '', '• Earlier answer', '', '─ Worked for 1s', '', '› Active prompt', '', '■ Request failed', ''].join('\n');
    mutableAgent.title = 'Ready';
    await service.observe(mutableAgent);

    expect(pasted).toEqual([]);
    await expect(service.listQueued(agent.id)).resolves.toEqual([]);
    // drained front-of-queue first, each with its attachment names carried through
    expect(drained).toMatchObject([
      { text: 'First queued prompt' },
      { text: 'Second queued prompt', attachments: [{ name: 'context.txt' }] }
    ]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('keeps a failed queue transfer halted until every prompt is drained into a Note', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rac-halted-queue-'));
  const queue = new QueuedPromptService(join(directory, 'queue.json'));
  const mutableAgent = stated({ ...agent, title: '⠋ Working' });
  const pasted: string[] = [];
  const transferred: string[] = [];
  let saveSucceeds = false;
  const discovery = { worktreesNow: () => [], target: async () => ({ agent: mutableAgent, socket }) };
  const tmux = {
    pastePrompt: async (_socket: unknown, _pane: string, _buffer: string, prompt: string) => { pasted.push(prompt.trimEnd()); return true; },
    capture: async () => ['› Active prompt', '', '■ Cancelled', ''].join('\n'),
    sendKeys: async () => true
  };
  // simulate transient notes-store failure until saveSucceeds flips
  const drain: UndeliveredDrain = async (_scope, prompt) => {
    if (!saveSucceeds) return false;
    transferred.push(prompt.text);
    return true;
  };
  const service = new PromptService(discovery as never, tmux as never, undefined, queue, drain);
  try {
    await expect(service.submit(agent.id, 'Queued after cancellation')).resolves.toBe(true);
    mutableAgent.title = 'Ready';
    await service.observe(mutableAgent);
    await service.observe(mutableAgent);

    expect(pasted).toEqual([]);
    expect(transferred).toEqual([]);
    await expect(service.listQueued(agent.id)).resolves.toMatchObject([{ text: 'Queued after cancellation' }]);

    saveSucceeds = true;
    await service.observe(mutableAgent);

    expect(transferred).toEqual(['Queued after cancellation']);
    await expect(service.listQueued(agent.id)).resolves.toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('drains queued prompts into Notes when cancellation succeeds', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rac-cancelled-queue-'));
  const queue = new QueuedPromptService(join(directory, 'queue.json'));
  const { drained, drain } = drainRecorder();
  const mutableAgent = stated({ ...agent, title: '⠋ Working' });
  const interrupts: string[] = [];
  const discovery = { worktreesNow: () => [], target: async () => ({ agent: mutableAgent, socket }) };
  const tmux = {
    pastePrompt: async () => true,
    capture: async () => ['› Active prompt', '', '• Completed successfully', '', '─ Worked for 1s', ''].join('\n'),
    sendKeys: async (_socket: unknown, pane: string, keys: string[]) => { if (keys.includes('C-c')) interrupts.push(pane); return true; }
  };
  const service = new PromptService(discovery as never, tmux as never, undefined, queue, drain);
  try {
    await expect(service.submit(agent.id, 'Do not run this')).resolves.toBe(true);
    await expect(service.cancel(agent.id)).resolves.toBe('ok');
    mutableAgent.title = 'Ready';
    await service.observe(mutableAgent);

    expect(interrupts).toEqual(['%1']);
    await expect(service.listQueued(agent.id)).resolves.toEqual([]);
    expect(drained).toMatchObject([{ text: 'Do not run this' }]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('dispatches a prompt queued behind a Codex turn that completes only in the rollout', async () => {
  // The reported bug: native Codex renders no `─ Worked for` boundary, so the TUI
  // parse never observes the finish; the first prompt's phase never completes and,
  // after the grace window, the queued second prompt is drained into a Note. The
  // rollout's task_complete is the authoritative signal that fixes it.
  const directory = await mkdtemp(join(tmpdir(), 'rac-rollout-complete-'));
  const queue = new QueuedPromptService(join(directory, 'queue.json'));
  const { drained, drain } = drainRecorder();
  const mutableAgent = stated({ ...agent, title: 'Ready' });
  const pasted: string[] = [];
  const recorded: Array<[string, string]> = [];
  let composer = '';
  let turnDone = false;
  const discovery = {
    worktreesNow: () => [],
    target: async () => ({ agent: mutableAgent, socket }),
    paneProcessId: () => 4242
  };
  const tmux = {
    // a native-Codex pane: a prompt and a working bullet, but never a completion boundary
    pastePrompt: async (_socket: unknown, _pane: string, _buffer: string, prompt: string) => { pasted.push(prompt.trimEnd()); composer = `› ${prompt}`; return true; },
    capture: async () => composer || '› Ready',
    sendKeys: async () => { composer = ''; return true; }
  };
  const history = {
    record: async (_scope: string, text: string) => ({ id: `h-${pasted.length}`, text }),
    recordAnswer: async (_scope: string, id: string, answer: string) => { recorded.push([id, answer]); return { id }; }
  };
  // the real Codex adapter with a scripted rollout: pending until the turn finishes
  const view = {
    ...codexAdapter,
    completion: {
      baseline: async () => ({ rollout: 'rollout.jsonl', ordinal: 0 }),
      since: async (baseline: { ordinal: number }) => turnDone ? { kind: 'completed' as const, ordinal: baseline.ordinal + 4, answer: 'The answer.' } : { kind: 'pending' as const }
    }
  };
  const service = new PromptService(discovery as never, tmux as never, history as never, queue, drain, () => view);
  try {
    await expect(service.submit(agent.id, 'First prompt')).resolves.toBe(true);
    await expect(service.submit(agent.id, 'Second prompt')).resolves.toBe(true);
    await expect(service.listQueued(agent.id)).resolves.toMatchObject([{ text: 'Second prompt' }]);

    // the turn runs and returns; the rollout has not yet recorded task_complete
    mutableAgent.title = '⠋ Working';
    await service.observe(mutableAgent);
    mutableAgent.title = 'Ready';
    await service.observe(mutableAgent);
    await service.observe(mutableAgent);
    // still pending: the second prompt is neither dispatched nor drained
    expect(pasted).toEqual(['First prompt']);
    await expect(service.listQueued(agent.id)).resolves.toMatchObject([{ text: 'Second prompt' }]);
    expect(drained).toEqual([]);

    // the rollout records task_complete: the answer is stored and the queue dispatches
    turnDone = true;
    await service.observe(mutableAgent);
    expect(pasted).toEqual(['First prompt', 'Second prompt']);
    expect(recorded).toEqual([['h-1', 'The answer.']]);
    await expect(service.listQueued(agent.id)).resolves.toEqual([]);
    expect(drained).toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('fails a rollout-tracked turn that the log records as aborted', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rac-rollout-abort-'));
  const queue = new QueuedPromptService(join(directory, 'queue.json'));
  const { drained, drain } = drainRecorder();
  const mutableAgent = stated({ ...agent, title: 'Ready' });
  const pasted: string[] = [];
  let composer = '';
  const discovery = { worktreesNow: () => [], target: async () => ({ agent: mutableAgent, socket }), paneProcessId: () => 4242 };
  const tmux = {
    // keep pre-submit input separate from native activity output
    pastePrompt: async (_socket: unknown, _pane: string, _buffer: string, prompt: string) => { pasted.push(prompt.trimEnd()); composer = `› ${prompt}`; return true; },
    capture: async () => composer || '› Ready',
    sendKeys: async () => { composer = ''; return true; }
  };
  const view = { ...codexAdapter, completion: { baseline: async () => ({ rollout: 'rollout.jsonl', ordinal: 0 }), since: async (baseline: { ordinal: number }) => ({ kind: 'aborted' as const, ordinal: baseline.ordinal + 3 }) } };
  const service = new PromptService(discovery as never, tmux as never, undefined, queue, drain, () => view);
  try {
    await expect(service.submit(agent.id, 'First prompt')).resolves.toBe(true);
    await expect(service.submit(agent.id, 'Second prompt')).resolves.toBe(true);

    mutableAgent.title = '⠋ Working';
    await service.observe(mutableAgent);
    mutableAgent.title = 'Ready';
    await service.observe(mutableAgent);
    await service.observe(mutableAgent);

    // an aborted turn holds the queue back and drains it into a Note rather than dispatching
    expect(pasted).toEqual(['First prompt']);
    await expect(service.listQueued(agent.id)).resolves.toEqual([]);
    expect(drained).toMatchObject([{ text: 'Second prompt' }]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('passes a reset instant into the baseline capture and records the fresh-thread answer', async () => {
  // A Run reuses a pane by resetting its conversation, then submits with the reset
  // instant; the completion baseline must anchor on the fresh thread so the answer
  // lands on this submit's history entry rather than the stale pre-reset rollout.
  const directory = await mkdtemp(join(tmpdir(), 'rac-reset-baseline-'));
  const queue = new QueuedPromptService(join(directory, 'queue.json'));
  const mutableAgent = stated({ ...agent, title: 'Ready' });
  const pasted: string[] = [];
  const recorded: Array<[string, string]> = [];
  const resetInstants: Array<number | undefined> = [];
  let composer = '';
  let turnDone = false;
  const discovery = {
    worktreesNow: () => [],
    target: async () => ({ agent: mutableAgent, socket }),
    paneProcessId: () => 4242,
    paneWorkingDirectory: () => '/home/ubuntu/cora'
  };
  const tmux = {
    // keep pre-submit input separate from native activity output
    pastePrompt: async (_socket: unknown, _pane: string, _buffer: string, prompt: string) => { pasted.push(prompt.trimEnd()); composer = `› ${prompt}`; return true; },
    capture: async () => composer || '› Ready',
    sendKeys: async () => { composer = ''; return true; }
  };
  const history = {
    record: async (_scope: string, text: string) => ({ id: `h-${pasted.length}`, text }),
    recordAnswer: async (_scope: string, id: string, answer: string) => { recorded.push([id, answer]); return { id }; }
  };
  const resetAt = 1_788_100_000_000;
  const view = {
    ...codexAdapter,
    completion: {
      // record the reset instant the service supplies; a real deferred baseline resolves
      // its rollout lazily in `since`, which this fake stands in for
      baseline: async (_pane: { pid: number; cwd?: string }, reset?: number) => { resetInstants.push(reset); return reset === undefined ? { rollout: 'stale.jsonl' as const, ordinal: 0 } : { cwd: '/home/ubuntu/cora' as const, resetAt: reset, ordinal: 0 }; },
      since: async () => turnDone ? { kind: 'completed' as const, ordinal: 4, answer: 'Fresh answer.' } : { kind: 'pending' as const }
    }
  };
  const service = new PromptService(discovery as never, tmux as never, history as never, queue, undefined, () => view);
  try {
    await expect(service.submit(agent.id, 'Run the note', [], resetAt)).resolves.toBe(true);
    // the reset instant reached the baseline capture exactly once
    expect(resetInstants).toEqual([resetAt]);

    mutableAgent.title = '⠋ Working';
    await service.observe(mutableAgent);
    mutableAgent.title = 'Ready';
    await service.observe(mutableAgent);
    await service.observe(mutableAgent);
    // the fresh thread has not recorded task_complete: nothing is stored yet
    expect(recorded).toEqual([]);

    turnDone = true;
    await service.observe(mutableAgent);
    // the answer lands on this submit's own history entry
    expect(recorded).toEqual([['h-1', 'Fresh answer.']]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('keeps a dispatching prompt durable when delivery fails while another prompt is enqueued', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rac-durable-queue-'));
  const queue = new QueuedPromptService(join(directory, 'queue.json'));
  const mutableAgent = stated({ ...agent, title: '⠋ Working' });
  const pasted: string[] = [];
  let capture = ['› Active prompt', '', '• Working'].join('\n');
  let deliveryResult = false;
  let releasePaste: (() => void) | undefined;
  let pasteStarted: (() => void) | undefined;
  const started = new Promise<void>(resolve => { pasteStarted = resolve; });
  const blocked = new Promise<void>(resolve => { releasePaste = resolve; });
  const discovery = { worktreesNow: () => [], target: async () => ({ agent: mutableAgent, socket }) };
  const tmux = {
    pastePrompt: async (_socket: unknown, _pane: string, _buffer: string, prompt: string) => {
      pasted.push(prompt.trimEnd());
      pasteStarted?.();
      await blocked;
      // expose the draft after tmux accepts the paste
      if (deliveryResult) capture = `› ${prompt}`;
      return deliveryResult;
    },
    capture: async () => capture,
    sendKeys: async () => { capture = '› '; return true; }
  };
  const service = new PromptService(discovery as never, tmux as never, undefined, queue);
  try {
    await expect(service.submit(agent.id, 'First durable prompt')).resolves.toBe(true);
    await expect(service.submit(agent.id, 'Second durable prompt')).resolves.toBe(true);

    capture = ['› Active prompt', '', '• Completed successfully', '', '─ Worked for 1s', ''].join('\n');
    mutableAgent.title = 'Ready';
    const dispatch = service.observe(mutableAgent);
    await started;
    await expect(new QueuedPromptService(join(directory, 'queue.json')).list(`agent:${agent.id}`)).resolves.toMatchObject([
      { text: 'First durable prompt' },
      { text: 'Second durable prompt' }
    ]);
    await expect(service.submit(agent.id, 'Concurrently queued prompt')).resolves.toBe(true);
    releasePaste?.();
    await dispatch;

    await expect(new QueuedPromptService(join(directory, 'queue.json')).list(`agent:${agent.id}`)).resolves.toMatchObject([
      { text: 'First durable prompt' },
      { text: 'Second durable prompt' },
      { text: 'Concurrently queued prompt' }
    ]);

    deliveryResult = true;
    await service.observe(mutableAgent);
    expect(pasted).toEqual(['First durable prompt', 'First durable prompt']);
    await expect(service.listQueued(agent.id)).resolves.toMatchObject([
      { text: 'Second durable prompt' },
      { text: 'Concurrently queued prompt' }
    ]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// a reported-state Adapter with no Turn capture (stands in for Claude/Pi)
const turnlessReported = {
  stateSource: 'reported',
  submission: {
    prepare: (text: string) => ({ text, keys: ['Enter'] }),
    interrupt: ['Escape', 'C-c'],
    selectOption: (index: number) => [...Array.from({ length: index }, () => 'Down'), 'Enter'],
  },
};

it('submits a Turn-less prompt with Enter and completes on working then finished', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rac-turnless-'));
  const queue = new QueuedPromptService(join(directory, 'queue.json'));
  const mutableAgent = stated({ ...agent, title: 'Ready' });
  const events: unknown[][] = [];
  const recorded: Array<[string, string]> = [];
  const answered: string[] = [];
  const discovery = { worktreesNow: () => [], target: async () => ({ agent: mutableAgent, socket }) };
  const tmux = {
    pastePrompt: async (_s: unknown, _p: string, _b: string, prompt: string) => { events.push(['paste', prompt]); return true; },
    sendKeys: async (_s: unknown, _p: string, keys: string[]) => { events.push(keys); return true; },
  };
  const history = {
    record: async (scope: string, text: string) => { recorded.push([scope, text]); return { id: 'turnless-entry', text, createdAt: '2026-08-29T00:00:00.000Z' }; },
    recordAnswer: async (_s: string, _e: string, answer: string) => { answered.push(answer); return undefined; },
  };
  const service = new PromptService(discovery as never, tmux as never, history as never, queue, undefined, (() => turnlessReported) as never);
  try {
    await expect(service.submit(agent.id, 'Ship it')).resolves.toBe(true);
    // Enter, never Tab; the paste is the prompt verbatim
    expect(events).toEqual([['paste', 'Ship it'], ['Enter']]);
    // the prompt is stored without an answer to wait for
    expect(recorded).toEqual([['agent:socket:%1', 'Ship it']]);

    mutableAgent.title = '⠋ Working';
    await service.observe(mutableAgent);
    mutableAgent.title = 'Ready';
    await service.observe(mutableAgent);

    // completion captures no answer and releases the (empty) queue
    expect(answered).toEqual([]);
    await expect(service.listQueued(agent.id)).resolves.toEqual([]);

    // the phase cleared: a follow-up prompt on the now-idle agent sends immediately, not queued
    events.length = 0;
    await expect(service.submit(agent.id, 'Again')).resolves.toBe(true);
    expect(events).toEqual([['paste', 'Again'], ['Enter']]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('dispatches a queued Turn-less prompt only once the Agent is finished', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rac-turnless-queue-'));
  const queue = new QueuedPromptService(join(directory, 'queue.json'));
  const mutableAgent = stated({ ...agent, title: '⠋ Working' });
  const dispatched: string[] = [];
  const discovery = { worktreesNow: () => [], target: async () => ({ agent: mutableAgent, socket }) };
  const tmux = { pastePrompt: async (_s: unknown, _p: string, _b: string, prompt: string) => { dispatched.push(prompt); return true; }, sendKeys: async () => true };
  const service = new PromptService(discovery as never, tmux as never, undefined, queue, undefined, (() => turnlessReported) as never);
  try {
    await queue.enqueue('agent:socket:%1', 'Later prompt');
    // working: adopt the queue but never dispatch
    await service.observe(mutableAgent);
    expect(dispatched).toEqual([]);
    // finished: release the queue
    mutableAgent.title = 'Ready';
    await service.observe(mutableAgent);
    expect(dispatched).toEqual(['Later prompt']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('fails a reported dispatch that never reports working within the window', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rac-turnless-fail-'));
  const queue = new QueuedPromptService(join(directory, 'queue.json'));
  const { drained, drain } = drainRecorder();
  const mutableAgent = stated({ ...agent, title: 'Ready' });   // the paste landed in a dialog: never works
  const discovery = { worktreesNow: () => [], target: async () => ({ agent: mutableAgent, socket }) };
  const tmux = { pastePrompt: async () => true, sendKeys: async () => true };
  const service = new PromptService(discovery as never, tmux as never, undefined, queue, drain, (() => turnlessReported) as never);
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    const start = Date.now();
    await service.submit(agent.id, 'Into a dialog');   // sent, now awaiting a working report
    await service.submit(agent.id, 'Behind it');       // held behind the in-flight prompt
    // still finished, still inside the window: keep waiting
    await service.observe(mutableAgent);
    await expect(service.listQueued(agent.id)).resolves.toMatchObject([{ text: 'Behind it' }]);
    // the window (5s) elapses with no working report: fail the dispatch and drain the queue
    vi.setSystemTime(start + 6_000);
    await service.observe(mutableAgent);
    expect(drained).toMatchObject([{ text: 'Behind it' }]);
    await expect(service.listQueued(agent.id)).resolves.toEqual([]);
  } finally {
    vi.useRealTimers();
    await rm(directory, { recursive: true, force: true });
  }
});

it('refuses to interrupt an already finished agent', async () => {
  const keys: string[] = [];
  const discovery = { worktreesNow: () => [], target: async () => ({ agent: stated({ ...agent, title: 'Ready' }), socket }) };
  const tmux = { sendKeys: async (_s: unknown, _p: string, sent: string[]) => { keys.push(...sent); return true; }, setReportedAttention: async () => true };
  const service = new PromptService(discovery as never, tmux as never);
  await expect(service.cancel(agent.id)).resolves.toBe('not-working');
  expect(keys).toEqual([]);
});

it('interrupts a reported Agent and writes finished on its pane', async () => {
  const keys: string[] = [];
  const attention: Array<[string, string]> = [];
  const discovery = { worktreesNow: () => [], target: async () => ({ agent: stated({ ...agent, title: '⠋ Working' }), socket }) };
  const tmux = {
    sendKeys: async (_s: unknown, _p: string, sent: string[]) => { keys.push(...sent); return true; },
    setReportedAttention: async (_s: unknown, pane: string, state: string) => { attention.push([pane, state]); return true; },
  };
  const service = new PromptService(discovery as never, tmux as never, undefined, undefined, undefined, (() => turnlessReported) as never);
  await expect(service.cancel(agent.id)).resolves.toBe('ok');
  expect(keys).toEqual(['Escape', 'C-c']);
  expect(attention).toEqual([['%1', 'finished']]);
});

it('confirms a numbered choice with the Adapter option-select keys on the discovered pane', async () => {
  const sent: string[][] = [];
  // the live pane shows the parsed numbered list; its id is re-derived here
  const capture = ['› pick', '', 'Which environment?', '', '1. Staging', '2. Production', '3. Cancel', '', '› '].join('\n');
  const discovery = { worktreesNow: () => [], target: async () => ({ agent, socket }) };
  const tmux = { capture: async () => capture, sendKeys: async (_s: unknown, pane: string, keys: string[]) => { sent.push([pane, ...keys]); return true; } };
  const service = new PromptService(discovery as never, tmux as never);
  const id = inlineQuestionId('Which environment?', ['Staging', 'Production', 'Cancel']);
  // preserve first-row fallback when the numbered list has no visible cursor
  await expect(service.answerQuestion(agent.id, id, 2)).resolves.toBe(true);
  expect(sent).toEqual([['%1', 'Down', 'Down', 'Enter']]);
  // a stale id (the agent moved past this question) is refused
  await expect(service.answerQuestion(agent.id, 'a-stale-question-id000', 2)).resolves.toBe(false);
});

// read the cursor again at answer time rather than assuming the first option
it('answers a Codex menu relative to its fresh highlight without changing its question id', async () => {
  const sent: string[][] = [];
  let capture = 'Select Model and Effort\n  1. First model\n› 2. Second model\n  3. Third model';
  // resolve the same agent before and after the capture
  const discovery = { worktreesNow: () => [], target: async () => ({ agent, socket }) };
  const tmux = {
    // provide the latest menu cursor
    capture: async () => capture,
    // record only the answer keys sent to the discovered pane
    sendKeys: async (_s: unknown, pane: string, keys: string[]) => { sent.push([pane, ...keys]); return true; }
  };
  const service = new PromptService(discovery as never, tmux as never);
  const id = inlineQuestionId('Select Model and Effort', ['First model', 'Second model', 'Third model']);
  await expect(service.answerQuestion(agent.id, id, 0)).resolves.toBe(true);
  expect(sent).toEqual([['%1', 'Up', 'Enter']]);
  // a terminal cursor move preserves the question but changes the required keys
  capture = 'Select Model and Effort\n  1. First model\n  2. Second model\n› 3. Third model';
  await expect(service.answerQuestion(agent.id, id, 1)).resolves.toBe(true);
  expect(sent[1]).toEqual(['%1', 'Up', 'Enter']);
  // cursor-aware answering still rejects stale or out-of-range clicks
  await expect(service.answerQuestion(agent.id, 'stale-question', 0)).resolves.toBe(false);
  await expect(service.answerQuestion(agent.id, id, 3)).resolves.toBe(false);
  expect(sent).toHaveLength(2);
});

it('answers a Claude reported question by re-deriving it from a fresh payload and capture', async () => {
  const sent: string[][] = [];
  const claudeAgent = { id: 'socket:%1', pane: { paneId: '%1' }, home: '/tmp', kind: 'claude' as const, title: '' };
  const payload = Buffer.from(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Deploy where?', options: [{ label: 'Staging' }, { label: 'Production' }], multiSelect: false }] } })).toString('base64');
  const capture = [' ☐ Target', '│ Deploy where?', '❯ 1. Staging', '  2. Production', '  3. Type something.'].join('\n');
  const discovery = { worktreesNow: () => [], target: async () => ({ agent: claudeAgent, socket }), reportedQuestionPayload: () => payload };
  const tmux = { capture: async () => capture, sendKeys: async (_s: unknown, pane: string, keys: string[]) => { sent.push([pane, ...keys]); return true; } };
  const service = new PromptService(discovery as never, tmux as never);
  const id = inlineQuestionId('Deploy where?', ['Staging', 'Production']);
  // Claude highlights the first option, so index 1 (Production) is one Down then Enter
  await expect(service.answerQuestion(claudeAgent.id, id, 1)).resolves.toBe(true);
  expect(sent).toEqual([['%1', 'Down', 'Enter']]);
  // a stale id, or an index past the choices, is refused
  await expect(service.answerQuestion(claudeAgent.id, 'a-stale-question-id000', 1)).resolves.toBe(false);
  await expect(service.answerQuestion(claudeAgent.id, id, 5)).resolves.toBe(false);
});

it('refuses a Claude reported answer once the payload is cleared', async () => {
  const claudeAgent = { id: 'socket:%1', pane: { paneId: '%1' }, home: '/tmp', kind: 'claude' as const, title: '' };
  const id = inlineQuestionId('Deploy where?', ['Staging', 'Production']);
  // PostToolUse cleared @rac_question: no payload, so nothing is re-derived
  const discovery = { worktreesNow: () => [], target: async () => ({ agent: claudeAgent, socket }), reportedQuestionPayload: () => undefined };
  const tmux = { capture: async () => 'irrelevant', sendKeys: async () => true };
  const service = new PromptService(discovery as never, tmux as never);
  await expect(service.answerQuestion(claudeAgent.id, id, 0)).resolves.toBe(false);
});

it('dismisses composer autocomplete before queuing a skill or plugin prompt',async()=>{const pasted:string[]=[];const discovery={worktreesNow:()=>[],target:async()=>({agent,socket})};const tmux={pastePrompt:async(_s:unknown,_p:string,_b:string,p:string)=>{pasted.push(p);return true},sendKeys:async()=>true};const service=new PromptService(discovery as never,tmux as never);await expect(service.submit(agent.id,'Use $my-plugin')).resolves.toBe(true);await expect(service.submit(agent.id,'/skill already resolved ')).resolves.toBe(true);expect(pasted).toEqual(['Use $my-plugin ','/skill already resolved '])});it('does not queue a stale target',async()=>{let count=0;const discovery={worktreesNow:()=>[],target:async()=>++count===1?{agent,socket}:undefined};const tmux={pastePrompt:async()=>true,sendKeys:async()=>true};const service=new PromptService(discovery as never,tmux as never);await expect(service.submit(agent.id,'synthetic')).resolves.toBe(false)});it('sends Ctrl-C only to the discovered agent pane',async()=>{const calls:string[][]=[];const discovery={worktreesNow:()=>[],target:async()=>({agent:stated({...agent,title:'⠋ Working'}),socket})};const tmux={sendKeys:async(_s:unknown,p:string,keys:string[])=>{if(keys.includes('C-c'))calls.push(['interrupt',p]);return true}};const service=new PromptService(discovery as never,tmux as never);await expect(service.cancel(agent.id)).resolves.toBe('ok');expect(calls).toEqual([['interrupt','%1']])});it('kills only the discovered pane when deleting an agent',async()=>{const calls:string[][]=[];const discovery={worktreesNow:()=>[],target:async()=>({agent,socket})};const tmux={close:async(_s:unknown,p:string)=>{calls.push(['close',p]);return true}};const service=new PromptService(discovery as never,tmux as never);await expect(service.close(agent.id)).resolves.toBe(true);expect(calls).toEqual([['close','%1']])})});

describe('adapter teardown',()=>{
it('runs the configured teardown in the stopped agent home after a successful kill',async()=>{const calls:string[][]=[];const discovery={worktreesNow:()=>[],target:async()=>({agent,socket})};const tmux={close:async()=>true,runShell:async(s:{path:string},command:string)=>{calls.push(['run-shell',s.path,command]);return true}};const service=new PromptService(discovery as never,tmux as never,undefined,undefined,undefined,undefined,kind=>kind==='codex'?'rm -f .omx/state/session.json':undefined);await expect(service.close(agent.id)).resolves.toBe(true);expect(calls).toEqual([['run-shell','/tmp/sock',"cd -- '/tmp' && eval 'rm -f .omx/state/session.json'"]])});
it('issues no teardown for an unconfigured kind or a failed kill',async()=>{const ran:string[]=[];const discovery={worktreesNow:()=>[],target:async()=>({agent,socket})};const unconfigured=new PromptService(discovery as never,{close:async()=>true,runShell:async(_s:unknown,command:string)=>{ran.push(command);return true}} as never);await expect(unconfigured.close(agent.id)).resolves.toBe(true);const failing=new PromptService(discovery as never,{close:async()=>false,runShell:async(_s:unknown,command:string)=>{ran.push(command);return true}} as never,undefined,undefined,undefined,undefined,()=>'rm -f x');await expect(failing.close(agent.id)).resolves.toBe(false);expect(ran).toEqual([])});
it('logs a failing teardown and still reports the stop as successful',async()=>{const errors=vi.spyOn(console,'error').mockImplementation(()=>{});try{const discovery={worktreesNow:()=>[],target:async()=>({agent,socket})};const service=new PromptService(discovery as never,{close:async()=>true,runShell:async()=>{throw new Error('boom')}} as never,undefined,undefined,undefined,undefined,()=>'rm -f x');await expect(service.close(agent.id)).resolves.toBe(true);expect(errors).toHaveBeenCalledWith(expect.stringContaining('teardown failed'))}finally{errors.mockRestore()}});
});
