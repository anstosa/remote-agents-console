import { useCallback, useEffect, useRef, useState } from 'react';
import { isFilePreview, type FilePreviewView } from './code-panel/comparison.js';

type PreviewRequest = (url: string, init?: RequestInit) => Promise<Response>;
type PreviewOptions = { body?: unknown; source?: 'files' | 'notes'; onReturn?: () => void; onEdit?: () => void };
type PreviewView = FilePreviewView & { onEdit?: () => void };

// own transient file previews independently of git comparisons
export function useFilePreview(scope: string | undefined, request: PreviewRequest) {
  const [view, setView] = useState<PreviewView>();
  const generation = useRef(0);
  const destination = useRef(0);
  const pending = useRef<AbortController | undefined>(undefined);
  const retry = useRef<(() => void) | undefined>(undefined);

  // order editor destinations without cancelling the visible preview read
  const beginFileAction = useCallback(() => {
    const id = ++destination.current;
    return () => destination.current === id;
  }, []);

  // invalidate reads when their workspace closes or changes
  const close = useCallback(() => {
    generation.current += 1;
    destination.current += 1;
    pending.current?.abort();
    retry.current = undefined;
    setView(undefined);
  }, []);
  // release workspace-owned content and in-flight reads
  useEffect(() => {
    close();
    return () => { generation.current += 1; destination.current += 1; pending.current?.abort(); };
  }, [scope, close]);

  // fetch only through the existing authenticated scoped preview routes
  const openFilePreview = useCallback((path: string, url: string, options?: PreviewOptions) => {
    const id = ++generation.current;
    destination.current += 1;
    pending.current?.abort();
    const abort = new AbortController();
    pending.current = abort;
    const origin = { source: options?.source, onReturn: options?.onReturn, onEdit: options?.onEdit };
    retry.current = () => openFilePreview(path, url, options);
    setView({ path, state: 'loading', ...origin });
    // settle only the latest surviving workspace request
    void (async () => {
      try {
        const response = await request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(options?.body ?? { path }), signal: abort.signal });
        // rejected responses never become file content
        if (!response.ok) throw new Error('preview unavailable');
        const payload: unknown = await response.json();
        // validate text and bounded raster envelopes before rendering
        if (!isFilePreview(payload)) throw new Error('invalid preview');
        // a closed or superseded preview cannot reopen itself
        if (id !== generation.current) return;
        setView({ path: payload.path, state: 'ready', preview: payload, ...origin });
      } catch {
        // aborted requests leave the new preview untouched
        if (id === generation.current) setView({ path, state: 'error', ...origin });
      }
    })();
  }, [request]);

  // preview already-redacted settings bytes without another host read
  const openContentPreview = useCallback((path: string, content: string) => {
    close();
    setView({ path, state: 'ready', source: 'settings', preview: { path, size: new TextEncoder().encode(content).byteLength, truncated: false, binary: false, content } });
  }, [close]);
  // retry the original capability rather than reconstructing a host path
  const refresh = useCallback(() => { retry.current?.(); }, []);
  return { open: view !== undefined, view, beginFileAction, openFilePreview, openContentPreview, close, refresh };
}

export type FilePreviewController = ReturnType<typeof useFilePreview>;
