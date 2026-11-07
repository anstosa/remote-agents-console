import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// inspect the portable deployment contract without host overrides
const compose = readFileSync(new URL('../../compose.yaml', import.meta.url), 'utf8');

// keep each bounded ledger outside the immutable application image
for (const [key, filename] of [
  ['RAC_DAVO_STATE_FILE', 'davo-state.json'],
  ['RAC_PROMPT_OPERATIONS_FILE', 'prompt-operations.json'],
  ['RAC_DAVO_PUSH_ATTEMPTS_FILE', 'davo-push-attempts.json']
]) {
  // lock the writable persistent path for each service
  test(`${key} persists on the mounted workspace`, () => {
    assert.ok(compose.includes(`${key}: /workspace/.data/${filename}`));
    assert.ok(compose.includes('./:/workspace:rw'));
  });
}
