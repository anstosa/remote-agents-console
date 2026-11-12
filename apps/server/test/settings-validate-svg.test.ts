import { describe, expect, it } from 'vitest';
import { instanceIconSvg } from '../src/instance-icon.js';
import { validateSvg } from '../src/settings/validation.js';

// the validator guards operator uploads and artwork fetched from peers alike
describe('static SVG validation', () => {
  it.each([
    instanceIconSvg(),
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="20" fill="#f38ba8"/></svg>',
    "<svg><g><path d='M0 0'/></g></svg>",
    '<svg><title>Hi there</title></svg>',
    '<svg><rect width = "1" /></svg>',
    '  <svg ></svg >\n',
    '<svg/>'
  ])('accepts inert geometry %#', svg => {
    expect(() => validateSvg(svg)).not.toThrow();
  });

  it.each([
    '<svg onload="x"></svg>',
    '<svg><script></script></svg>',
    '<svg class="x"></svg>',
    '<svg width=1></svg>',
    '<svg><rect width="1" x y="2"/></svg>',
    '<svg>text</svg>',
    '<svg><g></svg>',
    '<g></g>',
    '<svg></svg>junk',
    '<svg></svg><svg></svg>',
    '<svg><g x="1"></g x="1"></svg>',
    '<svg><rect / width="1"></svg>'
  ])('rejects active, unknown or malformed markup %#', svg => {
    expect(() => validateSvg(svg)).toThrow();
  });

  // a tag name that never closes must not make the tokenizer retry every shorter name
  it('rejects an unclosed tag at the size cap quickly', () => {
    const started = performance.now();
    expect(() => validateSvg(`<svg${'b'.repeat(262_000)}`)).toThrow();
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
