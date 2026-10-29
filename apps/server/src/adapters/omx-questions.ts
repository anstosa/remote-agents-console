import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { FileChangeCache } from './file-change-cache.js';
import { inlineQuestionId } from './inline-questions.js';
import type { InlineQuestion } from './types.js';

/**
 * OMX's structured Inline questions (ADR 0005). Besides the numbered choice list
 * the Codex TUI can draw (parsed in `codex-questions.ts`), OMX writes a question
 * file under the workspace's `.omx/state` addressed at a pane; it is normalised to
 * the same {@link InlineQuestion} — and the same id — so the console renders and
 * answers both transports alike through the Adapter's `selectOption`.
 */

type OmxRecord = { kind?: unknown; question_id?: unknown; status?: unknown; question?: unknown; options?: unknown; questions?: unknown; renderer?: { target?: unknown; return_target?: unknown } };
const omxQuestionId = /^question-[A-Za-z0-9_.-]+$/u;
// read one OMX question file addressed at this pane into the unified shape
const readOmxQuestion = (raw: OmxRecord, paneId: string): InlineQuestion | undefined => {
  if (raw.kind !== 'omx.question/v1' || (raw.status !== 'pending' && raw.status !== 'prompting') || raw.renderer?.return_target !== paneId || typeof raw.renderer.target !== 'string' || !/^%\d+$/u.test(raw.renderer.target) || typeof raw.question_id !== 'string' || !omxQuestionId.test(raw.question_id)) return undefined;
  const first = Array.isArray(raw.questions) ? raw.questions[0] as { question?: unknown; options?: unknown } : undefined;
  const text = typeof first?.question === 'string' ? first.question : typeof raw.question === 'string' ? raw.question : undefined;
  const options = Array.isArray(first?.options) ? first.options : Array.isArray(raw.options) ? raw.options : [];
  const choices = options.map(option => option && typeof option === 'object' && typeof (option as { label?: unknown }).label === 'string' ? (option as { label: string }).label : undefined).filter((value): value is string => value !== undefined);
  return text && choices.length >= 2 && choices.length <= 16
    ? { id: inlineQuestionId(text, choices), text, choices, source: 'structured', pane: { targetPaneId: raw.renderer.target } }
    : undefined;
};

// index the pane address with each stable parsed question rather than the raw json
const questionFiles = new FileChangeCache(async (path: string) => {
  const contents = await readFile(path, 'utf8');
  let parsed: unknown;
  // malformed in-progress writes remain unavailable until the file changes
  try { parsed = JSON.parse(contents) as unknown; } catch { return undefined; }
  // only structured records can address a pane
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const raw = parsed as OmxRecord;
  const paneId = raw.renderer?.return_target;
  // never index a malformed return address
  if (typeof paneId !== 'string') return undefined;
  const question = readOmxQuestion(raw, paneId);
  return question === undefined ? undefined : { paneId, question };
}, { maxEntries: 1_024 });

const workspaceScans = new Map<string, Promise<Map<string, string[]>>>();

// rebuild inventory each scan so new and removed sessions are immediately visible
async function scanWorkspace(workspace: string): Promise<Map<string, string[]>> {
  const questions = new Map<string, string[]>();
  const root = join(workspace, '.omx', 'state');
  const directories = [join(root, 'questions')];
  const sessions = await readdir(join(root, 'sessions'), { withFileTypes: true }).catch(() => []);
  // retain root-before-session precedence
  for (const session of sessions) if (session.isDirectory()) directories.push(join(root, 'sessions', session.name, 'questions'));
  // share one directory walk and file lookup across every pane in this workspace
  for (const directory of directories) for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    // ignore non-question entries as before
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const path = join(directory, entry.name);
    const indexed = await questionFiles.get(path).catch(() => undefined);
    // keep every valid candidate in precedence order for post-scan revalidation
    if (indexed === undefined) continue;
    const candidates = questions.get(indexed.paneId) ?? [];
    candidates.push(path);
    questions.set(indexed.paneId, candidates);
  }
  return questions;
}

// coalesce concurrent pane lookups without delaying subsequent answer validation
export async function pendingOmxQuestion(workspace: string, paneId: string): Promise<InlineQuestion | undefined> {
  const key = resolve(workspace);
  let scan = workspaceScans.get(key);
  // completed scans are never reused without checking the current inventory
  if (scan === undefined) {
    scan = scanWorkspace(key).finally(() => { workspaceScans.delete(key); });
    workspaceScans.set(key, scan);
  }
  // resolved candidates must neither return nor hide a still-pending successor
  for (const path of (await scan).get(paneId) ?? []) {
    const indexed = await questionFiles.get(path).catch(() => undefined);
    // skip candidates answered, removed or retargeted while other files were scanned
    if (indexed?.paneId !== paneId) continue;
    const question = indexed.question;
    // keep callers from mutating the retained parsed question
    return { ...question, choices: [...question.choices] };
  }
  return undefined;
}
