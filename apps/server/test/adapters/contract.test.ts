import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adapters as adaptersUnderTest, adapterFor, structuredAdapters } from '../../src/adapters/registry.js';
import { inlineQuestionId } from '../../src/adapters/inline-questions.js';
import { agentKinds, type AttentionState, type LaunchReadiness, type PaneSnapshot, type ResetSettling, type Submission, type SubmissionMode, type TmuxKey } from '../../src/adapters/types.js';

const fixturesRoot = fileURLToPath(new URL('../fixtures/', import.meta.url));
const has = (kind: string, file: string) => existsSync(join(fixturesRoot, kind, file));
const load = <T>(kind: string, file: string): T => JSON.parse(readFileSync(join(fixturesRoot, kind, file), 'utf8')) as T;

type ProcessFixture = { name: string; comm: string; argv: string[] };
type TitleFixture = { title: string; state: AttentionState };
type PromptFixture = { name: string; prompt: string; mode: SubmissionMode; text: string; keys: TmuxKey[]; idleKeys?: TmuxKey[] };
type CaptureFixture = {
  name: string;
  lines: string[];
  latestCompletedTurn?: { prompt?: string; text: string } | null;
  lastPrompt?: string;
  latestMessage?: string;
  failed: boolean;
};
type QuestionFixture = {
  name: string;
  lines: string[];
  question: { text: string; choices: string[]; source: 'structured' | 'parsed' } | null;
};
type ReportedQuestionFixture = {
  name: string;
  payload: unknown;   // a verbatim PreToolUse hook body; the test base64-encodes it
  lines: string[];    // a raw capture-pane -e -p snapshot
  question: { text: string; choices: string[]; source: 'structured' } | null;
};
type ConversationsFixture = {
  valid: string[];
  invalid: string[];
  // the pinned rename descriptor for this kind: the pasted text and keys for `/rename <name>`
  rename?: { name: string; text: string; keys: TmuxKey[] };
};
type NewConversationFixture = {
  command: string;
  composerEmpty: { name: string; lines: string[]; empty: boolean }[];
  settled: { name: string; before: PaneSnapshot; observed: PaneSnapshot[]; elapsedMs: number; result: ResetSettling }[];
  ready: { name: string; snapshot: PaneSnapshot; lines: string[]; result: LaunchReadiness }[];
};

// The generic key rules every Adapter must obey (spec §"Generic key rules").
function assertNoForbiddenPairs(keys: readonly TmuxKey[], where: string): void {
  for (let i = 1; i < keys.length; i += 1) {
    const pair = `${keys[i - 1]} ${keys[i]}`;
    expect(pair, `${where}: forbidden ${pair}`).not.toBe('Escape Escape');
    expect(pair, `${where}: forbidden ${pair}`).not.toBe('C-c C-c');
  }
}
function assertEnterHasPaste(submission: Submission, where: string): void {
  const submissionKeys = [...submission.keys, ...(submission.idleKeys ?? [])];
  // require paste content for every direct-submit path
  if (submissionKeys.includes('Enter')) {
    expect(submission.text.length, `${where}: Enter sent without a paste`).toBeGreaterThan(0);
  }
}

