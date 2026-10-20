import { expect, type Locator } from '@playwright/test';

export type ProgressColor = 'blue' | 'green' | 'yellow' | 'peach' | 'red' | 'mauve';

// waiting for the operator is not active work
export async function expectStationaryStatus(control: Locator) {
  await expect(control).not.toHaveAttribute('aria-busy', 'true');
  await expect(control.locator('.update-progress-ring')).toHaveCount(0);
  await expect.poll(() => control.evaluate(element => element.getAnimations({ subtree: true }).length)).toBe(0);
}

// verify the shared loading treatment belongs to the interactive surface itself
export async function expectProgressBorder(control: Locator, color: ProgressColor) {
  await expect(control).toHaveAttribute('aria-busy', 'true');
  await expect(control).toHaveCSS('opacity', '1');
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

// reduced motion swaps the travelling border for one compact semantic spinner
export async function expectReducedMotionSpinner(control: Locator, color: ProgressColor) {
  await expect(control).toHaveAttribute('aria-busy', 'true');
  await expect(control).toHaveCSS('opacity', '1');
  const spinner = control.locator(':scope > .update-progress-ring');
  await expect(spinner).toBeVisible();
  const treatment = await control.evaluate((element, name) => {
    const spinner = element.querySelector<HTMLElement>(':scope > .update-progress-ring');
    // expose a missing direct spinner to the assertion
    if (spinner === null) return null;
    const ownerStyle = getComputedStyle(element);
    const spinnerStyle = getComputedStyle(spinner);
    const borderStyle = getComputedStyle(spinner, '::before');
    const indicatorStyle = getComputedStyle(spinner, '::after');
    const animations = spinner.getAnimations({ subtree: true });
    const animation = animations[0];
    const expectedToken = ownerStyle.getPropertyValue(`--${name}`).trim();
    const sample = document.createElement('span');
    sample.style.color = expectedToken;
    element.append(sample);
    const expectedColor = getComputedStyle(sample).color;
    sample.remove();
    let rotation: { start: number; quarter: number } | null = null;
    // sample the painted spinner to prove its keyframes actually rotate
    if (animation !== undefined && animation.effect instanceof KeyframeEffect) {
      const duration = animation.effect.getComputedTiming().duration;
      // require one finite cycle before seeking it
      if (typeof duration === 'number' && Number.isFinite(duration) && duration > 0) {
        animation.pause();
        animation.currentTime = 0;
        const startMatrix = new DOMMatrixReadOnly(getComputedStyle(spinner, '::after').transform);
        animation.currentTime = duration / 4;
        const quarterMatrix = new DOMMatrixReadOnly(getComputedStyle(spinner, '::after').transform);
        animation.play();
        rotation = {
          start: Math.round(Math.atan2(startMatrix.b, startMatrix.a) * 180 / Math.PI),
          quarter: Math.round(Math.atan2(quarterMatrix.b, quarterMatrix.a) * 180 / Math.PI)
        };
      }
    }
    return {
      animationCount: animations.length,
      animationName: animation instanceof CSSAnimation ? animation.animationName : '',
      backgroundImage: indicatorStyle.backgroundImage,
      borderLeftColor: indicatorStyle.borderLeftColor,
      borderRadius: indicatorStyle.borderRadius,
      borderTopWidth: Number.parseFloat(indicatorStyle.borderTopWidth),
      borderTopColor: indicatorStyle.borderTopColor,
      borderOrbitDisplay: borderStyle.display,
      boxShadow: indicatorStyle.boxShadow,
      expectedColor,
      filter: spinnerStyle.filter,
      height: Number.parseFloat(indicatorStyle.height),
      progressToken: ownerStyle.getPropertyValue('--progress-ring-color').trim(),
      expectedToken,
      pseudo: animation?.effect instanceof KeyframeEffect ? animation.effect.pseudoElement : null,
      ringTarget: animation?.effect instanceof KeyframeEffect && animation.effect.target === spinner,
      rotation,
      width: Number.parseFloat(indicatorStyle.width)
    };
  }, color);
  // fail clearly when the indicator disappeared during inspection
  if (treatment === null) throw new Error('reduced-motion spinner is missing');
  expect(treatment.animationCount).toBe(1);
  expect(treatment.animationName).toBe('progress-spinner');
  expect(treatment.backgroundImage).toBe('none');
  expect(treatment.borderLeftColor).toBe('rgba(0, 0, 0, 0)');
  expect(treatment.borderRadius).toBe('50%');
  expect(treatment.borderTopWidth).toBeGreaterThan(0);
  expect(treatment.borderTopColor).toBe(treatment.expectedColor);
  expect(treatment.borderOrbitDisplay).toBe('none');
  expect(treatment.boxShadow).toBe('none');
  expect(treatment.filter).toBe('none');
  expect(treatment.progressToken).toBe(treatment.expectedToken);
  expect(treatment.width).toBeGreaterThan(0);
  expect(treatment.width).toBeLessThanOrEqual(24);
  expect(treatment.height).toBe(treatment.width);
  expect(treatment.pseudo).toBe('::after');
  expect(treatment.ringTarget).toBe(true);
  expect(treatment.rotation).toEqual({ start: 0, quarter: 90 });
}

// match each loading border to its intended split surface
export async function expectSplitProgressBorder(panel: Locator, color: ProgressColor) {
  await expectProgressBorder(panel.locator('.log-loading'), color);
  await expect.poll(() => panel.evaluate(element => {
    const ring = element.querySelector('.log-loading > .update-progress-ring');
    // expose a missing border to the geometry assertion
    if (ring === null) return Infinity;
    const owner = element.getBoundingClientRect();
    const border = ring.getBoundingClientRect();
    return Math.max(
      Math.abs(owner.top - border.top),
      Math.abs(owner.right - border.right),
      Math.abs(owner.bottom - border.bottom),
      Math.abs(owner.left - border.left)
    );
  })).toBeLessThanOrEqual(1);
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
