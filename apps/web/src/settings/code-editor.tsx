import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ChangeEvent, type ReactNode, type UIEvent } from 'react';
import { SyntaxHighlightedCode } from '../syntax-highlight.js';
import { PanelIcon, panelIcons } from '../panel-header.js';
import { prefersReducedMotion } from '../reduced-motion.js';
import type { SettingsSource } from './contracts.js';
import { canPrettyFormatSettingsCode, prettyFormatSettingsCode, SettingsCodeFormatError, settingsCodeFormatFailure, type SettingsCodeFormat } from './code-format.js';
import { useOptionalSettingsRuntime } from './runtime.js';
import { useSettingsTerminalEditor } from './terminal-editor.js';
import './code-editor.css';

export { canPrettyFormatSettingsCode } from './code-format.js';

type SettingsCodeEditorProps = {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  readOnly?: boolean;
  masked?: boolean;
  ariaLabel: string;
  id?: string;
  placeholder?: string;
  singleLine?: boolean;
  format?: SettingsCodeFormat;
  onBlur?: () => void;
  editorSource?: SettingsSource;
  fieldAction?: ReactNode;
};

const formatLanguages: Record<SettingsSource['format'], string> = {
  json: 'json',
  env: 'env',
  compose: 'yaml',
  cloudflared: 'yaml',
  credentials: 'json',
  wrapper: 'shell',
  svg: 'xml',
  installation: 'json'
};

const editorFailures: Record<string, string> = {
  settings_conflict: 'The saved file changed. Refresh files before opening it in the editor.',
  settings_source_unavailable: 'This saved source is unavailable. Refresh files before trying again.',
  settings_applier_unavailable: 'The Settings host bridge is unavailable. Restore it before opening this source.'
};

// map settings source formats onto the lightweight preview grammars
const languageForFormat = (format?: SettingsCodeFormat): string => format === undefined ? 'plaintext' : formatLanguages[format];

