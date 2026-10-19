import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { promptNoteContent } from '../src/notes/from-prompt.js';

describe('promptNoteContent', () => {
  const at = new Date(2026, 8, 7, 9, 5);

  // include the local date and compact twelve-hour time before the prompt preview
  it('titles the note with the date, worktree and quoted prompt', () => {
    expect(promptNoteContent('Renamed Cora', at, { text: 'Summarize the branch.' }))
      .toEqual({ title: "09/07 9:05am in Renamed Cora: 'Summarize the branch.'", text: 'Summarize the branch.' });
    expect(promptNoteContent('Renamed Cora', new Date(2026, 8, 7, 13, 5), { text: 'Afternoon prompt.' }).title)
      .toBe("09/07 1:05pm in Renamed Cora: 'Afternoon prompt.'");
    expect(promptNoteContent('Renamed Cora', new Date(2026, 8, 7, 12, 5), { text: 'Noon prompt.' }).title)
      .toBe("09/07 12:05pm in Renamed Cora: 'Noon prompt.'");
    expect(promptNoteContent('Renamed Cora', new Date(2026, 8, 7, 0, 5), { text: 'Midnight prompt.' }).title)
      .toBe("09/07 12:05am in Renamed Cora: 'Midnight prompt.'");
  });

  // exercise the real process timezone independently of the test worker's zone
  it.each([
    ['UTC', '2026-09-22T15:05:00Z', '09/22 3:05pm'],
    ['America/Los_Angeles', '2026-09-22T15:05:00Z', '09/22 8:05am'],
    ['America/Los_Angeles', '2026-01-22T15:05:00Z', '01/22 7:05am'],
    ['Asia/Tokyo', '2026-09-22T15:05:00Z', '09/23 12:05am']
  ])('formats %s server-local date and time for %s', (timeZone, instant, expected) => {
    const script = `import { promptNoteContent } from './src/notes/from-prompt.ts';
      console.log(promptNoteContent('workspace', new Date(process.argv[1]), { text: 'Queued prompt' }).title);`;
    const title = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, instant], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, TZ: timeZone },
      encoding: 'utf8'
    }).trim();
    expect(title).toBe(`${expected} in workspace: 'Queued prompt'`);
  });

  // reserve punctuation and the worktree name inside the complete title budget
  it('truncates a long prompt to an eighty-character title', () => {
    const text = 'x'.repeat(200);
    const content = promptNoteContent('🥔 Flowchart', new Date(2026, 9, 18, 19, 37), { text });
    expect(content.title).toBe(`10/18 7:37pm in 🥔 Flowchart: '${'x'.repeat(45)}...'`);
    expect(content.title).toHaveLength(80);
    expect(content.text).toBe(text);
  });

  // do not add an ellipsis to a prompt that fits exactly
  it('keeps the complete prompt when the title reaches the limit without truncation', () => {
    const text = 'x'.repeat(48);
    const content = promptNoteContent('🥔 Flowchart', new Date(2026, 9, 18, 19, 37), { text });
    expect(content.title).toBe(`10/18 7:37pm in 🥔 Flowchart: '${text}'`);
    expect(content.title).toHaveLength(80);
  });

  // flatten only the preview while retaining the original note body
  it('keeps multiline prompts readable on one title line', () => {
    const text = '  Review this.\n\nThen\t explain it.  ';
    expect(promptNoteContent('cora', at, { text }))
      .toEqual({ title: "09/07 9:05am in cora: 'Review this. Then explain it.'", text });
  });

  // never leave half of an emoji at the truncation boundary
  it('preserves complete emoji when shortening a prompt preview', () => {
    const text = `${'x'.repeat(44)}🧪${'x'.repeat(20)}`;
    const content = promptNoteContent('🥔 Flowchart', new Date(2026, 9, 18, 19, 37), { text });
    expect(content.title).toBe(`10/18 7:37pm in 🥔 Flowchart: '${'x'.repeat(44)}...'`);
    expect(content.title.length).toBeLessThanOrEqual(80);
  });

  // retain queued attachment bytes with the note content
  it('carries attachments beside the original text', () => {
    const attachments = [{ name: 'context.txt', data: 'YQ==' }, { name: 'diff.patch', data: 'Yg==' }];
    expect(promptNoteContent('cora', at, { text: 'Review this.', attachments }))
      .toEqual({ title: "09/07 9:05am in cora: 'Review this.'", text: 'Review this.', attachments });
  });

  // preserve attachment-only prompts without synthesizing text
  it('keeps attachment-only prompt text empty', () => {
    const attachments = [{ name: 'shot.png', data: 'YQ==' }];
    expect(promptNoteContent('scratch', at, { text: '', attachments }))
      .toEqual({ title: "09/07 9:05am in scratch: ''", text: '', attachments });
  });

  // shorten oversized worktree labels without hiding a complete short prompt
  it('keeps a short prompt visible beside a long worktree label', () => {
    const content = promptNoteContent('x'.repeat(200), at, { text: 'Keep this.' });
    expect(content.title).toHaveLength(80);
    expect(content.title).toMatch(/^09\/07 9:05am in x+: 'Keep this\.'$/u);
  });

  // reserve enough prompt context to distinguish notes from the same long-named worktree
  it('retains twenty preview characters when both name and prompt are long', () => {
    const text = 'First useful context and more prompt details beyond the title budget.';
    const content = promptNoteContent('x'.repeat(120), at, { text });
    expect(content.title).toHaveLength(80);
    expect(content.title).toMatch(/^09\/07 9:05am in x+: 'First useful context\.\.\.'$/u);
    expect(content.text).toBe(text);
  });

  // use a readable worktree fallback when its name is blank
  it('falls back to workspace for a blank worktree label', () => {
    expect(promptNoteContent('  ', at, { text: 'Keep this.' }).title)
      .toBe("09/07 9:05am in workspace: 'Keep this.'");
  });
});
