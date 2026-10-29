import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PromptService } from '../src/prompts/service.js';
import { QueuedPromptService } from '../src/prompts/queue.js';
import { PromptHistoryService } from '../src/prompt-history/service.js';
import { codexAdapter } from '../src/adapters/codex.js';
import { stated } from './helpers/agent.js';

const socket = { fingerprint: 'socket', path: '/tmp/sock', device: 1, inode: 1 };
const composerBackground = '\x1b[48;2;24;25;28m';
const resetBackground = '\x1b[49m';
// style one codex particle cell
const animatedSparkle = (dot: string) => `\x1b[38;2;255;220;96m${dot}\x1b[39m`;
// wrap one rgb composer row
const composerRow = (text: string) => `${composerBackground}${text}${resetBackground}`;

// Regression for the reported bug: Codex's Tab submit was intermittently swallowed
// by a composer that had not yet rendered the paste. The prompt then never started,
// and observe() relocated the queued prompt behind it into saved prompts (the badge
// vanished, nothing reached Codex). send() now settles the paste in the composer
// before pressing the submit key, and holds the scope so a quick second submit
// queues behind the first instead of double-pasting during the settle.
describe('interactive submit settle', () => {
  // keep scratch attachments in a shared namespace rather than a container-only home
  it.each([false, true])('delivers an existing Scratch queue with inaccessible home=%s through shared staging', async inaccessible => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-scratch-attachment-'));
    const workspace = join(directory, 'checkout');
    const home = join(directory, 'host-home');
    await mkdir(workspace);
    // model a missing host mount without relying on the test user's permissions
    if (inaccessible) await writeFile(home, 'container mount placeholder');
    else await mkdir(home);
    const queue = new QueuedPromptService(join(directory, 'queue.json'));
    const history = new PromptHistoryService(join(directory, 'history.json'));
    const agent = stated({ id: 'socket:%1', pane: { paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket' }, home, title: 'Ready', displayLabel: '~ Scratch' });
    const attachment = { name: 'report final.csv', data: Buffer.from('scratch attachment').toString('base64') };
    const hostWorkspace = '/host/console-checkout';
    const pasted: string[] = [];
    const sent: string[][] = [];
    let submitted = false;
    // retain the host agent without a configured worktree
    const discovery = { worktreesNow: () => [], target: async () => ({ agent, socket }) };
    const tmux = {
      // retain the complete host-visible attachment reference
      pastePrompt: async (_socket: unknown, _pane: string, _buffer: string, text: string) => { pasted.push(text); return true; },
      // expose an exact collapsed draft before acceptance
      capture: async () => submitted || pasted.length === 0 ? '› ' : `› [Pasted Content ${[...pasted[0]!].length} chars]`,
      // mark the prompt as actually submitted
      sendKeys: async (_socket: unknown, _pane: string, keys: string[]) => { sent.push(keys); submitted = true; return true; }
    };
    const service = new PromptService(discovery as never, tmux as never, history, queue, undefined, undefined, undefined, { workspace, hostWorkspace });
    try {
      await queue.enqueue(`agent:${agent.id}`, '', [attachment]);
      await service.observe(agent);
      expect(sent).toEqual([['Enter']]);
      expect(pasted[0]).toMatch(/^Attached files:\n@\/host\/console-checkout\/node_modules\/\.remote-agent-console\/attachments\/[^/]+\/report final\.csv /u);
      const relativePath = pasted[0]!.slice(`Attached files:\n@${hostWorkspace}/`.length).trimEnd();
      await expect(readFile(join(workspace, relativePath), 'utf8')).resolves.toBe('scratch attachment');
      await expect(access(join(home, 'node_modules'))).rejects.toThrow();
      await expect(service.listQueued(agent.id)).resolves.toEqual([]);
      await expect(history.list(`agent:${agent.id}`)).resolves.toMatchObject([{ text: pasted[0]!.trimEnd() }]);
    } finally {
      // remove the isolated queue and shared staging fixture
      await rm(directory, { recursive: true, force: true });
    }
  });

  // clean the writer namespace when delivery rejects an absolute host reference
  it('removes shared Scratch staging after a failed paste while retaining the queue', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-scratch-attachment-failure-'));
    const queue = new QueuedPromptService(join(directory, 'queue.json'));
    const agent = stated({ id: 'socket:%1', pane: { paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket' }, home: '/host/unmounted-home', title: 'Ready' });
    // expose an idle unmounted host folder
    const discovery = { worktreesNow: () => [], target: async () => ({ agent, socket }) };
    // reject delivery after the files were staged
    const tmux = { pastePrompt: async () => false };
    const service = new PromptService(discovery as never, tmux as never, undefined, queue, undefined, undefined, undefined, { workspace: directory, hostWorkspace: '/host/console-checkout' });
    try {
      await service.submit(agent.id, '', [{ name: 'image.png', data: Buffer.from('image bytes').toString('base64') }]);
      await expect(service.listQueued(agent.id)).resolves.toMatchObject([{ attachments: [{ name: 'image.png' }] }]);
      await expect(readdir(join(directory, 'node_modules/.remote-agent-console/attachments'))).resolves.toEqual([]);
    } finally {
      // remove the isolated failure fixture
      await rm(directory, { recursive: true, force: true });
    }
  });

  // leave queued attachments durable until their host-visible root is known
  it.each([undefined, 'relative/checkout'])('does not paste Scratch attachments with unresolved host mapping=%s', async hostWorkspace => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-scratch-attachment-unmapped-'));
    const queue = new QueuedPromptService(join(directory, 'queue.json'));
    const agent = stated({ id: 'socket:%1', pane: { paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket' }, home: directory, title: 'Ready' });
    let pasted = false;
    // retain one idle Scratch agent
    const discovery = { worktreesNow: () => [], target: async () => ({ agent, socket }) };
    // record accidental delivery into an unmapped namespace
    const tmux = { pastePrompt: async () => { pasted = true; return true; }, sendKeys: async () => true };
    const service = new PromptService(discovery as never, tmux as never, undefined, queue, undefined, undefined, undefined, { workspace: directory, hostWorkspace });
    try {
      await expect(service.submit(agent.id, '', [{ name: 'image.png', data: Buffer.from('image bytes').toString('base64') }])).resolves.toBe(true);
      expect(pasted).toBe(false);
      await expect(service.listQueued(agent.id)).resolves.toMatchObject([{ attachments: [{ name: 'image.png' }] }]);
      await expect(access(join(directory, 'node_modules'))).rejects.toThrow();
      // text-only prompts must still work when no attachment mapping is available
      const textAgent = { ...agent, id: 'socket:%2', paneId: '%2' };
      const textDiscovery = { worktreesNow: () => [], target: async () => ({ agent: textAgent, socket }) };
      const textService = new PromptService(textDiscovery as never, tmux as never, undefined, queue, undefined, undefined, undefined, { workspace: directory, hostWorkspace });
      await expect(textService.submit(textAgent.id, 'text-only prompt')).resolves.toBe(true);
      expect(pasted).toBe(true);
    } finally {
      // remove the isolated unmapped queue
      await rm(directory, { recursive: true, force: true });
    }
  });

  // deliver attached prompts when the staged path wraps inside the composer
  it.each(['codex', 'omx'] as const)('submits an idle %s attachment prompt with a wrapped staged reference', async kind => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-submit-wrapped-attachment-'));
    const queue = new QueuedPromptService(join(directory, 'queue.json'));
    const history = new PromptHistoryService(join(directory, 'history.json'));
    const agent = stated({ id: 'socket:%1', pane: { paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket' }, kind, home: directory, title: 'Ready' });
    const attachment = { name: 'notes.txt', data: Buffer.from('attachment body').toString('base64') };
    const pasted: string[] = [];
    const sent: string[][] = [];
    let submitted = false;
    // retain one idle pane throughout delivery
    const discovery = { worktreesNow: () => [], target: async () => ({ agent, socket }) };
    const tmux = {
      // retain the complete staged prompt
      pastePrompt: async (_socket: unknown, _pane: string, _buffer: string, text: string) => { pasted.push(text); return true; },
      // reproduce Codex's narrow composer and its acceptance redraw
      capture: async () => submitted ? '› Ask Codex to do anything' : [
        '› Review this attachment.', '', '  Attached files:',
        '  @node_modules/.remote-agent-console/attachments/',
        `  ${pasted[0]!.split('/attachments/')[1]!.trim()}`, '',
        '  GPT-6.1-Sol xhigh fast · ~/repo · main'
      ].join('\n'),
      // acknowledge only the actual submit key
      sendKeys: async (_socket: unknown, _pane: string, keys: string[]) => { sent.push(keys); submitted = true; return true; }
    };
    const service = new PromptService(discovery as never, tmux as never, history, queue);
    try {
      await expect(service.submit(agent.id, 'Review this attachment.', [attachment])).resolves.toBe(true);
      expect(pasted).toHaveLength(1);
      expect(sent).toEqual([['Enter']]);
      await expect(service.listQueued(agent.id)).resolves.toEqual([]);
      await expect(history.list(`agent:${agent.id}`)).resolves.toMatchObject([{ text: pasted[0]!.trimEnd() }]);
    } finally {
      // remove the staged file and durable stores
      await rm(directory, { recursive: true, force: true });
    }
  });

  // trust fresh structured receipts through hidden composers and stale redraws
  it.each([['hidden', false], ['stale', false], ['stale', true]] as const)('records an accepted prompt with a %s composer and delayed receipt=%s instead of recovering it to Notes', async (redraw, delayed) => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-submit-receipt-'));
    const queue = new QueuedPromptService(join(directory, 'queue.json'));
    const history = new PromptHistoryService(join(directory, 'history.json'));
    const agent = stated({ id: 'socket:%1', pane: { paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket' }, home: '/tmp/release', title: 'Ready' });
    const scope = `agent:${agent.id}`;
    const prompt = 'yes, fix it';
    const baseline = { rollout: join(directory, 'rollout.jsonl'), ordinal: 7 };
    const sent: string[][] = [];
    const drained: string[] = [];
    let submitted = false;
    let postSubmitCaptures = 0;
    // publish one exact durable user receipt
    const recordReceipt = async () => writeFile(baseline.rollout, `${JSON.stringify({ type: 'response_item', ordinal: 8, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] } })}\n`);
    // expose the exact pane for the pre-submit baseline
    const discovery = { worktreesNow: () => [], target: async () => ({ agent, socket }), paneProcessId: () => 123 };
    const tmux = {
      // accept the original paste
      pastePrompt: async () => true,
      // hide the live composer or retain its last frame after real acceptance
      capture: async () => {
        // make a delayed receipt available before the first retry boundary
        if (submitted && delayed && ++postSubmitCaptures === 3) await recordReceipt();
        return submitted && redraw === 'hidden' ? `› ${prompt}\n\n• Working` : `› ${prompt} `;
      },
      // mark the receipt only after the submit key
      sendKeys: async (_socket: unknown, _pane: string, keys: string[]) => {
        sent.push(keys);
        submitted = true;
        // allow the initial receipt check to precede the durable log write
        if (!delayed) await recordReceipt();
        return true;
      }
    };
    const adapter = { ...codexAdapter, completion: {
      ...codexAdapter.completion,
      // capture before delivering this turn
      baseline: async () => baseline,
      // finish the submitted turn without waiting for terminal chrome
      since: async () => ({ kind: 'completed', ordinal: 10, answer: 'Fixed.' })
    } };
    // record accidental recovery of already-sent work
    const drain = async (_scope: string, queued: { text: string }) => { drained.push(queued.text); return true; };
    const service = new PromptService(discovery as never, tmux as never, history, queue, drain as never, () => adapter as never);
    // release each independent durable store
    try {
      await expect(service.submit(agent.id, prompt)).resolves.toBe(true);
      expect(sent).toEqual([['Enter']]);
      await expect(history.list(scope)).resolves.toMatchObject([{ text: prompt }]);
      await expect(service.listQueued(agent.id)).resolves.toEqual([]);
      await service.observe(agent);
      expect(drained).toEqual([]);
      await expect(history.list(scope)).resolves.toMatchObject([{ text: prompt, answer: 'Fixed.' }]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  // preserve durable recovery when no fresh exact receipt exists
  it.each(['missing', 'unreadable', 'unresolved'])('does not record a prompt with %s structured acknowledgement and no cleared composer', async receipt => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-submit-no-receipt-'));
    const queue = new QueuedPromptService(join(directory, 'queue.json'));
    const history = new PromptHistoryService(join(directory, 'history.json'));
    const agent = stated({ id: 'socket:%1', pane: { paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket' }, home: '/tmp/release', title: 'Ready' });
    const scope = `agent:${agent.id}`;
    const prompt = 'yes, fix it';
    let submitted = false;
    let receiptQueries = 0;
    const sent: string[][] = [];
    // expose a stable pane but no accepted user record
    const discovery = { worktreesNow: () => [], target: async () => ({ agent, socket }), paneProcessId: () => 123 };
    const tmux = {
      // preserve a durable paste
      pastePrompt: async () => true,
      // model an inconclusive redraw without a receipt
      capture: async () => submitted ? `› ${prompt}\n\n• Working` : `› ${prompt} `,
      // never acknowledge through tmux delivery alone
      sendKeys: async (_socket: unknown, _pane: string, keys: string[]) => { sent.push(keys); submitted = true; return true; }
    };
    const adapter = { ...codexAdapter, completion: {
      // snapshot earlier conversation state
      baseline: async () => receipt === 'unresolved' ? undefined : { rollout: join(directory, 'rollout.jsonl'), ordinal: 7 },
      // no exact new user record was written
      accepted: async () => {
        receiptQueries += 1;
        // retain durable input when the log cannot be read
        if (receipt === 'unreadable') throw new Error('receipt unavailable');
        return false;
      },
      // unrelated completion cannot acknowledge this prompt
      since: async () => ({ kind: 'completed', ordinal: 10, answer: 'An earlier task finished.' })
    } };
    const service = new PromptService(discovery as never, tmux as never, history, queue, undefined, () => adapter as never);
    // release each independent durable store
    try {
      await expect(service.submit(agent.id, prompt)).resolves.toBe(true);
      expect(sent).toEqual([['Enter']]);
      // avoid rollout reads without an exact baseline
      if (receipt === 'unresolved') expect(receiptQueries).toBe(0);
      else {
        // retain the read budget without pinning polling cadence
        expect(receiptQueries).toBeGreaterThan(0);
        expect(receiptQueries).toBeLessThanOrEqual(8);
      }
      await expect(history.list(scope)).resolves.toEqual([]);
      await expect(service.listQueued(agent.id)).resolves.toMatchObject([{ text: prompt }]);
      await service.observe(agent);
      await expect(service.listQueued(agent.id)).resolves.toMatchObject([{ text: prompt }]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('waits for the pasted prompt to render in the composer before submitting', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-submit-settle-'));
    const queue = new QueuedPromptService(join(directory, 'queue.json'));
    const agent = stated({ id: 'socket:%1', pane: { paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket' }, home: '/tmp', title: 'Ready' });
    let captures = 0;
    let capturesAtSubmit = -1;
    let submitted = false;
    const discovery = { worktreesNow: () => [], target: async () => ({ agent, socket }) };
    const tmux = {
      pastePrompt: async () => true,
      // the composer is empty for the first polls, then renders the pasted prompt
      capture: async () => { captures += 1; return submitted || captures < 3 ? '› ' : '› render me '; },
      sendKeys: async () => { capturesAtSubmit = captures; submitted = true; return true; },
    };
    const service = new PromptService(discovery as never, tmux as never, undefined, queue);
    try {
      await queue.enqueue(`agent:${agent.id}`, 'render me');
      await service.observe(agent);
      // the submit key was held until the paste had rendered, not fired against an empty composer
      expect(capturesAtSubmit).toBeGreaterThanOrEqual(3);
      await expect(service.listQueued(agent.id)).resolves.toEqual([]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  // preserve paragraph breaks while waiting for submission
  it('submits a multi-paragraph queued prompt after its complete draft renders', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-submit-multiline-'));
    const queue = new QueuedPromptService(join(directory, 'queue.json'));
    const agent = stated({ id: 'socket:%1', pane: { paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket' }, home: '/tmp', title: 'Ready' });
    const prompt = 'First paragraph.\n\nalpha · beta\n\nReply exactly MULTI_DONE.';
    const sent: string[][] = [];
    let submitted = false;
    // keep one stable target
    const discovery = { worktreesNow: () => [], target: async () => ({ agent, socket }) };
    const tmux = {
      // retain the composed prompt for the live snapshot
      pastePrompt: async () => true,
      // render blank composer rows exactly like Codex
      capture: async () => submitted
        ? ['› First paragraph.', '', '  alpha · beta', '', '  Reply exactly MULTI_DONE.', '', '• Working', '', '› Ask Codex to do anything'].join('\n')
        : ['› First paragraph.', '', '  alpha · beta', '', '  Reply exactly MULTI_DONE.', '', '  gpt-5.6-sol · ~/remoteagents · main'].join('\n'),
      // accept the queued prompt
      sendKeys: async (_socket: unknown, _pane: string, keys: string[]) => { sent.push(keys); submitted = true; return true; }
    };
    const service = new PromptService(discovery as never, tmux as never, undefined, queue);
    try {
      await queue.enqueue(`agent:${agent.id}`, prompt);
      await service.observe(agent);

      expect(sent).toEqual([['Enter']]);
      await expect(service.listQueued(agent.id)).resolves.toEqual([]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  // accept the draft and acknowledgement throughout composer animation
  it('submits a queued prompt through Codex animated sparkle frames', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-submit-sparkles-'));
    const queue = new QueuedPromptService(join(directory, 'queue.json'));
    const agent = stated({ id: 'socket:%1', pane: { paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket' }, home: '/tmp', title: 'Ready' });
    const prompt = 'Explain the cached weather output';
    const sparkles = ['⠁', '⠂', '⠄', '⠈', '⠐', '⠠', '⡀', '⢀'];
    const pasted: string[] = [];
    const sent: string[][] = [];
    const drained: string[] = [];
    let captures = 0;
    let submitted = false;
    // keep one stable target
    const discovery = { worktreesNow: () => [], target: async () => ({ agent, socket }) };
    const tmux = {
      // retain the single bracketed paste
      pastePrompt: async (_socket: unknown, _pane: string, _buffer: string, text: string) => { pasted.push(text.trimEnd()); return true; },
      // animate particles across semantic blank cells on every poll
      capture: async () => {
        const first = animatedSparkle(sparkles[captures % sparkles.length]!);
        const second = animatedSparkle(sparkles[(captures + 3) % sparkles.length]!);
        const third = animatedSparkle(sparkles[(captures + 6) % sparkles.length]!);
        captures += 1;
        // show the sparkled placeholder after Codex accepts the prompt
        if (submitted) return [
          '• Working',
          '',
          composerRow(`    ${second}             ${third}`),
          composerRow(`›${first}Ask${second}Codex${third}to do${first}anything`),
          composerRow(`       ${third} ${first}`),
          '  gpt-6-astra xhigh fast · ~/weather · main'
        ].join('\n');
        return [
          composerRow(`    ${second}             ${third}`),
          composerRow(`›${first}Explain${second}the cached${third}weather output`),
          composerRow(`       ${third} ${first}`),
          '  gpt-6-astra xhigh fast · ~/weather · main'
        ].join('\n');
      },
      // accept the rendered prompt once
      sendKeys: async (_socket: unknown, _pane: string, keys: string[]) => { sent.push(keys); submitted = true; return true; }
    };
    // record any false undelivered transfer
    const drain = async (_scope: string, queued: { text: string }) => { drained.push(queued.text); return true; };
    const service = new PromptService(discovery as never, tmux as never, undefined, queue, drain as never);
    try {
      await expect(service.submit(agent.id, prompt)).resolves.toBe(true);

      expect(pasted).toEqual([prompt]);
      expect(sent).toEqual([['Enter']]);
      await expect(service.listQueued(agent.id)).resolves.toEqual([]);

      await service.observe(agent);
      expect(drained).toEqual([]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  // preserve literal braille as authored input
  it('does not submit when literal Braille replaces expected spaces', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-submit-sparkle-mismatch-'));
    const queue = new QueuedPromptService(join(directory, 'queue.json'));
    const agent = stated({ id: 'socket:%1', pane: { paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket' }, home: '/tmp', title: 'Ready' });
    let submissions = 0;
    // keep one stable target
    const discovery = { worktreesNow: () => [], target: async () => ({ agent, socket }) };
    const tmux = {
      // accept the bracketed paste
      pastePrompt: async () => true,
      // expose literal default-foreground braille in the live draft
      capture: async () => [
        composerRow('› review,⠁commit,⠂and⠄push'),
        '  gpt-6-astra xhigh fast · ~/weather · main'
      ].join('\n'),
      // count accidental submissions
      sendKeys: async () => { submissions += 1; return true; }
    };
    const service = new PromptService(discovery as never, tmux as never, undefined, queue);
    try {
      await expect(service.submit(agent.id, 'review, commit, and push')).resolves.toBe(true);

      expect(submissions).toBe(0);
      await expect(service.listQueued(agent.id)).resolves.toMatchObject([{ text: 'review, commit, and push' }]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  // exclude footer text from durable acknowledgement
  it('does not mistake Codex status text for a live queued draft', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-submit-status-'));
    const queue = new QueuedPromptService(join(directory, 'queue.json'));
    const agent = stated({ id: 'socket:%1', pane: { paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket' }, home: '/tmp', title: 'Ready' });
    let submissions = 0;
    // keep one stable target
    const discovery = { worktreesNow: () => [], target: async () => ({ agent, socket }) };
    const tmux = {
      // model a paste that never reaches the composer
      pastePrompt: async () => true,
      // expose the prompt text only at the start of the footer
      capture: async () => ['› ', '', '  gpt-5.6-sol · ~/remoteagents · main'].join('\n'),
      // count accidental submissions
      sendKeys: async () => { submissions += 1; return true; }
    };
    const service = new PromptService(discovery as never, tmux as never, undefined, queue);
    try {
      await queue.enqueue(`agent:${agent.id}`, 'gpt-5.6-sol');
      await service.observe(agent);

      expect(submissions).toBe(0);
      await expect(service.listQueued(agent.id)).resolves.toMatchObject([{ text: 'gpt-5.6-sol' }]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('queues a quick second submit behind the first while its paste settles', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-submit-settle-race-'));
    const queue = new QueuedPromptService(join(directory, 'queue.json'));
    const agent = stated({ id: 'socket:%1', pane: { paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket' }, home: '/tmp', title: 'Ready' });
    const pasted: string[] = [];
    let releaseRender!: () => void;
    let markReached!: () => void;
    const rendered = new Promise<void>(resolve => { releaseRender = resolve; });
    const reached = new Promise<void>(resolve => { markReached = resolve; });
    let submitted = false;
    const discovery = { worktreesNow: () => [], target: async () => ({ agent, socket }) };
    const tmux = {
      pastePrompt: async (_s: unknown, _p: string, _b: string, prompt: string) => { pasted.push(prompt.trimEnd()); return true; },
      // block the first render check so the second submit arrives mid-settle
      capture: async () => { markReached(); await rendered; return submitted ? '› ' : '› msg1 '; },
      sendKeys: async () => { submitted = true; return true; },
    };
    const service = new PromptService(discovery as never, tmux as never, undefined, queue);
    try {
      await queue.enqueue(`agent:${agent.id}`, 'msg1');
      const first = service.observe(agent);
      await reached;   // msg1 is settling; its scope is held
      await expect(service.submit(agent.id, 'msg2')).resolves.toBe(true);
      // msg2 was not pasted onto the settling composer; it queued behind msg1
      expect(pasted).toEqual(['msg1']);
      await expect(service.listQueued(agent.id)).resolves.toMatchObject([{ text: 'msg1' }, { text: 'msg2' }]);
      releaseRender();
      await expect(first).resolves.toBeUndefined();
      expect(pasted).toEqual(['msg1']);
      await expect(service.listQueued(agent.id)).resolves.toMatchObject([{ text: 'msg2' }]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('does not mistake matching scrollback text for the live composer', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-submit-settle-scrollback-'));
    const queue = new QueuedPromptService(join(directory, 'queue.json'));
    const agent = stated({ id: 'socket:%1', pane: { paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket' }, home: '/tmp', title: 'Ready' });
    let captures = 0;
    let capturesAtSubmit = -1;
    let submitted = false;
    const discovery = { worktreesNow: () => [], target: async () => ({ agent, socket }) };
    const tmux = {
      pastePrompt: async () => true,
      // keep matching text in history while the live composer is still empty
      capture: async () => {
        captures += 1;
        const composer = submitted || captures < 5 ? '› ' : '› repeated prompt ';
        return ['› repeated prompt', '', '• Previous answer', '', composer].join('\n');
      },
      sendKeys: async () => { capturesAtSubmit = captures; submitted = true; return true; }
    };
    const service = new PromptService(discovery as never, tmux as never, undefined, queue);
    try {
      await queue.enqueue(`agent:${agent.id}`, 'repeated prompt');
      await service.observe(agent);
      // require the live composer rather than any matching history row
      expect(capturesAtSubmit).toBeGreaterThanOrEqual(7);
      await expect(service.listQueued(agent.id)).resolves.toEqual([]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('does not submit when only matching prompt history is visible', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-submit-history-only-'));
    const queue = new QueuedPromptService(join(directory, 'queue.json'));
    const agent = stated({ id: 'socket:%1', pane: { paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket' }, home: '/tmp', title: 'Ready' });
    let submissions = 0;
    const discovery = { worktreesNow: () => [], target: async () => ({ agent, socket }) };
    const tmux = {
      pastePrompt: async () => true,
      capture: async () => ['› repeated prompt', '', '• Previous answer', '', '─ Worked for 1s'].join('\n'),
      sendKeys: async () => { submissions += 1; return true; }
    };
    const service = new PromptService(discovery as never, tmux as never, undefined, queue);
    try {
      await queue.enqueue(`agent:${agent.id}`, 'repeated prompt');
      await service.observe(agent);
      expect(submissions).toBe(0);
      await expect(service.listQueued(agent.id)).resolves.toMatchObject([{ text: 'repeated prompt' }]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('chooses the active queue key after the composer settles', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-submit-key-race-'));
    const queue = new QueuedPromptService(join(directory, 'queue.json'));
    const idle = stated({ id: 'socket:%1', pane: { paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket' }, home: '/tmp', title: 'Ready' });
    const working = stated({ ...idle, title: '⠋ Working' });
    let becameWorking = false;
    let submitted = false;
    const sent: string[][] = [];
    const discovery = { worktreesNow: () => [], target: async () => ({ agent: becameWorking ? working : idle, socket }) };
    const tmux = {
      pastePrompt: async () => true,
      // start external work during the settle window
      capture: async () => { becameWorking = true; return submitted ? '› ' : '› follow active work '; },
      sendKeys: async (_socket: unknown, _pane: string, keys: string[]) => { sent.push(keys); submitted = true; return true; }
    };
    const service = new PromptService(discovery as never, tmux as never, undefined, queue);
    try {
      await queue.enqueue(`agent:${idle.id}`, 'follow active work');
      await service.observe(idle);
      expect(sent).toEqual([['Tab']]);
      await expect(service.listQueued(idle.id)).resolves.toEqual([]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('retains a direct prompt when the pane becomes active and Codex swallows Tab', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-submit-direct-race-'));
    const queue = new QueuedPromptService(join(directory, 'queue.json'));
    const idle = stated({ id: 'socket:%1', pane: { paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket' }, home: '/tmp', title: 'Ready' });
    const working = stated({ ...idle, title: '⠋ Working' });
    let targets = 0;
    const sent: string[][] = [];
    // reclassify the target after the initial submit decision
    const discovery = { worktreesNow: () => [], target: async () => ({ agent: targets++ === 0 ? idle : working, socket }) };
    const tmux = {
      pastePrompt: async () => true,
      capture: async () => '› direct race ',
      // model every bounded Tab attempt being swallowed despite successful tmux delivery
      sendKeys: async (_socket: unknown, _pane: string, keys: string[]) => { sent.push(keys); return true; }
    };
    const service = new PromptService(discovery as never, tmux as never, undefined, queue);
    try {
      await expect(service.submit(idle.id, 'direct race')).resolves.toBe(true);
      // exhaust bounded retries before separately guarded clear attempts
      expect(sent.filter(keys => keys.join() === 'Tab').length).toBeGreaterThan(3);
      expect(sent.at(-1)).toEqual(['C-c']);
      await expect(service.listQueued(idle.id)).resolves.toMatchObject([{ text: 'direct race' }]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('retains a durable prompt when Codex leaves it in the composer', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-submit-unaccepted-'));
    const queue = new QueuedPromptService(join(directory, 'queue.json'));
    const agent = stated({ id: 'socket:%1', pane: { paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket' }, home: '/tmp', title: 'Ready' });
    const scope = `agent:${agent.id}`;
    const discovery = { worktreesNow: () => [], target: async () => ({ agent, socket }) };
    const tmux = {
      pastePrompt: async () => true,
      capture: async () => '› durable prompt ',
      // model one swallowed key despite successful tmux delivery
      sendKeys: async () => true
    };
    const service = new PromptService(discovery as never, tmux as never, undefined, queue);
    try {
      await queue.enqueue(scope, 'durable prompt');
      await service.observe(agent);
      await expect(service.listQueued(agent.id)).resolves.toMatchObject([{ text: 'durable prompt' }]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('retries a queued prompt when Codex swallows the first submit key', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-submit-retry-'));
    const queue = new QueuedPromptService(join(directory, 'queue.json'));
    const agent = stated({ id: 'socket:%1', pane: { paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket' }, home: '/tmp', title: 'Ready' });
    const sent: string[][] = [];
    let submitted = false;
    // keep one stable target
    const discovery = { worktreesNow: () => [], target: async () => ({ agent, socket }) };
    const tmux = {
      // accept the paste
      pastePrompt: async () => true,
      // keep the server-owned draft visible until the retry reaches Codex
      capture: async () => submitted ? '› ' : '› retry me ',
      // swallow the first key while the prior turn finishes
      sendKeys: async (_socket: unknown, _pane: string, keys: string[]) => {
        sent.push(keys);
        // accept the retry
        if (sent.length === 2) submitted = true;
        return true;
      }
    };
    const service = new PromptService(discovery as never, tmux as never, undefined, queue);
    // verify retry delivery
    try {
      await queue.enqueue(`agent:${agent.id}`, 'retry me');
      await service.observe(agent);
      expect(sent).toEqual([['Enter'], ['Enter']]);
      await expect(service.listQueued(agent.id)).resolves.toEqual([]);
    } finally {
      // remove test state
      await rm(directory, { recursive: true, force: true });
    }
  });

  // recognize Codex's dedicated shell composer
  it('submits a durable command from Codex shell mode', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-submit-shell-mode-'));
    const queue = new QueuedPromptService(join(directory, 'queue.json'));
    const agent = stated({ id: 'socket:%1', pane: { paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket' }, home: '/tmp', title: 'Ready' });
    const sent: string[][] = [];
    let submitted = false;
    // keep one stable target
    const discovery = { worktreesNow: () => [], target: async () => ({ agent, socket }) };
    const tmux = {
      // accept the shell paste
      pastePrompt: async () => true,
      // render Codex's real shell-mode marker and footer
      capture: async () => submitted
        ? ['• You ran git status', '', '› Ask Codex to do anything', '', '  gpt-5.6-sol · /tmp'].join('\n')
        : ['! git status', '', '  gpt-5.6-sol · /tmp                                      Shell mode'].join('\n'),
      // accept the rendered shell command
      sendKeys: async (_socket: unknown, _pane: string, keys: string[]) => { sent.push(keys); submitted = true; return true; }
    };
    const service = new PromptService(discovery as never, tmux as never, undefined, queue);
    try {
      await queue.enqueue(`agent:${agent.id}`, '!git status');
      await service.observe(agent);

      expect(sent).toEqual([['Enter']]);
      await expect(service.listQueued(agent.id)).resolves.toEqual([]);
    } finally {
      // remove test state
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('retains a durable shell command when Codex leaves it in the composer', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-submit-shell-unaccepted-'));
    const queue = new QueuedPromptService(join(directory, 'queue.json'));
    const agent = stated({ id: 'socket:%1', pane: { paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket' }, home: '/tmp', title: 'Ready' });
    const scope = `agent:${agent.id}`;
    const sent: string[][] = [];
    const discovery = { worktreesNow: () => [], target: async () => ({ agent, socket }) };
    const tmux = {
      pastePrompt: async () => true,
      // keep the actual shell composer visible through every retry
      capture: async () => ['! git status', '', '  gpt-5.6-sol · /tmp                                      Shell mode'].join('\n'),
      // model every bounded Enter attempt being swallowed despite successful tmux delivery
      sendKeys: async (_socket: unknown, _pane: string, keys: string[]) => { sent.push(keys); return true; }
    };
    const service = new PromptService(discovery as never, tmux as never, undefined, queue);
    try {
      await queue.enqueue(scope, '!git status');
      await service.observe(agent);
      // exhaust bounded retries before separately guarded clear attempts
      expect(sent.filter(keys => keys.join() === 'Enter').length).toBeGreaterThan(3);
      expect(sent.at(-1)).toEqual(['C-c']);
      await expect(service.listQueued(agent.id)).resolves.toMatchObject([{ text: '!git status' }]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('submits a durable shell command after its collapsed draft renders', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-submit-shell-collapsed-'));
    const queue = new QueuedPromptService(join(directory, 'queue.json'));
    const agent = stated({ id: 'socket:%1', pane: { paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket' }, home: '/tmp', title: 'Ready' });
    const command = `!${'x'.repeat(33)}`;
    let submitted = false;
    const sent: string[][] = [];
    const discovery = { worktreesNow: () => [], target: async () => ({ agent, socket }) };
    const tmux = {
      pastePrompt: async () => true,
      capture: async () => submitted ? '› ' : `› [Pasted Content ${command.length} chars]`,
      sendKeys: async (_socket: unknown, _pane: string, keys: string[]) => { sent.push(keys); submitted = true; return true; }
    };
    const service = new PromptService(discovery as never, tmux as never, undefined, queue);
    try {
      await queue.enqueue(`agent:${agent.id}`, command);
      await service.observe(agent);
      expect(sent).toEqual([['Enter']]);
      await expect(service.listQueued(agent.id)).resolves.toEqual([]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('uses best-effort durable delivery for an Adapter without draft observation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-submit-generic-adapter-'));
    const queue = new QueuedPromptService(join(directory, 'queue.json'));
    const agent = stated({ id: 'socket:%1', pane: { paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket' }, home: '/tmp', title: 'Ready' });
    let captures = 0;
    const discovery = { worktreesNow: () => [], target: async () => ({ agent, socket }) };
    const tmux = {
      pastePrompt: async () => true,
      capture: async () => { captures += 1; return 'another agent'; },
      sendKeys: async () => true
    };
    const adapter = {
      stateSource: 'title',
      submission: { prepare: (prompt: string) => ({ text: prompt, keys: ['Enter'] }), interrupt: ['C-c'], selectOption: () => ['Enter'] },
      turns: { latestCompleted: () => undefined, lastPrompt: () => undefined, latestMessage: () => undefined, failed: () => false }
    };
    const service = new PromptService(discovery as never, tmux as never, undefined, queue, undefined, () => adapter as never);
    try {
      await queue.enqueue(`agent:${agent.id}`, 'generic prompt');
      await service.observe(agent);
      expect(captures).toBe(0);
      await expect(service.listQueued(agent.id)).resolves.toEqual([]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
