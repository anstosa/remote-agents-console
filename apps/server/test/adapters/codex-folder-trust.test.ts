import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { codexAdapter } from '../../src/adapters/codex.js';
import { omxAdapter } from '../../src/adapters/omx.js';
import { inlineQuestionId } from '../../src/adapters/inline-questions.js';

const { lines } = JSON.parse(readFileSync(new URL('../fixtures/codex/folder-trust.json', import.meta.url), 'utf8')) as { lines: string[] };
const capture = lines.join('\n');
const text = 'Do you trust /workspaces/example?';
const choices = ['Trust and continue', 'Quit'];
const detail = 'Trust this folder? Codex can read, edit, and run files here, subject to your permission settings. Folder settings can run code automatically, even without a model request. Continue only if you trust these files. Your trust decision will be saved.';
const unsupportedCaptures = JSON.parse(readFileSync(new URL('../fixtures/codex/folder-trust-unsupported.json', import.meta.url), 'utf8')) as Array<{ name: string; lines: string[] }>;

// codex and omx share the native permission parser and startup readiness policy
for (const adapter of [codexAdapter, omxAdapter]) {
  describe(`${adapter.kind} folder trust`, () => {
    // the default native highlight is not an answer or permission grant
    it('exposes the complete folder warning as an operator permission', () => {
      expect(adapter.questions.parse(capture)).toEqual({ id: inlineQuestionId(text, choices), text, detail, choices, permission: true, source: 'parsed', pane: { selectedIndex: 0 } });
    });

    // wrapping and cursor changes must preserve the permission identity
    it('retains the same folder and warning after styling and highlight changes', () => {
      const wide = capture.replace(/here,\n  subject/u, 'here, subject').replace('› 1.', '  1.').replace('  2.', '› 2.')
        .replace('/workspaces/example', '\x1b[1m/workspaces/example\x1b[0m');
      expect(adapter.questions.parse(wide)).toEqual({ id: inlineQuestionId(text, choices), text, detail, choices, permission: true, source: 'parsed', pane: { selectedIndex: 1 } });
    });

    // folder consent must not carry across another workspace or normalized punctuation
    it.each(['/workspaces/other', '/workspaces/pipe|folder'])('binds the permission to %s', folder => {
      const changedText = `Do you trust ${folder}?`;
      expect(adapter.questions.parse(capture.replace('/workspaces/example', folder))).toMatchObject({ text: changedText, id: inlineQuestionId(changedText, choices) });
    });

    // malformed trust menus must not fall back to unprivileged generic choice parsing
    it.each([
      capture.replace('Folder access', ''),
      capture.replace('/workspaces/example', ''),
      capture.replace('/workspaces/example', 'relative/folder'),
      capture.replace('/workspaces/example', '/workspaces/ex…mple'),
      capture.replace('Folder settings can run code\n  automatically, even without a model request.', ''),
      capture.replace('subject to your permission settings.', 'without permission checks.'),
      capture.replace('Your trust decision will be saved.', ''),
      capture.replace('Trust and continue', 'Trust and continue and create sandbox'),
      capture.replace('2. Quit', '2. Back'),
      capture.replace('› 1.', '  1.'),
      capture.replace('  2.', '› 2.'),
      capture.replace('enter continue · esc quit', 'Press enter to confirm'),
      capture.replace('enter continue · esc quit', ''),
      capture.replace('\n› 1.', '\n  Repository root: /workspaces\n› 1.')
    ])('fails closed on an unsupported trust surface %#', value => {
      expect(adapter.questions.parse(value)).toBeUndefined();
    });

    // resolved native startup chrome must not suppress a newer ordinary question
    it('retires a trust dialog when newer output or another question follows', () => {
      expect(adapter.questions.parse(`${capture}\n• Ready\n› Ask Codex to do anything`)).toBeUndefined();
      expect(adapter.questions.parse(`${capture}\nWhich approach?\n› 1. Small\n  2. Broad\nenter confirm`)).toMatchObject({ text: 'Which approach?', choices: ['Small', 'Broad'], source: 'parsed' });
    });

    // ordinary prose or code snippets may mention the native heading without being a permission
    it.each(['Folder access\nDocument the folder picker.', 'Folder access\n/workspaces/example\nThis is an example configuration section.'])('keeps a later ordinary question actionable after %s', prose => {
      const ordinary = `${prose}\n\nWhich approach?\n› 1. Small\n  2. Broad\nenter confirm`;
      expect(adapter.questions.parse(ordinary)).toMatchObject({ text: 'Which approach?', choices: ['Small', 'Broad'], source: 'parsed' });
      expect(adapter.newConversation.ready({ title: 'Ready', attention: 'finished' }, ordinary)).toEqual({ state: 'ready' });
    });

    // native action prefixes inside ordinary answer labels are not trust dialogs
    it.each(['Open restricted settings', 'Open existing task preferences', 'Trust and continue with tests'])('preserves the ordinary choice %s', label => {
      const ordinary = `Which approach?\n› 1. ${label}\n  2. Broad\nenter confirm`;
      expect(adapter.questions.parse(ordinary)).toMatchObject({ text: 'Which approach?', choices: [label, 'Broad'], source: 'parsed' });
      expect(adapter.newConversation.ready({ title: 'Ready', attention: 'finished' }, ordinary)).toEqual({ state: 'ready' });
    });

    // exact action labels in ordinary menus do not establish native trust chrome
    it.each(['Trust and continue', 'Open restricted', 'Open existing task'])('preserves exact ordinary choice %s with or without quoted chrome', label => {
      // quoted native headings and paths remain ordinary prose without a native footer
      for (const prose of ['', 'Folder access\n/workspaces/example\nThis is an example configuration section.\n\n']) {
        const ordinary = `${prose}Which approach?\n› 1. ${label}\n  2. Broad\nenter confirm`;
        expect(adapter.questions.parse(ordinary)).toMatchObject({ text: 'Which approach?', choices: [label, 'Broad'], source: 'parsed' });
        expect(adapter.newConversation.ready({ title: 'Ready', attention: 'finished' }, ordinary)).toEqual({ state: 'ready' });
      }
    });

    // an idle startup title cannot release prompts into the trust picker
    it('holds launch readiness until the operator answers the trust dialog', () => {
      expect(adapter.newConversation.ready({ title: 'Folder access', attention: 'finished' }, capture)).toEqual({ state: 'blocked', reason: 'untrusted directory: safety check' });
      expect(adapter.newConversation.composerEmpty(capture)).toBe(false);
      expect(adapter.newConversation.ready({ title: 'Folder access', attention: 'finished' }, capture.replace('Your trust decision will be saved.', ''))).toEqual({ state: 'blocked', reason: 'untrusted directory: safety check' });
    });

    // unsupported warning and choice variants must still hold native startup until resolved
    it.each(unsupportedCaptures)('keeps $name terminal-only and retires its resolved startup chrome', ({ lines }) => {
      const unsupported = lines.join('\n');
      expect(adapter.questions.parse(unsupported)).toBeUndefined();
      expect(adapter.newConversation.ready({ title: 'Folder access', attention: 'finished' }, unsupported)).toEqual({ state: 'blocked', reason: 'untrusted directory: safety check' });
      const resolved = `${unsupported}\n• Ready\n› Ask Codex to do anything`;
      expect(adapter.questions.parse(resolved)).toBeUndefined();
      expect(adapter.newConversation.ready({ title: 'Ready', attention: 'finished' }, resolved)).toEqual({ state: 'ready' });
      expect(adapter.questions.parse(`${unsupported}\nWhich approach?\n› 1. Small\n  2. Broad\nenter confirm`)).toMatchObject({ text: 'Which approach?', choices: ['Small', 'Broad'] });
    });

    // a native folder permission has no prose answer field
    it('does not offer text entry for a trust decision', () => {
      const question = adapter.questions.parse(capture);
      expect(question).toBeDefined();
      expect(adapter.questions.textEntry(question!, capture)).toBeUndefined();
    });
  });
}
