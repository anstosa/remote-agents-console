import { useState } from 'react';
import { FlyoutPortal } from './flyout-portal.js';
import { useViewportFlyout } from './viewport-flyout.js';

/** The model and Effort a structured Agent runs on, as the dashboard reports it. */
export type AgentModel = { id: string; name?: string; effort?: string };
type ModelRow = { id: string; name: string; provider: string; inputPrice?: number; outputPrice?: number; contextWindow?: number; efforts: string[] };
type Request = (url: string, init?: RequestInit) => Promise<Response>;

const price = (dollars: number | undefined): string => dollars === undefined ? '?' : `$${dollars}`;
const contextWindow = (tokens: number | undefined): string => tokens === undefined ? '' : ` · ${tokens >= 1_000_000 ? `${tokens / 1_000_000}M` : `${Math.round(tokens / 1_000)}k`} context`;
const failure = async (response: Response): Promise<string> => ((await response.json().catch(() => undefined)) as { error?: string } | undefined)?.error ?? 'The model could not be switched.';

/**
 * The model chip in a structured Agent's header: the model and Effort it runs on. With Allowed
 * models configured it opens a picker of them, in the operator's order, with the Efforts the
 * current model supports beside it. A switch applies from the next prompt; while the Agent works
 * the picker only says to cancel the turn first.
 */
export function ModelChip({ agentId, model, switchable, working, request, onError }: { agentId: string; model: AgentModel; switchable: boolean; working: boolean; request: Request; onError: (message: string) => void }) {
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<ModelRow[]>();
  const [pending, setPending] = useState(false);
  const { anchorRef, flyoutRef, style } = useViewportFlyout<HTMLDivElement>(open);
  const label = `${model.name ?? model.id}${model.effort === undefined ? '' : ` · ${model.effort}`}`;
  if (!switchable) return <span className="model-chip" title={model.id}>{label}</span>;
  const base = `/api/agents/${encodeURIComponent(agentId)}`;
  const toggle = async () => {
    if (open) return setOpen(false);
    setOpen(true);
    const response = await request(`${base}/models`).catch(() => undefined);
    if (response?.ok === true) setModels(((await response.json()) as { models: ModelRow[] }).models);
    else onError('The Allowed models could not be loaded.');
  };
  const choose = async (setting: { model: string; effort?: string }) => {
    setPending(true);
    try {
      const response = await request(`${base}/model`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(setting) });
      if (response.ok) setOpen(false); else onError(await failure(response));
    } catch {
      onError('The console could not be reached. The model was not switched.');
    } finally {
      setPending(false);
    }
  };
  const current = models?.find(row => row.id === model.id);
  const disabled = working || pending;
  return <div className="model-chip-control" ref={anchorRef}>
    <button type="button" className={`model-chip${open ? ' active' : ''}`} aria-haspopup="dialog" aria-expanded={open} title={working ? 'Cancel the turn to switch' : 'Model and Effort'} onClick={() => void toggle()}>{label}<span className="flyout-caret" aria-hidden="true" /></button>
    {open && <FlyoutPortal onDismiss={() => setOpen(false)}><div ref={flyoutRef} className="model-picker" style={style} role="dialog" aria-label="Model and Effort">
      <p className="model-picker-heading">Model · Allowed models</p>
      {working && <p className="model-picker-warning" role="status">Cancel the turn to switch</p>}
      {models === undefined ? <p className="model-picker-note">Loading…</p> : models.map(row => <button key={row.id} type="button" className={`model-row${row.id === model.id ? ' current' : ''}`} aria-current={row.id === model.id || undefined} disabled={disabled} onClick={() => { if (row.id !== model.id) void choose({ model: row.id }); }}>
        <strong>{row.name}</strong><small>{row.provider}</small>
        <span>{price(row.inputPrice)} in · {price(row.outputPrice)} out per 1M{contextWindow(row.contextWindow)}</span>
      </button>)}
      {current !== undefined && <>
        <p className="model-picker-heading">Effort · {current.name}</p>
        <div className="model-efforts" role="group" aria-label="Effort">{current.efforts.map(effort => <button key={effort} type="button" aria-pressed={effort === model.effort} disabled={disabled} onClick={() => { if (effort !== model.effort) void choose({ model: model.id, effort }); }}>{effort}</button>)}</div>
      </>}
      <p className="model-picker-note">Applies from the next prompt, queued prompts included.</p>
    </div></FlyoutPortal>}
  </div>;
}
