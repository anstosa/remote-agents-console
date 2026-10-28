import { expect, type Locator } from '@playwright/test';

export type ProgressColor = 'blue' | 'green' | 'yellow' | 'peach' | 'red' | 'mauve';
// keep motion semantics private to this assertion module
type ProgressKind = 'loading' | 'working';

// map semantic motion to its public keyframe contract
const animationName = (kind: ProgressKind) => kind === 'loading' ? 'loading-border-orbit' : 'update-border-orbit';

// require the semantic owner marker without coupling tests to component internals
async function expectProgressKind(control: Locator, kind: ProgressKind) {
  // require the explicit loading override
  if (kind === 'loading') {
    await expect(control).toHaveClass(/(?:^|\s)progress-loading(?:\s|$)/u);
    return;
  }
  await expect(control).not.toHaveClass(/(?:^|\s)progress-loading(?:\s|$)/u);
}

// waiting for the operator is not active work
export async function expectStationaryStatus(control: Locator) {
  await expect(control).not.toHaveAttribute('aria-busy', 'true');
  await expect(control.locator('.update-progress-ring')).toHaveCount(0);
  await expect.poll(() => control.evaluate(element => element.getAnimations({ subtree: true }).length)).toBe(0);
}

// verify the shared progress treatment belongs to the interactive surface itself
export async function expectProgressBorder(control: Locator, color: ProgressColor, kind?: ProgressKind) {
  await expect(control).toHaveAttribute('aria-busy', 'true');
  // assert classification only where the scenario owns the semantic contract
  if (kind !== undefined) await expectProgressKind(control, kind);
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
export async function expectReducedMotionSpinner(control: Locator, color: ProgressColor, kind?: ProgressKind) {
  await expect(control).toHaveAttribute('aria-busy', 'true');
  // keep loading and working semantics through the compact treatment
  if (kind !== undefined) await expectProgressKind(control, kind);
  await expect(control).toHaveCSS('opacity', '1');
  const spinner = control.locator(':scope > .update-progress-ring');
  await expect(spinner).toBeVisible();
  // allow the animationstart synchronizer one rendered frame
  await expect.poll(() => spinner.evaluate(element => element.getAnimations({ subtree: true })[0]?.startTime)).toBe(0);
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
    const originalStartTime = animation?.startTime ?? null;
    const originalCurrentTime = animation?.currentTime ?? null;
    const originalPlayState = animation?.playState;
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
        // restore the synchronized shared clock after local sampling
        if (originalPlayState === 'running') {
          animation.play();
          animation.startTime = originalStartTime;
        } else {
          animation.currentTime = originalCurrentTime;
        }
        rotation = {
          start: Math.round(Math.atan2(startMatrix.b, startMatrix.a) * 180 / Math.PI),
          quarter: Math.round(Math.atan2(quarterMatrix.b, quarterMatrix.a) * 180 / Math.PI)
        };
      }
    }
    return {
      animationCount: animations.length,
      animationDuration: animation?.effect?.getComputedTiming().duration,
      animationEasing: animation?.effect?.getTiming().easing,
      animationName: animation instanceof CSSAnimation ? animation.animationName : '',
      animationStartTime: originalStartTime,
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
  expect(treatment.animationDuration).toBe(1_000);
  expect(treatment.animationEasing).toBe('linear');
  expect(treatment.animationName).toBe('progress-spinner');
  expect(treatment.animationStartTime).toBe(0);
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
export async function expectClockwiseProgressBorder(control: Locator, expectedKind?: ProgressKind) {
  const kind: ProgressKind = expectedKind ?? await control.evaluate(element => element.classList.contains('progress-loading') ? 'loading' : 'working');
  await expectProgressKind(control, kind);
  // allow a replacement animationstart event one rendered frame
  await expect.poll(() => control.evaluate((element, name) => {
    const ring = element.querySelector<HTMLElement>(':scope > .update-progress-ring');
    const animation = ring?.getAnimations({ subtree: true }).find(candidate => candidate instanceof CSSAnimation && candidate.animationName === name);
    return animation?.startTime ?? null;
  }, animationName(kind))).toBe(0);
  // isolate sampling so polling does not discard the observed treatment
  const inspect = () => control.evaluate(element => {
    const ring = element.querySelector<HTMLElement>(':scope > .update-progress-ring');
    // expose a missing direct ring to the assertion
    if (ring === null) return null;
    const animations = ring.getAnimations({ subtree: true });
    // select the shared border instead of transient owner effects
    const animation = animations.find(candidate => candidate instanceof CSSAnimation && candidate.effect instanceof KeyframeEffect && candidate.effect.target === ring && candidate.effect.pseudoElement === '::before');
    // require the shared live orbit
    if (animation === undefined) return null;
    const effect = animation.effect as KeyframeEffect;
    const duration = effect.getComputedTiming().duration;
    // require one finite cycle before sampling it
    if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) return null;
    const originalStartTime = animation.startTime;
    const originalCurrentTime = animation.currentTime;
    const originalPlayState = animation.playState;
    // sample equal points across both half turns
    const samples = [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 0.999].map(portion => {
      animation.pause();
      animation.currentTime = duration * portion;
      return Number.parseFloat(getComputedStyle(ring, '::before').getPropertyValue('--update-orbit-angle'));
    });
    // restore the synchronized shared clock after local sampling
    if (originalPlayState === 'running') {
      animation.play();
      animation.startTime = originalStartTime;
    } else {
      animation.currentTime = originalCurrentTime;
    }
    return {
      animationCount: animations.length,
      duration,
      direction: effect.getTiming().direction,
      easing: effect.getTiming().easing,
      iterations: effect.getTiming().iterations,
      name: animation instanceof CSSAnimation ? animation.animationName : '',
      ownerTransform: getComputedStyle(element).transform,
      pseudo: effect.pseudoElement,
      ringTarget: effect.target === ring,
      samples,
      startTime: originalStartTime
    };
  });
  const treatment = await inspect();
  expect(treatment).not.toBeNull();
  expect(treatment).toMatchObject({
    animationCount: 1,
    duration: 2_000,
    direction: 'normal',
    easing: 'linear',
    iterations: Infinity,
    name: animationName(kind),
    ownerTransform: 'none',
    pseudo: '::before',
    ringTarget: true,
    startTime: 0
  });
  const samples = treatment!.samples;
  expect(samples[0]).toBeCloseTo(0, 0);
  expect(samples[2]).toBeCloseTo(90, 0);
  expect(samples[4]).toBeCloseTo(180, 0);
  expect(samples[6]).toBeCloseTo(270, 0);
  expect(samples[8]).toBeCloseTo(360, 0);
  // distinguish constant loading from two accelerated working intervals
  if (kind === 'loading') {
    expect(samples[1]).toBeCloseTo(45, 0);
    expect(samples[3]).toBeCloseTo(135, 0);
    expect(samples[5]).toBeCloseTo(225, 0);
    expect(samples[7]).toBeCloseTo(315, 0);
  } else {
    expect(samples[1]).toBeLessThan(40);
    expect(samples[3]).toBeGreaterThan(140);
    expect(samples[5]).toBeLessThan(220);
    expect(samples[7]).toBeGreaterThan(320);
  }
}

