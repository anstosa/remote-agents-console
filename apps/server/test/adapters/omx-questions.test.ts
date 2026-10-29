import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inlineQuestionId } from '../../src/adapters/inline-questions.js';
import { pendingOmxQuestion } from '../../src/adapters/omx-questions.js';

describe('pendingOmxQuestion', () => {
  const record = (over: Record<string, unknown> = {}) => JSON.stringify({
    kind: 'omx.question/v1', question_id: 'question-test', status: 'prompting',
    question: 'Choose one?', options: [{ label: 'Yes' }, { label: 'No' }],
    renderer: { target: '%22', return_target: '%1' }, ...over
  });
  const withQuestionFile = async (contents: string, run: (workspace: string) => Promise<void>) => {
    const workspace = await mkdtemp(join(tmpdir(), 'rac-omx-q-'));
    try {
      const questions = join(workspace, '.omx', 'state', 'sessions', 'session', 'questions');
      await mkdir(questions, { recursive: true });
      await writeFile(join(questions, 'q.json'), contents);
      await run(workspace);
    } finally { await rm(workspace, { recursive: true, force: true }); }
  };

  it('reads a pending question addressed at the pane into the unified shape', async () => {
    await withQuestionFile(record(), async workspace => {
      await expect(pendingOmxQuestion(workspace, '%1')).resolves.toEqual({
        id: inlineQuestionId('Choose one?', ['Yes', 'No']), text: 'Choose one?', choices: ['Yes', 'No'], source: 'structured', pane: { targetPaneId: '%22' }
      });
    });
  });

  it('ignores a question addressed at another pane', async () => {
    await withQuestionFile(record({ renderer: { target: '%22', return_target: '%9' } }), async workspace => {
      await expect(pendingOmxQuestion(workspace, '%1')).resolves.toBeUndefined();
    });
  });

  it('ignores a resolved question', async () => {
    await withQuestionFile(record({ status: 'answered' }), async workspace => {
      await expect(pendingOmxQuestion(workspace, '%1')).resolves.toBeUndefined();
    });
  });

  it('ignores a question with fewer than two choices', async () => {
    await withQuestionFile(record({ options: [{ label: 'Only' }] }), async workspace => {
      await expect(pendingOmxQuestion(workspace, '%1')).resolves.toBeUndefined();
    });
  });

  it('resolves to undefined when the workspace has no question files', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'rac-omx-noq-'));
    try {
      await expect(pendingOmxQuestion(workspace, '%1')).resolves.toBeUndefined();
    } finally { await rm(workspace, { recursive: true, force: true }); }
  });
});
