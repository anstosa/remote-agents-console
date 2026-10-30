import { createContext, useContext, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { openContextMenu, type ContextMenuItem } from './context-menu.js';

export type SelectionActions = {
  agentOpen: boolean;
  noteOpen: boolean;
  canAppendToNote?: (text: string) => boolean;
  canCreateNote: boolean;
  appendToNote: (text: string) => void | Promise<unknown>;
  createNote: (text: string) => void | Promise<unknown>;
  addToPrompt?: (text: string) => void;
};

export const SelectionActionsContext = createContext<SelectionActions | undefined>(undefined);

export type ClipboardContents = {
  text: string;
  files: File[];
};

export type SelectionContextMode = {
  id: string;
  label: string;
  checked: boolean;
  onSelect: () => void;
};

type SelectionContextMenuOptions = {
  label: string;
  modes?: SelectionContextMode[];
  selectedText: string;
  selectAll: () => void;
  cut?: () => void | Promise<void>;
  copy: () => void | Promise<void>;
  copyUrl?: () => void | Promise<void>;
  paste?: (contents: ClipboardContents) => void | Promise<void>;
  pasteAcceptsFiles?: boolean;
  pasteDisabled?: boolean;
  pastePlain?: (text: string) => void | Promise<void>;
  selectionActions?: SelectionActions;
  allowAddToPrompt?: boolean;
};

// expose the workspace selection actions to split components
export function useSelectionActions() {
  return useContext(SelectionActionsContext);
}

// preserve split focus and selection before the contextmenu event
export function preserveContextMenuPress(event: ReactMouseEvent | ReactPointerEvent) {
  // leave primary and auxiliary interactions unchanged
  if (event.button !== 2) return;
  event.preventDefault();
  event.stopPropagation();
}

// convert rich clipboard html when plain text is absent
function htmlClipboardText(html: string): string {
  const template = document.createElement('template');
  template.innerHTML = html;
  return template.content.textContent ?? '';
}

// give pasted image blobs stable file names
function clipboardFile(blob: Blob, index: number): File {
  const subtype = blob.type.slice('image/'.length).toLowerCase();
  const extension = subtype === 'jpeg' ? 'jpg' : /^[a-z0-9]+$/u.test(subtype) ? subtype : 'png';
  return new File([blob], `pasted-image-${index + 1}.${extension}`, { type: blob.type, lastModified: Date.now() });
}

// read the clipboard only once Paste is chosen: Firefox asks for confirmation with its own popup on every read
async function readClipboard(): Promise<ClipboardContents | undefined> {
  const clipboard = navigator.clipboard;
  // paste nothing when the browser exposes no async clipboard surface
  if (clipboard === undefined) return undefined;
  try {
    // retain images for ordinary paste when rich clipboard reads are supported
    if (typeof clipboard.read === 'function') {
      const items = await clipboard.read();
      let text = '';
      let html = '';
      const files: File[] = [];
      // collect the formats this app can safely consume
      for (const item of items) {
        // prefer the clipboard's explicit plain representation
        if (!text && item.types.includes('text/plain')) text = await (await item.getType('text/plain')).text();
        // retain html only as a text fallback
        if (!html && item.types.includes('text/html')) html = await (await item.getType('text/html')).text();
        // accept image formats through the existing prompt and note attachment policies
        for (const type of item.types) {
          // skip non-image and duplicate text representations
          if (!type.startsWith('image/')) continue;
          files.push(clipboardFile(await item.getType(type), files.length));
        }
      }
      // match textarea paste by reducing html to readable text
      if (!text && html) text = htmlClipboardText(html);
      return { text, files };
    }
    // fall back to text-only clipboard access on older browsers
    return { text: await clipboard.readText(), files: [] };
  } catch {
    // a denied or dismissed permission prompt is the user declining the paste
    return undefined;
  }
}

// append an action group without leaving duplicate separators
function appendGroup(items: ContextMenuItem[], group: ContextMenuItem[]) {
  // omit empty optional groups
  if (group.length === 0) return;
  if (items.length > 0) items.push({ type: 'separator' });
  items.push(...group);
}

// build one menu from the current selection
function selectionItems(options: SelectionContextMenuOptions): ContextMenuItem[] {
  const selected = options.selectedText;
  const items: ContextMenuItem[] = [];
  appendGroup(items, (options.modes ?? []).map(mode => ({
    type: 'action' as const,
    id: `mode-${mode.id}`,
    label: mode.label,
    mode: 'radio' as const,
    checked: mode.checked,
    onSelect: mode.onSelect
  })));
  const { paste, pastePlain } = options;
  appendGroup(items, [
    { type: 'action', id: 'select-all', label: 'Select all', onSelect: options.selectAll },
    ...(options.cut === undefined ? [] : [{ type: 'action' as const, id: 'cut', label: 'Cut', disabled: !selected, onSelect: options.cut }]),
    { type: 'action', id: 'copy', label: 'Copy', disabled: !selected, onSelect: options.copy },
    ...(options.copyUrl === undefined ? [] : [{ type: 'action' as const, id: 'copy-url', label: 'Copy URL', onSelect: options.copyUrl }]),
    { type: 'action', id: 'paste', label: 'Paste', disabled: options.pasteDisabled || paste === undefined, onSelect: async () => {
      const contents = await readClipboard();
      // an empty clipboard pastes nothing
      if (contents !== undefined && (contents.text || options.pasteAcceptsFiles === true && contents.files.length > 0)) await paste?.(contents);
    } },
    { type: 'action', id: 'paste-plain', label: 'Paste plain', disabled: options.pasteDisabled || pastePlain === undefined, onSelect: async () => {
      const text = (await readClipboard())?.text;
      if (text) await pastePlain?.(text);
    } }
  ]);
  const actions = options.selectionActions;
  // expose transfer actions only for a real selection
  if (selected && actions !== undefined) appendGroup(items, [
    ...(actions.noteOpen ? [{ type: 'action' as const, id: 'append-note', label: 'Add to note', disabled: actions.canAppendToNote?.(selected) === false, onSelect: async () => { await actions.appendToNote(selected); } }] : []),
    { type: 'action', id: 'new-note', label: 'New note', disabled: !actions.canCreateNote || selected.length > 30_000, onSelect: async () => { await actions.createNote(selected); } },
    ...(options.allowAddToPrompt !== false && actions.agentOpen && actions.addToPrompt !== undefined ? [{ type: 'action' as const, id: 'add-prompt', label: 'Add to prompt', onSelect: () => actions.addToPrompt?.(selected) }] : [])
  ]);
  return items;
}

export function openSelectionContextMenu(event: globalThis.MouseEvent | ReactMouseEvent, options: SelectionContextMenuOptions) {
  return openContextMenu(event, { label: options.label, items: selectionItems(options) });
}
