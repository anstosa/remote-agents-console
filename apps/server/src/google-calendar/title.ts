import type { CalendarLabels } from './contracts.js';
import { normalizeCalendarLabels } from './agent-labels.js';

type Part = { literal: string } | { field: keyof CalendarLabels };
const fields = new Set(['worktree', 'project', 'agent']);
const controls = /[\p{Cc}\p{Cs}]/u;

// parse only literal text, escaped braces and the documented metadata
function parse(template: string): Part[] {
  // reject malformed or excessive authored text before scanning
  if (Array.from(template).length > 160 || template.trim() === '' || controls.test(template)) throw new Error('Use 1–160 characters without control characters.');
  const parts: Part[] = [];
  let literal = '';
  // consume braces without executing template content
  for (let index = 0; index < template.length;) {
    const char = template[index]!;
    // doubled braces are literal braces
    if ((char === '{' || char === '}') && template[index + 1] === char) { literal += char; index += 2; continue; }
    // ordinary characters remain literal
    if (char !== '{' && char !== '}') { literal += char; index += 1; continue; }
    // unmatched closing braces are not placeholders
    if (char === '}') throw new Error('Escape literal braces with {{ and }}.');
    const end = template.indexOf('}', index + 1);
    const field = template.slice(index + 1, end);
    // permit only the bounded metadata vocabulary
    if (end < 0 || !fields.has(field)) throw new Error('Use only {worktree}, {project}, and {agent}.');
    // retain literals separately from field expansions
    if (literal !== '') { parts.push({ literal }); literal = ''; }
    parts.push({ field: field as keyof CalendarLabels });
    index = end + 1;
  }
  // retain the final literal segment
  if (literal !== '') parts.push({ literal });
  return parts;
}

// expose a safe field error without returning the authored content
export function validateTitleTemplate(template: string): string | undefined {
  try { parse(template); return undefined; }
  catch (error) { return error instanceof Error ? error.message : 'Invalid event title template.'; }
}

// share the exact renderer between settings preview and immutable events
export function renderCalendarTitle(template: string, labels: CalendarLabels): string {
  const normalized = normalizeCalendarLabels(labels);
  const values: Required<CalendarLabels> = { ...normalized, project: normalized.project ?? 'Project' };
  const rendered = parse(template).map(part => 'literal' in part ? part.literal : values[part.field]).join('').trim();
  const scalars = Array.from(rendered);
  return scalars.length > 240 ? `${scalars.slice(0, 239).join('')}…` : rendered || 'Agent work';
}