// compare live phases before any helper seeks an animation locally
export async function expectSynchronizedProgressBorders(controls: Locator, count: number, kind: ProgressKind, reducedMotion = false) {
  await expect(controls).toHaveCount(count);
  const expectedName = reducedMotion ? 'progress-spinner' : animationName(kind);
  const expectedDuration = reducedMotion ? 1_000 : 2_000;
  // inspect every owner in one browser task
  await expect.poll(() => controls.evaluateAll((elements, expected) => {
    // capture live clocks before any local seek
    const observations = elements.map(element => {
      const ring = element.querySelector<HTMLElement>(':scope > .update-progress-ring');
      const animation = ring?.getAnimations({ subtree: true })[0];
      const duration = animation?.effect?.getComputedTiming().duration;
      return {
        duration,
        kind: element.classList.contains('progress-loading') ? 'loading' : 'working',
        name: animation instanceof CSSAnimation ? animation.animationName : '',
        phase: typeof animation?.currentTime === 'number' && typeof duration === 'number' ? ((animation.currentTime % duration) + duration) % duration : null,
        startTime: animation?.startTime
      };
    });
    // compare phases across the cycle boundary
    let maximumPhaseDelta = 0;
    // visit each unique animation pair
    for (let index = 0; index < observations.length; index += 1) {
      // compare later animations only
      for (let next = index + 1; next < observations.length; next += 1) {
        const first = observations[index].phase;
        const second = observations[next].phase;
        // report incomplete animations until the synchronizer observes them
        if (first === null || second === null) return { classified: false, duration: false, name: false, phase: false, start: false };
        const delta = Math.abs(first - second);
        maximumPhaseDelta = Math.max(maximumPhaseDelta, Math.min(delta, expected.duration - delta));
      }
    }
    // reduce observations to stable poll flags
    return {
      classified: observations.every(observation => observation.kind === expected.kind),
      duration: observations.every(observation => observation.duration === expected.duration),
      name: observations.every(observation => observation.name === expected.name),
      phase: maximumPhaseDelta <= 34,
      start: observations.every(observation => observation.startTime === 0)
    };
  }, { duration: expectedDuration, kind, name: expectedName })).toEqual({ classified: true, duration: true, name: true, phase: true, start: true });
}
