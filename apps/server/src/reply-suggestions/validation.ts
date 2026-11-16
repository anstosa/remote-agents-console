import type { ReplySuggestion } from '../domain/models.js';

const maximumOutputBytes = 8 * 1_024;
const maximumLabelLength = 60;
const maximumDraftLength = 600;
const maximumSuggestions = 4;

/** native structured output requires an object root and never defines tools */
export const replySuggestionSchema = {
  type: 'object', additionalProperties: false, required: ['suggestions'],
  properties: {
    suggestions: {
      type: 'array', maxItems: maximumSuggestions,
      items: {
        type: 'object', additionalProperties: false, required: ['label', 'text'],
        properties: {
          label: { type: 'string', minLength: 1, maxLength: maximumLabelLength },
          text: { type: 'string', minLength: 1, maxLength: maximumDraftLength }
        }
      }
    }
  }
} as const;

// accept only the exact reply-suggestion result shape
export function parseReplySuggestions(value: string): ReplySuggestion[] | undefined {
  if (Buffer.byteLength(value, 'utf8') > maximumOutputBytes) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return undefined; }
  // reject extra top-level fields and malformed suggestion collections
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).join(',') !== 'suggestions' || !('suggestions' in parsed) || !Array.isArray(parsed.suggestions) || parsed.suggestions.length > maximumSuggestions) return undefined;
  const suggestions: ReplySuggestion[] = [];
  const unique = new Set<string>();
  // validate the complete set before publishing any member
  for (const entry of parsed.suggestions) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).sort().join(',') !== 'label,text' || !('label' in entry) || !('text' in entry) || typeof entry.label !== 'string' || typeof entry.text !== 'string') return undefined;
    const label = entry.label.trim();
    const text = entry.text.trim();
    // keep labels compact and drafts bounded editable prose
    if (label.length === 0 || label.length > maximumLabelLength || label.split(/\s+/u).length > 3 || text.length === 0 || text.length > maximumDraftLength || /[\u0000-\u001f\u007f]/u.test(label) || /[\u0000-\u0008\u000b-\u001f\u007f]/u.test(text)) return undefined;
    const key = text.replace(/\s+/gu, ' ').toLocaleLowerCase();
    if (unique.has(key)) return undefined;
    unique.add(key);
    suggestions.push({ label, text });
  }
  return suggestions;
}
