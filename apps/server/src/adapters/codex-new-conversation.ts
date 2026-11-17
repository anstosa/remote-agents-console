import { normalizedCapture, normalizedLines } from './capture-text.js';
import { withoutComposerSparkles } from './codex-turns.js';
import { codexFolderTrustDialog } from './codex-folder-trust.js';
import type { Adapter, LaunchReadiness, PaneSnapshot, ResetSettling } from './types.js';

/**
 * How a Run resets a Codex pane to a fresh conversation and knows a fresh launch is
 * ready (Scheduled prompts; probe `docs/research/new-conversation-settle-probe.md`).
 * The OMX Adapter carries this very object by reference (ADR 0005) — OMX runs the
 * same Codex TUI, so a `/new` reset settles identically. Pure functions over captures
 * and pane snapshots; the console pastes and polls.
 */

// Codex draws the composer as `› Ask Codex to do anything` when empty and `› <draft>`
// once text is typed; its interactive selection lists use a different caret (`❯ 1. …`)
// and leave the composer empty beneath them, so an open dialog is detected on its own.
const codexChoiceRow = /^❯ \d+\./u;
const composerPlaceholder = '› Ask Codex to do anything';

// ignore decorative animation while preserving real drafts and open dialogs
function composerEmpty(capture: string): boolean {
  const lines = normalizedLines(withoutComposerSparkles(capture));
  // never paste through a choice dialog
  if (lines.some(line => codexChoiceRow.test(line))) return false;
  const composer = lines.filter(line => line.startsWith('›')).at(-1);
  return composer === '›' || composer === composerPlaceholder;
}

/**
 * `/new` spins the pane title for about 0.75 s and returns it to idle; the paste
 * right after is accepted either way (probe), so the reset has taken once the title
 * has spun and gone idle again, or after 1.5 s regardless. It is never lost: a merged
 * command is caught earlier by the composer-empty precondition.
 */
// The paste right after `/new` is accepted whether or not the title has finished
// spinning (probe), so a spin that has not returned to idle still settles at 1.5 s.
const resetBudgetMs = 1500;

function settled(_before: PaneSnapshot, observed: readonly PaneSnapshot[], elapsedMs: number): ResetSettling {
  const spun = observed.some(snapshot => snapshot.attention === 'working');
  if (spun && observed.at(-1)?.attention === 'finished') return 'settled';
  return elapsedMs >= resetBudgetMs ? 'settled' : 'pending';
}

// The fresh launch shows `model: loading` in its header until the session loads.
const headerLoading = /model:\s*loading/i;

/**
 * A fresh Codex launch draws its composer at once but with `model: loading` in the
 * header and a startup spinner; an Enter before it loads is dropped. It is ready once
 * the header has filled (no `model: loading`) and the startup spinner is gone (the
 * title no longer spins, i.e. Attention is not `working`). The probe gives two
 * interchangeable loaded signals — "the header no longer says loading" *or* "the
 * title left the shell's title" — and the title becoming the directory basename is
 * the same event as the header filling; a pure `ready` has no cwd to compare the
 * title against, so it keys on the header, which is the authoritative signal. Codex
 * can also wait for explicit folder trust before becoming ready.
 */
function ready(snapshot: PaneSnapshot, capture: string): LaunchReadiness {
  // an idle title during folder trust never authorizes an initial prompt
  if (codexFolderTrustDialog(capture) !== undefined) return { state: 'blocked', reason: 'untrusted directory: safety check' };
  if (headerLoading.test(normalizedCapture(capture)) || snapshot.attention === 'working') return { state: 'pending' };
  return { state: 'ready' };
}

export const codexNewConversation: NonNullable<Adapter['newConversation']> = {
  command: '/new',
  aliases: ['/clear'],
  composerEmpty,
  settled,
  ready,
};
