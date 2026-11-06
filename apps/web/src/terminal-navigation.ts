// The browser half of vim-tmux-navigator for RAC panels (effort "Navigate between nvim splits and
// RAC panels"): `navigate-left`/`-right` step aside for a Terminal running vim, and vim at its edge
// hands back with `OSC 7337 ; navigate ; left|right`.

export type NavigateDirection = 'left' | 'right';

// the OSC number nvim writes at a split edge
export const navigateOsc = 7337;

// vim-tmux-navigator's `is_vim` pattern without fzf, matched against tmux's `pane_current_command`
export const isVimCommand = (command: string | undefined): boolean => command !== undefined && /^g?(view|l?n?vim?x?)(diff)?$/u.test(command);

// the direction an OSC 7337 payload (`navigate;left`) asks for; anything else is ignored
export const navigateDirection = (data: string): NavigateDirection | undefined => {
  const [verb, direction] = data.split(';');
  return verb === 'navigate' && (direction === 'left' || direction === 'right') ? direction : undefined;
};
