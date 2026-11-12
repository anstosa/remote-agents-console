import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { instanceIconSvg } from '../src/instance-icon.js';
import { validateSvg } from '../src/instance-icon-svg.js';

type SvgContract = { accept: string[]; reject: string[]; adversarial: { description: string; prefix: string; repeat: string; count: number; suffix: string }[] };
// the host helper runs the same data-only vectors against its own validator
const svgContract = JSON.parse(await readFile(new URL('../../../scripts/settings/svg-contract.json', import.meta.url), 'utf8')) as SvgContract;

// the validator guards operator uploads and artwork fetched from peers alike
describe('static SVG validation', () => {
  it.each([instanceIconSvg(), ...svgContract.accept])('accepts inert geometry %#', svg => {
    expect(() => validateSvg(svg)).not.toThrow();
  });

  it.each(svgContract.reject)('rejects active, unknown or malformed markup %#', svg => {
    expect(() => validateSvg(svg)).toThrow();
  });

  // peer-supplied markup must not make the tokenizer backtrack quadratically
  it.each(svgContract.adversarial)('rejects $description quickly', ({ prefix, repeat, count, suffix }) => {
    const started = performance.now();
    expect(() => validateSvg(`${prefix}${repeat.repeat(count)}${suffix}`)).toThrow();
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
