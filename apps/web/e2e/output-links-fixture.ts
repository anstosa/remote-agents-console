import { Terminal as XTerm } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { createOutputLinkOverlays } from '../src/output-links.js';
import '../src/styles.css';

let refreshTimer: number | undefined;
let terminal: XTerm | undefined;
let overlays: ReturnType<typeof createOutputLinkOverlays> | undefined;

// mount one measured terminal and its link overlays for all output fixtures
const mountOutputLinkTerminal = (container: HTMLElement, columns: number, width: string) => {
  container.style.position = 'relative';
  container.style.width = width;
  container.style.height = '200px';
  const host = document.createElement('div');
  host.style.position = 'absolute';
  host.style.inset = '0';
  container.append(host);
  const nextTerminal = new XTerm({ cols: columns, rows: 8, convertEol: true, fontSize: 14 });
  const nextOverlays = createOutputLinkOverlays(container, () => { document.body.dataset.opened = 'true'; }, path => { document.body.dataset.openedFile = path; });
  nextTerminal.open(host);
  return { terminal: nextTerminal, overlays: nextOverlays };
};

// retain handles for the repeated-render stability scenario
export const renderOutputLinks = async (container: HTMLElement) => {
  const { terminal: nextTerminal, overlays: nextOverlays } = mountOutputLinkTerminal(container, 80, '800px');
  terminal = nextTerminal;
  overlays = nextOverlays;
  await new Promise<void>(resolve => nextTerminal.write('Visit https://example.com/output for details.', () => {
    nextOverlays.render(nextTerminal);
    container.dataset.ready = 'true';
    resolve();
  }));
};

// reproduce capture rows while retaining the original popup scenario
export const renderCapturedWrappedOutputLink = async (container: HTMLElement) => {
  const uri = 'https://example.com/a/very/long/path?item=12345';
  const { terminal: nextTerminal, overlays: nextOverlays } = mountOutputLinkTerminal(container, 30, '360px');
  const firstLine = `Visit ${uri.slice(0, 24)}`;
  const secondLine = `${uri.slice(24)} for details.`;
  await new Promise<void>(resolve => nextTerminal.write(`${firstLine}\x1b[K\n${secondLine}`, () => {
    nextOverlays.render(nextTerminal);
    container.dataset.uri = uri;
    container.dataset.ready = 'true';
    resolve();
  }));
};

// render arbitrary captured or naturally wrapped rows in a real terminal
export const renderOutputLinkText = async (container: HTMLElement, output: string, columns = 30) => {
  const { terminal: nextTerminal, overlays: nextOverlays } = mountOutputLinkTerminal(container, columns, '800px');
  await new Promise<void>(resolve => nextTerminal.write(output, resolve));
  // measure overlays only after xterm's first paint
  await new Promise<void>(resolve => requestAnimationFrame(() => {
    nextOverlays.render(nextTerminal);
    resolve();
  }));
};

export const startOutputLinkRefresh = () => {
  if (!terminal || !overlays) return;
  if (refreshTimer !== undefined) window.clearInterval(refreshTimer);
  refreshTimer = window.setInterval(() => overlays?.render(terminal!), 20);
};

export const stopOutputLinkRefresh = () => {
  if (refreshTimer !== undefined) window.clearInterval(refreshTimer);
  refreshTimer = undefined;
};