// render one controlled settings source editor
export function SettingsCodeEditor({ value, onChange, disabled = false, readOnly: sourceReadOnly = false, masked = false, ariaLabel, id, placeholder, singleLine = false, format, onBlur, editorSource, fieldAction }: SettingsCodeEditorProps) {
  // masked previews never become editable through a missing read-only flag
  const readOnly = sourceReadOnly || masked;
  const textarea = useRef<HTMLTextAreaElement>(null);
  const presentation = useRef<HTMLPreElement>(null);
  const disclosureAction = useRef<HTMLDivElement>(null);
  const disclosureAttention = useRef<Animation | undefined>(undefined);
  const mounted = useRef(false);
  const formatRequest = useRef(0);
  const formatAbort = useRef<AbortController | undefined>(undefined);
  const runtime = useOptionalSettingsRuntime();
  const securityEpoch = runtime?.securityEpoch;
  const terminalEditor = useSettingsTerminalEditor();
  const editorRequest = useRef(0);
  const errorId = useId();
  const editorErrorId = useId();
  const editorDescriptionId = useId();
  const [formatError, setFormatError] = useState<string>();
  const [formatPending, setFormatPending] = useState(false);
  const [editorPending, setEditorPending] = useState(false);
  const [editorError, setEditorError] = useState<string>();
  const canFormat = canPrettyFormatSettingsCode(format);
  // omit terminal launch until the runtime reports a configured editor
  const showEditor = editorSource !== undefined && terminalEditor.configured;
  const language = languageForFormat(format);
  // size the gutter for the current line-count width
  const lineDigits = useMemo(() => Math.max(2, String(value.split('\n').length).length), [value]);
  const editorStyle = { '--settings-code-gutter': `${lineDigits + 2.2}ch` } as CSSProperties;

  // align the decorated layer with the native editing surface
  const syncScroll = () => {
    // wait until both layers are mounted
    if (textarea.current === null || presentation.current === null) return;
    presentation.current.scrollTop = textarea.current.scrollTop;
    presentation.current.scrollLeft = textarea.current.scrollLeft;
  };

  // restore alignment after controlled content changes
  useLayoutEffect(syncScroll, [value]);

  // stop attention after disclosure, source, or security transitions and unmount
  useLayoutEffect(() => () => { disclosureAttention.current?.cancel(); }, [masked, disabled, ariaLabel, editorSource?.id, editorSource?.revisionId, securityEpoch]);

  // prevent formatter completions from updating an unmounted editor
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; formatRequest.current += 1; formatAbort.current?.abort(); editorRequest.current += 1; };
  }, []);

  // invalidate pending output when drafts, sources, or disclosure authority change
  useLayoutEffect(() => {
    formatRequest.current += 1;
    formatAbort.current?.abort();
    setFormatError(undefined);
    setFormatPending(false);
  }, [value, format, singleLine, disabled, readOnly, ariaLabel, securityEpoch]);

  // discard editor feedback after source, workspace, or controller transitions
  useLayoutEffect(() => {
    editorRequest.current += 1;
    setEditorPending(false);
    setEditorError(undefined);
  }, [editorSource?.id, editorSource?.revisionId, terminalEditor.placeId, terminalEditor.configured, disabled, readOnly, securityEpoch]);

  // mirror direct user scrolling onto the presentation layer
  const handleScroll = (_event: UIEvent<HTMLTextAreaElement>) => syncScroll();

  // point masked-editor clicks toward explicit disclosure without revealing anything
  const hintReveal = () => {
    // leave ordinary and unavailable editors untouched
    if (!masked || disabled || disclosureAction.current === null) return;
    disclosureAttention.current?.cancel();
    const reducedMotion = prefersReducedMotion();
    // use a steady outline instead of blinking when motion is reduced
    const frames = reducedMotion
      ? [{ outline: '2px solid var(--blue)', outlineOffset: '2px' }, { outline: '2px solid var(--blue)', outlineOffset: '2px' }]
      : [{ opacity: 1 }, { opacity: .25 }, { opacity: 1 }];
    disclosureAttention.current = disclosureAction.current.animate(frames, { duration: reducedMotion ? 1000 : 500, iterations: reducedMotion ? 1 : 2, easing: 'ease-in-out' });
  };

  // send native edits through the controlled value contract
  const handleChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    // keep masked and unavailable values display-only
    if (disabled || readOnly) return;
    formatRequest.current += 1;
    formatAbort.current?.abort();
    setFormatPending(false);
    setFormatError(undefined);
    onChange(event.currentTarget.value);
  };

  // format drafts locally without overwriting later edits or resurrecting disclosed keys
  const prettyFormat = async () => {
    // serialize formatting while retaining native editing
    if (!canFormat || format === undefined || disabled || readOnly || formatPending) return;
    const request = ++formatRequest.current;
    const abort = new AbortController();
    formatAbort.current = abort;
    setFormatPending(true);
    setFormatError(undefined);
    try {
      const formatted = await prettyFormatSettingsCode(value, format, abort.signal, singleLine);
      // discard stale completions after any editor or security transition
      if (!mounted.current || request !== formatRequest.current) return;
      onChange(formatted);
    } catch (error) {
      // keep invalid input byte-for-byte and never render parser source snippets
      if (mounted.current && request === formatRequest.current) setFormatError(error instanceof SettingsCodeFormatError ? error.message : settingsCodeFormatFailure(format));
    } finally {
      // avoid clearing a newer formatter request's pending state
      if (mounted.current && request === formatRequest.current) {
        formatAbort.current = undefined;
        setFormatPending(false);
      }
    }
  };

  // open the saved source while keeping the current browser draft untouched
  const openInEditor = async () => {
    // require one writable existing source and a workspace-owned configured editor
    if (editorPending || disabled || readOnly || !terminalEditor.configured || editorSource?.writable !== true || !editorSource.exists || terminalEditor.open === undefined) return;
    const request = ++editorRequest.current;
    setEditorPending(true);
    setEditorError(undefined);
    try {
      const failure = await terminalEditor.open({ sourceId: editorSource.id, revisionId: editorSource.revisionId });
      // avoid attaching a late failure to a different source or controller
      if (!mounted.current || request !== editorRequest.current) return;
      setEditorError(failure === undefined ? undefined : editorFailures[failure] ?? failure);
    } catch {
      // keep transport diagnostics and source bytes out of feedback
      if (mounted.current && request === editorRequest.current) setEditorError('The configured editor could not open this saved source.');
    } finally {
      // leave a newer source's editor request untouched
      if (mounted.current && request === editorRequest.current) setEditorPending(false);
    }
  };

  // explain every disabled state and warn explicitly about terminal key visibility
  const editorTitle = runtime?.canMutate === false ? 'Take control to open this source in the editor.'
    : !terminalEditor.configured ? 'Configure an editor in Application settings first.'
    : terminalEditor.open === undefined ? 'Open a workspace to launch the configured terminal editor.'
    : !editorSource?.exists ? 'Save this source before opening it in the editor.'
    : !editorSource.writable ? 'This source is read-only in the current installation.'
    : disabled || readOnly ? 'This field is currently read-only or busy.'
    : `Open the saved ${editorSource.label} file in the configured terminal editor. Unsaved changes stay here.${editorSource.hasProtectedContent ? ' Keys will be visible in the terminal.' : ''}`;

  return <div className={`settings-code-editor${disabled ? ' disabled' : ''}${readOnly ? ' read-only' : ''}`} style={editorStyle}>
    <div className="settings-code-editor-toolbar">
      <span>{value.split('\n').length.toLocaleString()} lines</span>
      {fieldAction != null && <div ref={disclosureAction} className="settings-code-editor-field-action">{fieldAction}</div>}
      <button type="button" disabled={!canFormat || disabled || readOnly || formatPending} onClick={() => { /* start one local draft formatter */ void prettyFormat(); }}><PanelIcon path={panelIcons.format} />{formatPending ? 'Formatting…' : 'Format'}</button>
      {showEditor && <button
        type="button"
        className="settings-code-editor-open"
        aria-label="Open in Editor"
        aria-busy={editorPending || undefined}
        aria-describedby={`${editorDescriptionId}${editorError === undefined ? '' : ` ${editorErrorId}`}`}
        title={editorTitle}
        disabled={disabled || readOnly || editorPending || !editorSource.writable || !editorSource.exists || terminalEditor.open === undefined}
        onPointerDown={event => { /* retain the field draft until the terminal takes focus */ event.preventDefault(); }}
        onClick={() => { /* launch only the installed source capability */ void openInEditor(); }}
      ><PanelIcon path={panelIcons.external} />Open in Editor</button>}
    </div>
    <div className="settings-code-editor-surface" onClick={hintReveal}>
      <SyntaxHighlightedCode code={value} language={language} presentation preRef={presentation} />
      <textarea
        id={id}
        ref={textarea}
        aria-label={ariaLabel}
        placeholder={placeholder}
        aria-describedby={formatError === undefined ? undefined : errorId}
        aria-invalid={formatError === undefined ? undefined : true}
        value={value}
        disabled={disabled}
        readOnly={readOnly}
        spellCheck={false}
        wrap="off"
        onBlur={onBlur}
        onChange={handleChange}
        onKeyDown={event => { /* retain single-line command contracts */ if (singleLine && event.key === 'Enter') event.preventDefault(); }}
        onScroll={handleScroll}
      />
    </div>
    {showEditor && <span id={editorDescriptionId} className="sr-only settings-code-editor-launch-description">{editorTitle}</span>}
    {formatError !== undefined && <span id={errorId} className="settings-code-editor-error" role="alert">{formatError}</span>}
    {editorError !== undefined && <span id={editorErrorId} className="settings-code-editor-error" role="alert">{editorError}</span>}
  </div>;
}
