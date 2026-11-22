import type { CSSProperties, ReactNode } from 'react';
import type { ITheme } from '@xterm/xterm';
import { computeTerminalTheme } from './terminal-theme.js';
import { screensaverTailRows } from '../../server/src/screensaver/contracts.js';

export type TerminalColor = number | `#${string}`;
export type TerminalColorRange = { from: number; to: number; foreground?: TerminalColor; background?: TerminalColor; inverse?: true; dim?: true };

const maxColorRanges = 1_024;
const hexColor = /^#[0-9a-f]{6}$/iu;

// accept only terminal palette indices and inert six-digit colors
const isTerminalColor = (value: unknown): value is TerminalColor =>
  typeof value === 'number'
    ? Number.isInteger(value) && value >= 0 && value <= 255
    : typeof value === 'string' && hexColor.test(value);

// reject a boundary that would split one rendered Unicode scalar
const splitsSurrogatePair = (text: string, at: number): boolean =>
  at > 0 && at < text.length && text.charCodeAt(at - 1) >= 0xd800 && text.charCodeAt(at - 1) <= 0xdbff && text.charCodeAt(at) >= 0xdc00 && text.charCodeAt(at) <= 0xdfff;

// validate bounded, ordered ranges before any value reaches a style prop
export function isTerminalColorRanges(value: unknown, text: string): value is TerminalColorRange[] {
  // bound both work and generated span count
  if (!Array.isArray(value) || value.length > maxColorRanges) return false;
  let previousTo = 0;
  // validate ranges in their required display order
  for (const item of value) {
    // require one plain object range
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return false;
    const range = item as Partial<TerminalColorRange>;
    // preserve text exactly by requiring complete UTF-16 scalar boundaries
    if (!Number.isInteger(range.from) || !Number.isInteger(range.to) || range.from! < previousTo || range.from! < 0 || range.to! <= range.from! || range.to! > text.length || splitsSurrogatePair(text, range.from!) || splitsSurrogatePair(text, range.to!)) return false;
    // allow absent colors but reject every unsupported color value
    if (range.foreground !== undefined && !isTerminalColor(range.foreground) || range.background !== undefined && !isTerminalColor(range.background)) return false;
    // style flags are literal opt-ins rather than arbitrary truthy values
    if (range.inverse !== undefined && range.inverse !== true || range.dim !== undefined && range.dim !== true) return false;
    previousTo = range.to!;
  }
  return true;
}

// retain the latest screensaver rows and rebase their color coordinates
export function terminalOutputTail(text: string, colors: readonly TerminalColorRange[] = []): { text: string; colors: TerminalColorRange[] } {
  const lines = text.split('\n');
  let start = 0;
  // skip complete old rows so UTF-16 color offsets remain exact
  for (let index = 0; index < Math.max(0, lines.length - screensaverTailRows); index += 1) start += lines[index]!.length + 1;
  const tail = text.slice(start);
  const rebased = colors.flatMap(range => {
    // discard ranges that end before the retained suffix
    if (range.to <= start) return [];
    return [{ ...range, from: Math.max(range.from, start) - start, to: range.to - start }];
  });
  return { text: tail, colors: rebased };
}

// format one xterm cube component as a CSS-safe color
const rgb = (red: number, green: number, blue: number): string => `#${[red, green, blue].map(component => component.toString(16).padStart(2, '0')).join('')}`;

// expand one xterm cube slot to its conventional byte value
const cubeComponent = (index: number): number => index === 0 ? 0 : 55 + index * 40;

// resolve standard, bright, cube and grayscale xterm colors
function terminalColor(value: TerminalColor, theme: ITheme): string {
  // pass through already-validated truecolor values
  if (typeof value === 'string') return value;
  const palette = [theme.black, theme.red, theme.green, theme.yellow, theme.blue, theme.magenta, theme.cyan, theme.white, theme.brightBlack, theme.brightRed, theme.brightGreen, theme.brightYellow, theme.brightBlue, theme.brightMagenta, theme.brightCyan, theme.brightWhite];
  // share the application's terminal theme for ANSI colors 0–15
  if (value < palette.length) return palette[value] ?? theme.foreground ?? 'inherit';
  // use the conventional 6×6×6 xterm color cube
  if (value < 232) {
    const offset = value - 16;
    return rgb(cubeComponent(Math.floor(offset / 36)), cubeComponent(Math.floor(offset / 6) % 6), cubeComponent(offset % 6));
  }
  const shade = 8 + (value - 232) * 10;
  return rgb(shade, shade, shade);
}

// map one validated terminal style to inert React style properties
function colorStyle(range: TerminalColorRange, theme: ITheme): CSSProperties {
  const foreground = range.foreground === undefined ? theme.foreground : terminalColor(range.foreground, theme);
  const background = range.background === undefined ? theme.background : terminalColor(range.background, theme);
  // inversion includes terminal defaults when one side was not explicit
  if (range.inverse === true) return { color: background, backgroundColor: foreground, ...(range.dim === true ? { opacity: .65 } : {}) };
  return { ...(range.foreground === undefined ? {} : { color: foreground }), ...(range.background === undefined ? {} : { backgroundColor: background }), ...(range.dim === true ? { opacity: .65 } : {}) };
}

// render only text nodes and validated inline colors, never markup from output
export function ColoredTerminalOutput({ text, colors }: { text: string; colors: readonly TerminalColorRange[] }): ReactNode {
  // avoid theme reads and extra spans for an unstyled tail
  if (colors.length === 0) return text;
  const theme = computeTerminalTheme();
  const content: ReactNode[] = [];
  let at = 0;
  // preserve every unstyled gap between ordered ranges
  for (const [index, range] of colors.entries()) {
    // retain plain content before this styled run
    if (range.from > at) content.push(text.slice(at, range.from));
    content.push(<span key={`${range.from}:${range.to}:${index}`} style={colorStyle(range, theme)}>{text.slice(range.from, range.to)}</span>);
    at = range.to;
  }
  // retain the unstyled suffix after the final run
  if (at < text.length) content.push(text.slice(at));
  return content;
}
