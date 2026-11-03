import { beforeEach, describe, expect, it, vi } from 'vitest';

const run = vi.fn();
vi.mock('../src/tmux/command.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../src/tmux/command.js')>()), run }));
const { recolorConsolePanes } = await import('../src/tmux/terminal-colors.js');

const mocha = 'fg=#cdd6f4,bg=#1e1e2e';
const latte = 'fg=#4c4f69,bg=#eff1f5';

describe('recolorConsolePanes', () => {
  beforeEach(() => {
    run.mockReset();
    run.mockImplementation(async (_binary: string, args: string[]) => {
      if (args.includes('list-clients')) return { code: 0, stdout: '$2|0|0\n$3|1|\n$4|0|1\n', stderr: '' };
      if (args.includes('list-panes')) return { code: 0, stdout: [
        `$1|%1|${mocha}|${mocha}`, // console-coloured, headless
        '$1|%2|default|default', // never coloured by the console
        `$1|%3|${mocha}|fg=#f5c2e7,bg=#11111b`, // partially custom
        `$1|%4|${latte}|${latte}`, // already the target theme
        `$2|%5|${mocha}|${mocha}`, // a real terminal is attached
        `$3|%6|${mocha}|${mocha}`, // only a control client is attached
        `$4|%7|${mocha}|${mocha}` // the real terminal is suspended
      ].join('\n') + '\n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    });
  });

  it('recolours only headless panes holding one console theme pair', async () => {
    await recolorConsolePanes('/usr/bin/tmux', '/tmp/tmux/default', 'latte');
    const recoloured = run.mock.calls.map(([, args]) => args as string[]).filter(args => args.includes('set-option')).map(args => args[args.indexOf('-t') + 1]);
    expect(recoloured.sort()).toEqual(['%1', '%6', '%7']);
    expect(run).toHaveBeenCalledWith('/usr/bin/tmux', ['-S', '/tmp/tmux/default', 'set-option', '-p', '-t', '%1', 'window-style', latte, ';', 'set-option', '-p', '-t', '%1', 'window-active-style', latte]);
  });

  it('changes nothing when tmux cannot list clients', async () => {
    run.mockImplementationOnce(async () => ({ code: 1, stdout: '', stderr: 'no server' }));
    await recolorConsolePanes('/usr/bin/tmux', '/tmp/tmux/default', 'latte');
    expect(run.mock.calls.some(([, args]) => (args as string[]).includes('set-option'))).toBe(false);
  });
});
