import { expect, type Locator } from '@playwright/test';

export type ProgressColor = 'blue' | 'green' | 'yellow' | 'peach' | 'red' | 'mauve';

// verify the shared loading treatment belongs to the interactive surface itself
export async function expectProgressBorder(control: Locator, color: ProgressColor, busy = true) {
  // distinguish progress from completed attention
  if (busy) {
    await expect(control).toHaveAttribute('aria-busy', 'true');
    await expect(control).toHaveCSS('opacity', '1');
  }
  else await expect(control).not.toHaveAttribute('aria-busy', 'true');
  const theme = await control.evaluate((element, name) => {
    const style = getComputedStyle(element);
    return {
      actual: style.getPropertyValue('--progress-ring-color').trim(),
      expected: style.getPropertyValue(`--${name}`).trim()
    };
  }, color);
  expect(theme.expected).not.toBe('');
  expect(theme.actual).toBe(theme.expected);
  await expect(control).not.toHaveClass(/(?:^|\s)spinner(?:\s|$)/u);
  await expect(control.locator('.spinner')).toHaveCount(0);
  const ring = control.locator(':scope > .update-progress-ring');
  await expect(ring).toBeVisible();
  const geometry = await control.evaluate(element => {
    const ring = element.querySelector<HTMLElement>(':scope > .update-progress-ring');
    // expose a missing direct ring to the assertion
    if (ring === null) return null;
    const owner = element.getBoundingClientRect();
    const border = ring.getBoundingClientRect();
    return {
      bottom: Math.abs(owner.bottom + 1 - border.bottom),
      left: Math.abs(owner.left - 1 - border.left),
      right: Math.abs(owner.right + 1 - border.right),
      top: Math.abs(owner.top - 1 - border.top)
    };
  });
  expect(geometry).not.toBeNull();
  expect(Math.max(geometry!.top, geometry!.right, geometry!.bottom, geometry!.left)).toBeLessThanOrEqual(1);
}

// verify the visual orbit advances clockwise without moving the owning control
export async function expectClockwiseProgressBorder(control: Locator) {
  await expect.poll(() => control.evaluate(element => {
    const ring = element.querySelector<HTMLElement>(':scope > .update-progress-ring');
    // expose a missing direct ring to the assertion
    if (ring === null) return null;
    const animations = element.getAnimations({ subtree: true });
    const animation = animations[0];
    // require the shared live orbit
    if (animation === undefined) return null;
    const effect = animation.effect as KeyframeEffect;
    const duration = effect.getComputedTiming().duration;
    // require one finite cycle before sampling it
    if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) return null;
    animation.pause();
    animation.currentTime = 0;
    const start = Number.parseFloat(getComputedStyle(ring, '::before').getPropertyValue('--update-orbit-angle'));
    animation.currentTime = duration / 4;
    const quarter = Number.parseFloat(getComputedStyle(ring, '::before').getPropertyValue('--update-orbit-angle'));
    animation.play();
    return {
      animationCount: animations.length,
      direction: effect.getTiming().direction,
      iterations: effect.getTiming().iterations,
      name: animation instanceof CSSAnimation ? animation.animationName : '',
      ownerTransform: getComputedStyle(element).transform,
      pseudo: effect.pseudoElement,
      quarter,
      ringTarget: effect.target === ring,
      start
    };
  })).toEqual({
    animationCount: 1,
    direction: 'normal',
    iterations: Infinity,
    name: 'update-border-orbit',
    ownerTransform: 'none',
    pseudo: '::before',
    quarter: 90,
    ringTarget: true,
    start: 0
  });
}
