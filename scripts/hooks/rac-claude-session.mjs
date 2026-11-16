#!/usr/bin/env node
import { TextDecoder } from 'node:util';

const maxInputBytes = 65_536;
const nativeSession = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const chunks = [];
let bytes = 0;
let oversized = false;
let validObject = false;

// drain one bounded native hook body without retaining oversize input
for await (const chunk of process.stdin) {
  bytes += chunk.length;
  // retain only an accepted-size candidate
  if (bytes <= maxInputBytes) chunks.push(chunk);
  else oversized = true;
}

// oversize input carries no trusted metadata
if (!oversized) {
  try {
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    // only a top-level object can carry native hook metadata
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      validObject = true;
      // main-only reporters reject every native subagent payload
      if (process.argv.includes('--main-only') && Object.hasOwn(parsed, 'agent_id')) process.exitCode = 2;
      else if (typeof parsed.session_id === 'string' && nativeSession.test(parsed.session_id)) process.stdout.write(parsed.session_id);
    }
  } catch {
    // malformed input emits no metadata or diagnostics
  }
}

// main-only callers fail closed when metadata provenance was not parseable
if (process.argv.includes('--main-only') && !validObject && process.exitCode === undefined) process.exitCode = 3;
