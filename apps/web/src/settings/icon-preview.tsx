import { useEffect, useState } from 'react';
import { PanelIcon } from '../panel-header.js';
import type { SettingsSource } from './contracts.js';

export const editableIconSources = new Set(['icon-heart', 'icon-potato']);
export const instanceIcons = ['terminal', 'potato', 'heart'] as const;
export type InstanceIconName = typeof instanceIcons[number];
const staticTags = new Set(['svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'title', 'desc', 'text', 'tspan']);
const imageGlyph = 'M3 3h18v18H3zM3 16l6-6 6 6 3-3 3 3M16 7h.01';

// recognize only supported local artwork aliases
export const isInstanceIconName = (value: unknown): value is InstanceIconName => typeof value === 'string' && instanceIcons.includes(value as InstanceIconName);

// preview inert geometry in an image document rather than injecting SVG into the page
const svgImageUrl = (content: string): string | undefined => {
  // reject active constructs and references before parsing unsaved artwork
  if (content.length > 262_144 || /<!|<\?|&|\b(?:href|style|on[a-z]+)\s*=|url\s*\(|(?:javascript|data):/iu.test(content)) return undefined;
  const document = new DOMParser().parseFromString(content, 'image/svg+xml');
  // retain only well-formed static SVG geometry
  if (document.documentElement.localName !== 'svg' || document.querySelector('parsererror') !== null || Array.from(document.querySelectorAll('*')).some(element => !staticTags.has(element.localName))) return undefined;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(content)}`;
};

// show saved or safely redacted draft artwork without exposing disclosed credential bytes
export function InstanceIconPreview({ name, source, content, removed = false, label = '' }: { name: InstanceIconName; source?: SettingsSource; content?: string; removed?: boolean; label?: string }) {
  const src = removed ? '/instance-icons/terminal.svg' : content === undefined ? `/instance-icons/${name}.svg${source === undefined ? '' : `?revision=${encodeURIComponent(source.revisionId)}`}` : svgImageUrl(content);
  const [failed, setFailed] = useState(false);
  // retry a new source revision or edited image
  useEffect(() => { setFailed(false); }, [src]);
  // keep missing or invalid artwork from producing broken-image controls
  if (src === undefined || failed) return <span className="settings-icon-preview-unavailable" role={label ? 'img' : undefined} aria-label={label || undefined} aria-hidden={!label || undefined} title="Preview unavailable. Check the SVG source."><PanelIcon path={imageGlyph} /></span>;
  return <img src={src} alt={label} onError={() => { /* replace failed images with a painted fallback */ setFailed(true); }} />;
}
