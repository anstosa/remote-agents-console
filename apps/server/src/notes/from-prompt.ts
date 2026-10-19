import type { PromptAttachment } from '../prompts/validation.js';

const maxQueuedPromptTitleLength = 80;

// respect the title length budget without splitting an emoji's surrogate pair
function boundedTitlePart(text: string, length: number): string {
  return text.slice(0, length).replace(/[\uD800-\uDBFF]$/u, '');
}

// compose queued prompt note content with a bounded host-local title
export function promptNoteContent(worktreeName: string, at: Date, prompt: { text: string; attachments?: PromptAttachment[] }): { title: string; text: string; attachments?: PromptAttachment[] } {
  const hours = at.getHours();
  const date = `${String(at.getMonth() + 1).padStart(2, '0')}/${String(at.getDate()).padStart(2, '0')}`;
  const time = `${hours % 12 || 12}:${String(at.getMinutes()).padStart(2, '0')}${hours < 12 ? 'am' : 'pm'}`;
  const prefix = `${date} ${time} in `;
  const preview = prompt.text.replace(/\s+/gu, ' ').trim();
  const fallbackName = worktreeName.trim() || 'workspace';
  // reserve twenty preview characters and an ellipsis before shortening oversized names
  const reservedPreviewLength = Math.min(preview.length, 23);
  const boundedName = boundedTitlePart(fallbackName, maxQueuedPromptTitleLength - prefix.length - 4 - reservedPreviewLength);
  const titlePrefix = `${prefix}${boundedName}: '`;
  const previewLength = maxQueuedPromptTitleLength - titlePrefix.length - 1;
  // retain complete short prompts and include truncation punctuation in the same budget
  const excerpt = preview.length <= previewLength ? preview : `${boundedTitlePart(preview, previewLength - 3)}...`;
  return { title: `${titlePrefix}${excerpt}'`, text: prompt.text, ...(prompt.attachments === undefined ? {} : { attachments: prompt.attachments }) };
}
