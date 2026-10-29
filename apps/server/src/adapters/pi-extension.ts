import { VERSION, type ExtensionAPI } from '@earendil-works/pi-coding-agent';

/**
 * The RAC Pi extension, loaded into every Pi the console launches (ADR 0017). Pi loads it
 * itself (`-e`), so it imports nothing from the console: the status key is the Pi client's
 * `piReportStatusKey`.
 *
 * At process startup it sends the launch report: that it loaded, whether the sandbox is engaged,
 * and Pi's version. The console dispatches nothing to the Agent until the report arrives.
 */
export default function rac(pi: ExtensionAPI): void {
  pi.on('session_start', (event, ctx) => {
    if (event.reason !== 'startup') return;
    ctx.ui.setStatus('rac-launch', JSON.stringify({ loaded: true, sandbox: { engaged: false, reason: 'not sandboxed' }, version: VERSION }));
  });
}
