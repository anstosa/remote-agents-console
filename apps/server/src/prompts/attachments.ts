import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { run } from '../tmux/command.js';
import { maxPromptAttachmentBytes, promptAttachmentData, promptAttachmentName, type PromptAttachment } from './validation.js';

/**
 * A prompt's attachments reach an Agent as files staged in its workspace, beneath
 * `node_modules/.remote-agent-console/attachments/<random>/` (kept out of Git status), which the
 * prompt then names. Shared by every Transport.
 */

const attachmentIgnoreRule = '/node_modules/.remote-agent-console/';

// keep staged attachments outside Git status
async function ensureAttachmentRootIgnored(workspace: string, relativeRoot: string): Promise<boolean> {
  const ignored = await run('/usr/bin/git', ['-C', workspace, 'check-ignore', '--quiet', '--', relativeRoot]);
  // retain repository ignore rules
  if (ignored.code === 0) return true;
  // allow workspaces without Git metadata
  if (/not a git repository/u.test(ignored.stderr)) return true;
  const resolved = await run('/usr/bin/git', ['-C', workspace, 'rev-parse', '--git-path', 'info/exclude']);
  // require a repository-local exclude file
  if (resolved.code !== 0 || resolved.stdout.trim() === '') return false;
  const excludePath = resolved.stdout.trim();
  const absoluteExcludePath = isAbsolute(excludePath) ? excludePath : join(workspace, excludePath);
  const existing = await readFile(absoluteExcludePath, 'utf8').catch(() => '');
  // add the narrow staging rule once
  if (!existing.split(/\r?\n/u).includes(attachmentIgnoreRule)) {
    await mkdir(dirname(absoluteExcludePath), { recursive: true });
    await appendFile(absoluteExcludePath, `${existing && !existing.endsWith('\n') ? '\n' : ''}${attachmentIgnoreRule}\n`, { mode: 0o600 });
  }
  return (await run('/usr/bin/git', ['-C', workspace, 'check-ignore', '--quiet', '--', relativeRoot])).code === 0;
}

/**
 * Validate and stage a prompt's attachments in `workspace`: their paths relative to it, in the
 * original order (none for none), or undefined when one is invalid or they could not be written.
 */
export async function stagePromptAttachments(workspace: string, attachments: PromptAttachment[]): Promise<string[] | undefined> {
  // skip empty attachment sets
  if (attachments.length === 0) return [];
  const files: Array<{ name: string; data: Buffer }> = [];
  const names = new Set<string>();
  let total = 0;
  // validate attachment payloads
  for (const attachment of attachments) {
    const name = promptAttachmentName(attachment.name);
    const data = promptAttachmentData(attachment.data);
    // reject unsafe or duplicate files
    if (!name || !data || names.has(name)) return undefined;
    names.add(name);
    total += data.length;
    // enforce the request limit
    if (total > maxPromptAttachmentBytes) return undefined;
    files.push({ name, data });
  }
  // stage beneath a dependency path
  const relativeRoot = `node_modules/.remote-agent-console/attachments/${randomBytes(12).toString('base64url')}`;
  // configure a local fallback for repositories without dependency ignores
  if (!await ensureAttachmentRootIgnored(workspace, relativeRoot)) return undefined;
  const root = join(workspace, relativeRoot);
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    // bound file-descriptor use independently of batch size
    for (const file of files) await writeFile(join(root, file.name), file.data, { mode: 0o600 });
    return files.map(file => `${relativeRoot}/${file.name}`);
  } catch {
    // remove every partial file before retaining the queued batch
    await rm(root, { recursive: true, force: true });
    return undefined;
  }
}

/** Remove one staged batch, for a prompt that was not delivered. */
export async function removeStagedAttachments(workspace: string, paths: string[]): Promise<void> {
  const relativeRoot = paths[0]?.split('/').slice(0, -1).join('/');
  if (relativeRoot) await rm(join(workspace, relativeRoot), { recursive: true, force: true });
}

/** The prompt with references to its staged files listed under it. */
export function withAttachedFiles(prompt: string, references: string[]): string {
  return references.length === 0 ? prompt : `${prompt}${prompt ? '\n\n' : ''}Attached files:\n${references.join('\n')}`;
}
