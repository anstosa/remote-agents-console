import { expect, type Locator } from '@playwright/test';

export type ProgressColor = 'blue' | 'green' | 'yellow' | 'peach' | 'red' | 'mauve';
type ProgressKind = 'loading' | 'working';

// require the semantic loading marker only when the scenario owns it
async function expectProgressKind(control: Locator, kind: ProgressKind) {
  // loading takes precedence over the retained working treatment
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

// verify the progress treatment belongs to the semantic owner without changing its size
export async function expectProgressBorder(control: Locator, color: ProgressColor, kind?: ProgressKind) {
  await expect(control).toHaveAttribute('aria-busy', 'true');
  // assert classification only where the scenario owns the semantic contract
  if (kind !== undefined) await expectProgressKind(control, kind);
  await expect(control).toHaveCSS('opacity', '1');
  await expect(control).not.toHaveClass(/(?:^|\s)spinner(?:\s|$)/u);
  await expect(control.locator('.spinner')).toHaveCount(0);
  const ring = control.locator(':scope > .update-progress-ring');
  await expect(ring).toBeVisible();
  const treatment = await control.evaluate((element, name) => {
    const progressRing = element.querySelector<HTMLElement>(':scope > .update-progress-ring');
    // expose incomplete progress markup to the assertion
    if (progressRing === null) return null;
    const owner = element.getBoundingClientRect();
    const ownerStyle = getComputedStyle(element);
    const ringBounds = progressRing.getBoundingClientRect();
    const ringStyle = getComputedStyle(progressRing);
    const borderStyle = getComputedStyle(progressRing, '::before');
    const indicatorStyle = getComputedStyle(progressRing, '::after');
    const expectedToken = ownerStyle.getPropertyValue(`--${name}`).trim();
    const sample = document.createElement('span');
    sample.style.color = expectedToken;
    element.append(sample);
    const expectedColor = getComputedStyle(sample).color;
    sample.remove();
    const textButton = element.tagName === 'BUTTON'
      && !element.classList.contains('progress-icon-button')
      && !element.classList.contains('progress-status-button');
    const responsiveToolbarText = textButton
      && element.matches('.workspace-toolbar-actions button.toolbar-button:has(> .toolbar-label)')
      && matchMedia('(max-width: 600px)').matches;
    const glyph = element.querySelector<HTMLElement>(':scope > svg');
    return {
      borderBackground: borderStyle.backgroundImage,
      borderColor: borderStyle.borderTopColor,
      borderRadius: borderStyle.borderRadius,
      borderWidth: Number.parseFloat(borderStyle.borderTopWidth),
      expectedColor,
      expectedToken,
      hasLegacyRunner: progressRing.querySelector('.working-progress-runner') !== null,
      iconClassificationValid: !element.classList.contains('progress-icon-button') || element.tagName === 'BUTTON',
      indicatorLeft: Number.parseFloat(indicatorStyle.left),
      indicatorPosition: indicatorStyle.position,
      indicatorTop: Number.parseFloat(indicatorStyle.top),
      indicatorTranslate: indicatorStyle.translate,
      glyphVisibility: glyph === null ? null : getComputedStyle(glyph).visibility,
      ownerHeight: owner.height,
      ownerTransform: ownerStyle.transform,
      ownerWidth: owner.width,
      pointerEvents: ringStyle.pointerEvents,
      progressToken: ownerStyle.getPropertyValue('--progress-ring-color').trim(),
      ringHeight: ringBounds.height,
      ringPosition: ringStyle.position,
      ringWidth: ringBounds.width,
      responsiveToolbarText,
      textButton
    };
  }, color);
  // fail clearly when the direct ring disappeared during inspection
  if (treatment === null) throw new Error('progress border is missing');
  expect(treatment.expectedToken).not.toBe('');
  expect(treatment.progressToken).toBe(treatment.expectedToken);
  expect(treatment.borderColor).toBe(treatment.expectedColor);
  expect(treatment.borderWidth).toBe(2);
  expect(treatment.borderBackground).not.toContain('gradient');
  expect(treatment.hasLegacyRunner).toBe(false);
  expect(treatment.iconClassificationValid).toBe(true);
  expect(treatment.ownerTransform).toBe('none');
  expect(treatment.ownerWidth).toBeGreaterThan(0);
  expect(treatment.ownerHeight).toBeGreaterThan(0);
  expect(treatment.pointerEvents).toBe('none');
  expect(treatment.ringWidth).toBeGreaterThan(0);
  expect(treatment.ringHeight).toBeGreaterThan(0);
  // text buttons reserve only the compact spinner slot beside their label
  if (treatment.textButton) {
    // narrow icon presentations center the spinner without pretending to be an icon-only control
    if (treatment.responsiveToolbarText) {
      expect(treatment.ringPosition).toBe('absolute');
      expect(treatment.indicatorPosition).toBe('absolute');
      expect(treatment.indicatorTop).toBeCloseTo(treatment.ringHeight / 2, 1);
      expect(treatment.indicatorLeft).toBeCloseTo(treatment.ringWidth / 2, 1);
      expect(treatment.indicatorTranslate).toBe('-50% -50%');
      expect(treatment.glyphVisibility).toBe('hidden');
    } else {
      expect(treatment.ringPosition).toBe('static');
      expect(treatment.ringWidth).toBeLessThanOrEqual(16);
      expect(treatment.ringHeight).toBe(treatment.ringWidth);
    }
  } else {
    expect(treatment.ringPosition).toBe('absolute');
  }
}

// prove one shared phase paints the breathing border and any compact busy indicator
export async function expectBreathingProgressBorder(control: Locator, expectedKind?: ProgressKind) {
  const kind: ProgressKind = expectedKind ?? await control.evaluate(element => element.classList.contains('progress-loading') ? 'loading' : 'working');
  await expectProgressKind(control, kind);
  await expect.poll(() => control.evaluate(element => {
    const ring = element.querySelector<HTMLElement>(':scope > .update-progress-ring');
    // expose an incomplete registration until the shared clock publishes a phase
    if (ring === null) return null;
    const phaseTarget = element.classList.contains('progress-status-button') ? element as HTMLElement : ring;
    const phase = Number.parseFloat(getComputedStyle(phaseTarget).getPropertyValue('--progress-phase'));
    const borderOpacity = Number.parseFloat(getComputedStyle(ring, '::before').opacity);
    const activeProgressAnimations = element.getAnimations({ subtree: true }).filter(animation => animation instanceof CSSAnimation
      && animation.animationName.startsWith('progress-') && (animation.playState === 'running' || animation.pending)).length;
    const candidates: Array<{ pseudo: string | null; target: Element }> = [];
    // status surfaces reuse their authored dot slots
    if (element.matches(".tabs button[role='tab'].progress-status-button")) candidates.push({ target: element, pseudo: '::after' });
    if (element.classList.contains('progress-status-button')) {
      candidates.push({ target: element, pseudo: '::before' }, { target: element, pseudo: '::after' });
    }
    const agentPill = element.querySelector('.agent-state-pill');
    // agent rows replace the pill's leading dot
    if (agentPill !== null) candidates.push({ target: agentPill, pseudo: '::before' });
    const workspaceEntry = element.querySelector('.workspace-sheet-entry');
    // workspace rows replace the entry's trailing dot
    if (workspaceEntry !== null) candidates.push({ target: workspaceEntry, pseudo: '::after' });
    // generic status controls animate the original dot element
    for (const target of element.querySelectorAll(':scope > .stack-process-dot, :scope > .project-stack-status-dot, :scope > .server-switcher-attention, :scope > .git-status-dot, :scope > .launch-update-dot')) {
      candidates.push({ target, pseudo: null });
    }
    const projectIndicator = element.matches('.project-open.progress-status-button') ? element.querySelector(':scope > i') : null;
    // project launch controls reuse their compact authored indicator
    if (projectIndicator !== null) candidates.push({ target: projectIndicator, pseudo: null });
    // text and icon controls use the ring's compact after slot
    candidates.push({ target: ring, pseudo: '::after' });
    const spinner = candidates.map(({ target, pseudo }) => getComputedStyle(target, pseudo)).find(style => style.display !== 'none' && Number.parseFloat(style.borderTopWidth) > 0 && Number.parseFloat(style.width) > 0);
    return {
      activeProgressAnimations,
      borderOpacity,
      expectsSpinner: element.tagName === 'BUTTON' || element.classList.contains('progress-status-button'),
      phase,
      spinnerTransform: spinner?.transform ?? null
    };
  })).not.toBeNull();
  const initialPaint = await control.evaluate(element => {
    const ring = element.querySelector<HTMLElement>(':scope > .update-progress-ring')!;
    const phaseTarget = element.classList.contains('progress-status-button') ? element as HTMLElement : ring;
    const candidates: Array<{ pseudo: string | null; target: Element }> = [];
    // collect every supported existing indicator slot
    if (element.matches(".tabs button[role='tab'].progress-status-button")) candidates.push({ target: element, pseudo: '::after' });
    if (element.classList.contains('progress-status-button')) candidates.push({ target: element, pseudo: '::before' }, { target: element, pseudo: '::after' });
    const agentPill = element.querySelector('.agent-state-pill');
    if (agentPill !== null) candidates.push({ target: agentPill, pseudo: '::before' });
    const workspaceEntry = element.querySelector('.workspace-sheet-entry');
    if (workspaceEntry !== null) candidates.push({ target: workspaceEntry, pseudo: '::after' });
    // include each authored element indicator
    for (const target of element.querySelectorAll(':scope > .stack-process-dot, :scope > .project-stack-status-dot, :scope > .server-switcher-attention, :scope > .git-status-dot, :scope > .launch-update-dot')) candidates.push({ target, pseudo: null });
    const projectIndicator = element.matches('.project-open.progress-status-button') ? element.querySelector(':scope > i') : null;
    if (projectIndicator !== null) candidates.push({ target: projectIndicator, pseudo: null });
    candidates.push({ target: ring, pseudo: '::after' });
    const spinner = candidates.map(({ target, pseudo }) => getComputedStyle(target, pseudo)).find(style => style.display !== 'none' && Number.parseFloat(style.borderTopWidth) > 0 && Number.parseFloat(style.width) > 0);
    return {
      borderOpacity: Number.parseFloat(getComputedStyle(ring, '::before').opacity),
      phase: Number.parseFloat(getComputedStyle(phaseTarget).getPropertyValue('--progress-phase')),
      spinnerTransform: spinner?.transform ?? null
    };
  });
  // the shared presentation clock changes actual paint without native animation handles
  await expect.poll(() => control.evaluate((element, before) => {
    const ring = element.querySelector<HTMLElement>(':scope > .update-progress-ring')!;
    const phaseTarget = element.classList.contains('progress-status-button') ? element as HTMLElement : ring;
    const candidates: Array<{ pseudo: string | null; target: Element }> = [];
    if (element.matches(".tabs button[role='tab'].progress-status-button")) candidates.push({ target: element, pseudo: '::after' });
    if (element.classList.contains('progress-status-button')) candidates.push({ target: element, pseudo: '::before' }, { target: element, pseudo: '::after' });
    const agentPill = element.querySelector('.agent-state-pill');
    if (agentPill !== null) candidates.push({ target: agentPill, pseudo: '::before' });
    const workspaceEntry = element.querySelector('.workspace-sheet-entry');
    if (workspaceEntry !== null) candidates.push({ target: workspaceEntry, pseudo: '::after' });
    for (const target of element.querySelectorAll(':scope > .stack-process-dot, :scope > .project-stack-status-dot, :scope > .server-switcher-attention, :scope > .git-status-dot, :scope > .launch-update-dot')) candidates.push({ target, pseudo: null });
    const projectIndicator = element.matches('.project-open.progress-status-button') ? element.querySelector(':scope > i') : null;
    if (projectIndicator !== null) candidates.push({ target: projectIndicator, pseudo: null });
    candidates.push({ target: ring, pseudo: '::after' });
    const spinner = candidates.map(({ target, pseudo }) => getComputedStyle(target, pseudo)).find(style => style.display !== 'none' && Number.parseFloat(style.borderTopWidth) > 0 && Number.parseFloat(style.width) > 0);
    const phase = Number.parseFloat(getComputedStyle(phaseTarget).getPropertyValue('--progress-phase'));
    const borderOpacity = Number.parseFloat(getComputedStyle(ring, '::before').opacity);
    const spinnerTransform = spinner?.transform ?? null;
    const expectsSpinner = element.tagName === 'BUTTON' || element.classList.contains('progress-status-button');
    return {
      borderPaintMoved: borderOpacity !== before.borderOpacity,
      phaseMoved: Number.isFinite(phase) && phase !== before.phase,
      spinnerPaintMoved: !expectsSpinner || spinnerTransform !== before.spinnerTransform
    };
  }, initialPaint)).toEqual({ borderPaintMoved: true, phaseMoved: true, spinnerPaintMoved: true });
  const samples = await control.evaluate(element => {
    const ring = element.querySelector<HTMLElement>(':scope > .update-progress-ring');
    // expose an incomplete progress owner before sampling its paint
    if (ring === null) return null;
    const phaseTarget = element.classList.contains('progress-status-button') ? element as HTMLElement : ring;
    const candidates: Array<{ pseudo: string | null; target: Element }> = [];
    if (element.matches(".tabs button[role='tab'].progress-status-button")) candidates.push({ target: element, pseudo: '::after' });
    if (element.classList.contains('progress-status-button')) candidates.push({ target: element, pseudo: '::before' }, { target: element, pseudo: '::after' });
    const agentPill = element.querySelector('.agent-state-pill');
    if (agentPill !== null) candidates.push({ target: agentPill, pseudo: '::before' });
    const workspaceEntry = element.querySelector('.workspace-sheet-entry');
    if (workspaceEntry !== null) candidates.push({ target: workspaceEntry, pseudo: '::after' });
    for (const target of element.querySelectorAll(':scope > .stack-process-dot, :scope > .project-stack-status-dot, :scope > .server-switcher-attention, :scope > .git-status-dot, :scope > .launch-update-dot')) candidates.push({ target, pseudo: null });
    const projectIndicator = element.matches('.project-open.progress-status-button') ? element.querySelector(':scope > i') : null;
    if (projectIndicator !== null) candidates.push({ target: projectIndicator, pseudo: null });
    candidates.push({ target: ring, pseudo: '::after' });
    const originalPhase = phaseTarget.style.getPropertyValue('--progress-phase');
    const readSpinner = () => candidates.map(({ target, pseudo }) => ({ style: getComputedStyle(target, pseudo), target, pseudo })).find(({ style }) => style.display !== 'none' && Number.parseFloat(style.borderTopWidth) > 0 && Number.parseFloat(style.width) > 0)?.style;
    phaseTarget.style.setProperty('--progress-phase', '0deg');
    const lowOpacity = Number.parseFloat(getComputedStyle(ring, '::before').opacity);
    const startStyle = readSpinner();
    const startMatrix = new DOMMatrixReadOnly(startStyle?.transform === 'none' || startStyle === undefined ? undefined : startStyle.transform);
    phaseTarget.style.setProperty('--progress-phase', '180deg');
    const highOpacity = Number.parseFloat(getComputedStyle(ring, '::before').opacity);
    phaseTarget.style.setProperty('--progress-phase', '45deg');
    const quarterStyle = readSpinner();
    const quarterMatrix = new DOMMatrixReadOnly(quarterStyle?.transform === 'none' || quarterStyle === undefined ? undefined : quarterStyle.transform);
    // restore ownership to the shared presentation clock
    if (originalPhase === '') phaseTarget.style.removeProperty('--progress-phase');
    else phaseTarget.style.setProperty('--progress-phase', originalPhase);
    return {
      activeProgressAnimations: element.getAnimations({ subtree: true }).filter(animation => animation instanceof CSSAnimation
        && animation.animationName.startsWith('progress-') && (animation.playState === 'running' || animation.pending)).length,
      expectsSpinner: element.tagName === 'BUTTON' || element.classList.contains('progress-status-button'),
      highOpacity,
      lowOpacity,
      spinner: quarterStyle === undefined ? null : {
        borderLeftColor: quarterStyle.borderLeftColor,
        borderTopWidth: Number.parseFloat(quarterStyle.borderTopWidth),
        quarter: Math.round(Math.atan2(quarterMatrix.b, quarterMatrix.a) * 180 / Math.PI),
        start: Math.round(Math.atan2(startMatrix.b, startMatrix.a) * 180 / Math.PI)
      }
    };
  });
  // fail clearly when phase sampling could not find the direct ring
  if (samples === null) throw new Error('breathing progress treatment is missing');
  expect(samples.activeProgressAnimations).toBe(0);
  expect(samples.lowOpacity).toBeCloseTo(0.35, 2);
  expect(samples.highOpacity).toBeCloseTo(1, 2);
  // buttons and status surfaces replace their indicator with the same phase-driven orbit
  if (samples.expectsSpinner) {
    expect(samples.spinner).toMatchObject({ borderLeftColor: 'rgba(0, 0, 0, 0)', quarter: 90, start: 0 });
    expect(samples.spinner?.borderTopWidth).toBeGreaterThan(0);
  } else {
    expect(samples.spinner).toBeNull();
  }
}

// reduced motion leaves a steady border and a static open indicator where one is reserved
export async function expectReducedMotionProgress(control: Locator, color: ProgressColor, kind?: ProgressKind) {
  await expectProgressBorder(control, color, kind);
  const treatment = await control.evaluate(element => {
    const ring = element.querySelector<HTMLElement>(':scope > .update-progress-ring');
    // expose incomplete progress markup to the assertion
    if (ring === null) return null;
    const candidates: Array<{ pseudo: string | null; target: Element }> = [];
    // status surfaces reuse their existing dot location
    if (element.matches(".tabs button[role='tab'].progress-status-button")) candidates.push({ target: element, pseudo: '::after' });
    const agentPill = element.querySelector('.agent-state-pill');
    // agent rows replace the pill's leading dot
    if (agentPill !== null) candidates.push({ target: agentPill, pseudo: '::before' });
    const workspaceEntry = element.querySelector('.workspace-sheet-entry');
    // workspace rows replace the entry's trailing dot
    if (workspaceEntry !== null) candidates.push({ target: workspaceEntry, pseudo: '::after' });
    // generic status controls animate the original dot element
    for (const target of element.querySelectorAll(':scope > .stack-process-dot, :scope > .project-stack-status-dot, :scope > .server-switcher-attention, :scope > .git-status-dot, :scope > .launch-update-dot, :scope.project-open > i')) {
      candidates.push({ target, pseudo: null });
    }
    // text and icon buttons reserve the ring's compact after slot
    candidates.push({ target: ring, pseudo: '::after' });
    const visibleIndicators = candidates.map(({ target, pseudo }) => {
      const style = getComputedStyle(target, pseudo);
      return {
        animationName: style.animationName,
        borderLeftColor: style.borderLeftColor,
        borderTopWidth: Number.parseFloat(style.borderTopWidth),
        display: style.display,
        height: Number.parseFloat(style.height),
        transform: style.transform,
        width: Number.parseFloat(style.width)
      };
    }).filter(style => style.display !== 'none' && style.borderTopWidth > 0 && style.width > 0 && style.height > 0);
    return {
      borderAnimation: getComputedStyle(ring, '::before').animationName,
      expectsIndicator: element.tagName === 'BUTTON' || element.classList.contains('progress-status-button'),
      activeProgressAnimations: element.getAnimations({ subtree: true }).filter(animation => animation instanceof CSSAnimation && animation.animationName.startsWith('progress-') && (animation.playState === 'running' || animation.pending)).length,
      visibleIndicators
    };
  });
  if (treatment === null) throw new Error('reduced-motion progress treatment is missing');
  expect(treatment.borderAnimation).toBe('none');
  expect(treatment.activeProgressAnimations).toBe(0);
  // buttons and status controls retain one nonrotating open ring
  if (treatment.expectsIndicator) {
    expect(treatment.visibleIndicators).toHaveLength(1);
    const indicator = treatment.visibleIndicators[0];
    expect(indicator.animationName).toBe('none');
    expect(indicator.borderLeftColor).toBe('rgba(0, 0, 0, 0)');
    expect(indicator.borderTopWidth).toBeGreaterThan(0);
    expect(indicator.transform).toBe('matrix(1, 0, 0, 1, 0, 0)');
    expect(indicator.width).toBeGreaterThan(0);
    expect(indicator.width).toBeLessThanOrEqual(24);
    expect(indicator.height).toBe(indicator.width);
  } else {
    expect(treatment.visibleIndicators).toHaveLength(0);
  }
}

// match each loading border to its intended split surface
export async function expectSplitProgressBorder(panel: Locator, color: ProgressColor) {
  const loading = panel.locator('.log-loading');
  await expectProgressBorder(loading, color);
  await expectBreathingProgressBorder(loading);
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

// verify every active surface receives one synchronized shared phase without native loops
export async function expectProgressBorderGroup(controls: Locator, count: number, kind: ProgressKind, reducedMotion = false) {
  await expect(controls).toHaveCount(count);
  await expect.poll(() => controls.evaluateAll((elements, expected) => {
    const observations = elements.map(element => {
      const ring = element.querySelector<HTMLElement>(':scope > .update-progress-ring');
      const phaseTarget = element.classList.contains('progress-status-button') ? element as HTMLElement : ring;
      const phase = phaseTarget === null ? Number.NaN : Number.parseFloat(getComputedStyle(phaseTarget).getPropertyValue('--progress-phase'));
      const activeProgressAnimations = element.getAnimations({ subtree: true }).filter(animation => animation instanceof CSSAnimation
        && animation.animationName.startsWith('progress-') && (animation.playState === 'running' || animation.pending)).length;
      return {
        activeProgressAnimations,
        borderOpacity: ring === null ? Number.NaN : Number.parseFloat(getComputedStyle(ring, '::before').opacity),
        busy: element.getAttribute('aria-busy'),
        classified: element.classList.contains('progress-loading') ? 'loading' : 'working',
        hasLegacyRunner: element.querySelector('.working-progress-runner') !== null,
        phase,
        ring: ring !== null
      };
    });
    const phases = observations.flatMap(observation => Number.isFinite(observation.phase) ? [observation.phase] : []);
    const opacities = observations.map(observation => observation.borderOpacity);
    return {
      allBusy: observations.every(observation => observation.busy === 'true'),
      allClassified: observations.every(observation => observation.classified === expected.kind),
      allRingsPresent: observations.every(observation => observation.ring),
      noActiveProgressAnimations: observations.every(observation => observation.activeProgressAnimations === 0),
      noLegacyRunner: observations.every(observation => !observation.hasLegacyRunner),
      phaseContract: expected.reduced
        ? phases.length === 0 && opacities.every(opacity => opacity === 1)
        : phases.length === elements.length && Math.max(...phases) - Math.min(...phases) <= 0.01
          && Math.max(...opacities) - Math.min(...opacities) <= 0.001
    };
  }, { kind, reduced: reducedMotion })).toEqual({
    allBusy: true,
    allClassified: true,
    allRingsPresent: true,
    noActiveProgressAnimations: true,
    noLegacyRunner: true,
    phaseContract: true
  });
}
