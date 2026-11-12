import { SettingsError } from './settings/contracts.js';

// the largest artwork accepted from an operator or a peer
export const maxIconBytes = 262_144;
const tags = new Set(['svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'title', 'desc']);
const attributes = new Set(['xmlns', 'viewBox', 'width', 'height', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'd', 'points', 'fill', 'fill-rule', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-opacity', 'opacity', 'transform', 'id', 'role', 'aria-label']);

// retain inert static artwork only; operator uploads, peer artwork and the browser preview share this check
export function validateSvg(content: string): void {
  // reject declarations, references and active constructs
  if (new TextEncoder().encode(content).length > maxIconBytes || /<!|<\?|&|\b(?:href|style|on[a-z]+)\s*=|url\s*\(|(?:javascript|data):/iu.test(content)) throw new SettingsError('invalid_static_icon');
  const stack: string[] = [];
  let end = 0;
  // validate each token rather than only the root; the patterns stay linear because peers supply this markup,
  // so the lookahead stops an unclosed tag from retrying every shorter name
  for (const match of content.matchAll(/<(\/?)([A-Za-z][A-Za-z0-9-]*)(?![A-Za-z0-9-])([^<>]*)>/gu)) {
    // permit text only in inert title and description elements
    if (content.slice(end, match.index).trim() !== '' && !['title', 'desc'].includes(stack.at(-1) ?? '')) throw new SettingsError('invalid_static_icon');
    const name = match[2]!;
    if (!tags.has(name)) throw new SettingsError('invalid_static_icon');
    const trimmed = match[3]!.trim();
    const selfClosing = trimmed.endsWith('/');
    // enforce properly nested static geometry
    if (match[1] === '/') {
      if (stack.pop() !== name || trimmed !== '' && trimmed !== '/') throw new SettingsError('invalid_static_icon');
    } else {
      const rest = selfClosing ? trimmed.slice(0, -1) : trimmed;
      const attribute = /\s*([A-Za-z][A-Za-z0-9-]*)\s*=\s*("[^"]*"|'[^']*')/uy;
      let consumed = 0;
      // require quoted allowlisted attributes, each directly after the last
      for (let found = attribute.exec(rest); found !== null; found = attribute.exec(rest)) {
        if (!attributes.has(found[1]!)) throw new SettingsError('invalid_static_icon');
        consumed = attribute.lastIndex;
      }
      if (rest.slice(consumed).trim() !== '') throw new SettingsError('invalid_static_icon');
      if (stack.length === 0 && (name !== 'svg' || end !== 0 && content.slice(0, end).trim() !== '')) throw new SettingsError('invalid_static_icon');
      if (!selfClosing) stack.push(name);
    }
    end = match.index + match[0].length;
  }
  // reject unfinished or unparsed markup
  if (end === 0 || stack.length !== 0 || content.slice(end).trim() !== '') throw new SettingsError('invalid_static_icon');
}
