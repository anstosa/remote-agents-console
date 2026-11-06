import { describe, expect, it } from 'vitest';
import { isVimCommand, navigateDirection } from '../../web/src/terminal-navigation.js';

describe('terminal navigation', () => {
  it('treats the commands vim-tmux-navigator does as vim, except fzf', () => {
    for (const command of ['vim', 'nvim', 'vi', 'view', 'gvim', 'vimdiff', 'nvimdiff', 'lvim', 'vimx']) expect(isVimCommand(command), command).toBe(true);
    for (const command of [undefined, '', 'zsh', 'fish', 'fzf', 'claude', 'node', 'nvim-qt', 'xvim']) expect(isVimCommand(command), String(command)).toBe(false);
  });

  it('reads only left and right from an OSC 7337 navigate payload', () => {
    expect(navigateDirection('navigate;left')).toBe('left');
    expect(navigateDirection('navigate;right')).toBe('right');
    for (const data of ['navigate;up', 'navigate;down', 'navigate', 'left', 'navigate;Left', '']) expect(navigateDirection(data), data).toBeUndefined();
  });
});