describe('Adapter contract suite', () => {
  it('every registered adapter kind has a fixture directory', () => {
    for (const adapter of adaptersUnderTest) {
      expect(existsSync(join(fixturesRoot, adapter.kind)), `missing fixtures for ${adapter.kind}`).toBe(true);
    }
  });

  it('registers adapters in agentKinds order, which is the launch and cleanup precedence', () => {
    const registered = adaptersUnderTest.map(adapter => adapter.kind);
    expect(registered).toEqual(agentKinds.filter(kind => registered.includes(kind)));
  });

  for (const adapter of adaptersUnderTest) describe(`${adapter.kind} adapter`, () => {
    it('recognizes exactly its own processes', () => {
      const { match, noMatch } = load<{ match: ProcessFixture[]; noMatch: ProcessFixture[] }>(adapter.kind, 'processes.json');
      for (const p of match) expect(adapter.recognizes({ comm: p.comm, argv: p.argv }), p.name).toBe(true);
      for (const p of noMatch) expect(adapter.recognizes({ comm: p.comm, argv: p.argv }), p.name).toBe(false);
    });

    it('infers attention state from pane titles', () => {
      for (const { title, state } of load<TitleFixture[]>(adapter.kind, 'titles.json')) {
        expect(adapter.inferState({ title }), `title ${JSON.stringify(title)}`).toBe(state);
      }
    });

    it('prepares prompt submissions and keeps the key rules', () => {
      for (const c of load<PromptFixture[]>(adapter.kind, 'prompts.json')) {
        const submission = adapter.submission.prepare(c.prompt, c.mode);
        expect(submission.text, c.name).toBe(c.text);
        expect(submission.keys, c.name).toEqual(c.keys);
        expect(submission.idleKeys, c.name).toEqual(c.idleKeys);
        assertEnterHasPaste(submission, c.name);
        assertNoForbiddenPairs(submission.keys, c.name);
        // validate the optional idle path under the same generic key rules
        if (submission.idleKeys !== undefined) assertNoForbiddenPairs(submission.idleKeys, `${c.name} idle`);
      }
    });

    it('never emits a forbidden key sequence when interrupting or selecting an option', () => {
      assertNoForbiddenPairs(adapter.submission.interrupt, `${adapter.kind} interrupt`);
      for (let index = 0; index <= 4; index += 1) {
        assertNoForbiddenPairs(adapter.submission.selectOption(index), `${adapter.kind} selectOption(${index})`);
      }
    });

    if (has(adapter.kind, 'submission.json')) it('reproduces the interrupt and option-select key sequences', () => {
      const fixture = load<{ interrupt: TmuxKey[]; selectOption: Array<{ index: number; keys: TmuxKey[] }> }>(adapter.kind, 'submission.json');
      expect(adapter.submission.interrupt, `${adapter.kind} interrupt`).toEqual(fixture.interrupt);
      for (const { index, keys } of fixture.selectOption) {
        expect(adapter.submission.selectOption(index), `${adapter.kind} selectOption(${index})`).toEqual(keys);
      }
    });

    const turns = adapter.turns;
    if (turns && has(adapter.kind, 'captures.json')) it('reads turns from raw capture-pane snapshots', () => {
      for (const c of load<CaptureFixture[]>(adapter.kind, 'captures.json')) {
        const capture = c.lines.join('\n');
        expect(turns.failed(capture), `${c.name} · failed`).toBe(c.failed);
        if ('latestCompletedTurn' in c) {
          if (c.latestCompletedTurn === null) expect(turns.latestCompleted(capture), `${c.name} · turn`).toBeUndefined();
          else expect(turns.latestCompleted(capture), `${c.name} · turn`).toMatchObject(c.latestCompletedTurn!);
        }
        if ('lastPrompt' in c) expect(turns.lastPrompt(capture), `${c.name} · lastPrompt`).toBe(c.lastPrompt);
        if ('latestMessage' in c) expect(turns.latestMessage(capture), `${c.name} · latestMessage`).toBe(c.latestMessage);
      }
    });

    const questions = adapter.questions;
    if (questions?.parse && has(adapter.kind, 'questions.json')) it('parses inline questions off raw pane captures', () => {
      for (const c of load<QuestionFixture[]>(adapter.kind, 'questions.json')) {
        const parsed = questions.parse!(c.lines.join('\n'));
        if (c.question === null) { expect(parsed, `${c.name} · none`).toBeUndefined(); continue; }
        expect(parsed, `${c.name} · shape`).toEqual({ ...c.question, id: inlineQuestionId(c.question.text, c.question.choices) });
      }
    });

    if (questions?.reported && has(adapter.kind, 'reported-questions.json')) it('confirms reported questions against raw pane captures', () => {
      for (const c of load<ReportedQuestionFixture[]>(adapter.kind, 'reported-questions.json')) {
        const payload = Buffer.from(JSON.stringify(c.payload)).toString('base64');
        const result = questions.reported!(payload, c.lines.join('\n'));
        if (c.question === null) { expect(result, `${c.name} · none`).toBeUndefined(); continue; }
        expect(result, `${c.name} · shape`).toEqual({ ...c.question, id: inlineQuestionId(c.question.text, c.question.choices) });
      }
    });

    const conversations = adapter.conversations;
    if (conversations && has(adapter.kind, 'conversations.json')) {
      it('validates conversation ids', () => {
        const { valid, invalid } = load<ConversationsFixture>(adapter.kind, 'conversations.json');
        for (const id of valid) expect(conversations.validId(id), `valid ${JSON.stringify(id)}`).toBe(true);
        for (const id of invalid) expect(conversations.validId(id), `invalid ${JSON.stringify(id)}`).toBe(false);
      });

      it('renames the current conversation with an Enter-only descriptor', () => {
        const { rename } = load<ConversationsFixture>(adapter.kind, 'conversations.json');
        // a kind pinned with a rename fixture must implement rename, and vice versa
        expect(conversations.rename !== undefined, `${adapter.kind} rename descriptor`).toBe(rename !== undefined);
        if (rename === undefined || conversations.rename === undefined) return;
        const descriptor = conversations.rename(rename.name);
        expect(descriptor, `${adapter.kind} rename`).toEqual({ text: rename.text, keys: rename.keys });
        // the probe pinned Enter for every Attention state — Tab parks a Codex rename until the turn ends
        expect(descriptor.keys, `${adapter.kind} rename keys`).toEqual(['Enter']);
      });

      // listing depends on reading a Conversation's current name back, so a kind that
      // lists must also implement readName (vacuously true until a kind gains `list`)
      it('implements readName wherever it lists conversations', () => {
        if (conversations.list !== undefined) expect(conversations.readName, `${adapter.kind} readName`).not.toBeUndefined();
      });
    }

    const newConversation = adapter.newConversation;
    // every kind that declares the capability must carry its fixtures (the assertion),
    // and its reset command must be a real entry in its own slash catalog; a kind that
    // omits the capability (Pi, OpenCode) is skipped and the suite stays green
    if (newConversation) it('drives the new-conversation reset and fresh-launch readiness', () => {
      expect(has(adapter.kind, 'new-conversation.json'), `missing new-conversation fixtures for ${adapter.kind}`).toBe(true);
      const fixture = load<NewConversationFixture>(adapter.kind, 'new-conversation.json');
      expect(newConversation.command, `${adapter.kind} command`).toBe(fixture.command);
      expect(adapter.commands?.slash().map(command => command.name), `${adapter.kind} command in slash catalog`).toContain(newConversation.command);
      // each member must actually be exercised — an empty case list would pass vacuously
      expect(fixture.composerEmpty.length, `${adapter.kind} composerEmpty cases`).toBeGreaterThan(0);
      expect(fixture.settled.length, `${adapter.kind} settled cases`).toBeGreaterThan(0);
      expect(fixture.ready.length, `${adapter.kind} ready cases`).toBeGreaterThan(0);
      for (const c of fixture.composerEmpty) expect(newConversation.composerEmpty(c.lines.join('\n')), `${c.name} · composerEmpty`).toBe(c.empty);
      for (const c of fixture.settled) expect(newConversation.settled(c.before, c.observed, c.elapsedMs), `${c.name} · settled`).toBe(c.result);
      for (const c of fixture.ready) expect(newConversation.ready(c.snapshot, c.lines.join('\n')), `${c.name} · ready`).toEqual(c.result);
    });
  });

  // OMX runs the Codex TUI and carries its new-conversation object *by reference* (ADR
  // 0005): the same object, not an equal one. The identity check is the real invariant;
  // the fixture-directory equality guards the on-disk captures from drifting apart.
  it('OMX shares Codex\'s new-conversation object and fixtures', () => {
    expect(adapterFor('omx')?.newConversation).toBe(adapterFor('codex')?.newConversation);
    expect(load('omx', 'new-conversation.json')).toEqual(load('codex', 'new-conversation.json'));
  });

  // a structured kind's Conversation store, read from its fixture store as the kind writes it
  for (const adapter of structuredAdapters) describe(`${adapter.kind} structured adapter`, () => {
    it('accepts only well-formed Conversation ids', () => {
      const { valid, invalid } = load<ConversationsFixture>(adapter.kind, 'conversations.json');
      for (const id of valid) expect(adapter.conversations.validId(id), `valid ${JSON.stringify(id)}`).toBe(true);
      for (const id of invalid) expect(adapter.conversations.validId(id), `invalid ${JSON.stringify(id)}`).toBe(false);
    });
  });

  describe('pi Conversation store', () => {
    afterEach(() => { vi.unstubAllEnvs(); });
    it('lists the Named Conversations started in each folder, those named in a hand-started TUI included, and locates them', async () => {
      const pi = structuredAdapters.find(adapter => adapter.kind === 'pi')!.conversations;
      vi.stubEnv('PI_CODING_AGENT_DIR', join(fixturesRoot, 'pi', 'agent'));
      // unnamed, cleared and header-less session files are not listed; the latest name wins
      expect(await pi.list(['/work/repo'])).toEqual([
        { id: '01a17f2c-1111-7aaa-8bbb-000000000001', name: 'Flaky test, take two', lastActiveAt: Date.parse('2026-10-30T07:00:00.000Z'), directory: '/work/repo' },
        { id: '01a188d1-e7d9-711a-aba8-381b96066aa5', name: 'Fix the parser', lastActiveAt: Date.parse('2026-10-29T18:00:31.000Z'), directory: '/work/repo' }
      ]);
      expect((await pi.list(['/work/repo/sub'])).map(row => row.name)).toEqual(['In the subfolder']);
      expect(await pi.readName('01a17f2c-1111-7aaa-8bbb-000000000001', '/work/repo')).toBe('Flaky test, take two');
      expect(await pi.readName('01a16000-3333-7aaa-8bbb-000000000003', '/work/repo')).toBeUndefined();
      expect(await pi.readName('01a17f2c-1111-7aaa-8bbb-000000000001')).toBeUndefined();
      expect(await pi.locate('01a188d1-e7d9-711a-aba8-381b96066aa5', '/work/repo')).toBe(join(fixturesRoot, 'pi', 'agent', 'sessions', '--work-repo--', '2026-10-29T18-00-20-186Z_01a188d1-e7d9-711a-aba8-381b96066aa5.jsonl'));
      expect(await pi.locate('01a188d1-e7d9-711a-aba8-381b96066aa5', '/work/repo/sub')).toBeUndefined();
    });
  });

  it('pi launches on its Allowed models, and resumes a Conversation on the model it was on', () => {
    const pi = structuredAdapters.find(adapter => adapter.kind === 'pi')!;
    // after the pinned CLI, `--mode rpc` and the RAC extension
    const own = (input: Parameters<typeof pi.launch>[0]) => pi.launch(input).args.slice(5);
    expect(own({ cwd: '/work/repo', sandboxed: false })).toEqual([]);
    expect(own({ cwd: '/work/repo', sandboxed: false, models: { allowed: ['openai/gpt-5.6', 'openrouter/~anthropic/claude-opus-latest'], start: { model: 'openai/gpt-5.6', effort: 'high' } } }))
      .toEqual(['--models', 'openai/gpt-5.6,openrouter/~anthropic/claude-opus-latest', '--model', 'openai/gpt-5.6', '--thinking', 'high']);
    expect(own({ cwd: '/work/repo', sandboxed: false, resume: '/sessions/a.jsonl', models: { allowed: ['openai/gpt-5.6'], start: { model: 'openai/gpt-5.6' } } }))
      .toEqual(['--models', 'openai/gpt-5.6', '--session', '/sessions/a.jsonl']);
  });
});
