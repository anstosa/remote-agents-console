export type DavoMcpActivityPhase = 'running' | 'interrupted' | 'succeeded' | 'failed' | 'unknown';
export type DavoMcpActivityOutcome = 'success' | 'error' | 'unknown';

type ActivityCopy = { running: string; succeeded: string; failed: string; unknown: string; interrupted: string };

const exactCopy: Record<string, ActivityCopy> = {
  list_notes: { running: 'Reading notes...', succeeded: 'Read notes.', failed: "Couldn't read notes.", unknown: 'Reading notes may not have finished.', interrupted: 'Reading notes was interrupted.' },
  get_note: { running: 'Reading notes...', succeeded: 'Read notes.', failed: "Couldn't read notes.", unknown: 'Reading notes may not have finished.', interrupted: 'Reading notes was interrupted.' },
  queue_prompt: { running: 'Queuing prompt...', succeeded: 'Queued prompt.', failed: "Couldn't queue prompt.", unknown: 'Queuing prompt may not have finished.', interrupted: 'Queuing prompt was interrupted.' }
};

const verbCopy: Record<string, { running: string; succeeded: string }> = {
  get: { running: 'Reading', succeeded: 'Read' },
  list: { running: 'Reading', succeeded: 'Read' },
  preview: { running: 'Previewing', succeeded: 'Previewed' },
  summarize: { running: 'Summarizing', succeeded: 'Summarized' },
  create: { running: 'Creating', succeeded: 'Created' },
  update: { running: 'Updating', succeeded: 'Updated' },
  delete: { running: 'Deleting', succeeded: 'Deleted' },
  remove: { running: 'Removing', succeeded: 'Removed' },
  schedule: { running: 'Scheduling', succeeded: 'Scheduled' },
  queue: { running: 'Queuing', succeeded: 'Queued' },
  run: { running: 'Running', succeeded: 'Ran' },
  start: { running: 'Starting', succeeded: 'Started' },
  launch: { running: 'Starting', succeeded: 'Started' },
  spawn: { running: 'Starting', succeeded: 'Started' },
  cancel: { running: 'Stopping', succeeded: 'Stopped' },
  close: { running: 'Closing', succeeded: 'Closed' },
  deactivate: { running: 'Stopping', succeeded: 'Stopped' },
  answer: { running: 'Sending', succeeded: 'Sent' },
  relay: { running: 'Sending', succeeded: 'Sent' },
  bind: { running: 'Selecting', succeeded: 'Selected' },
  select: { running: 'Selecting', succeeded: 'Selected' },
  delegate: { running: 'Delegating', succeeded: 'Delegated' }
};

// derive bounded safe copy from one canonical server tool name
export function davoMcpActivityText(tool: string, phase: DavoMcpActivityPhase): string {
  const exact = exactCopy[tool];
  // prefer product copy for common user-visible operations
  if (exact !== undefined) return exact[phase];
  const safe = /^[a-z][a-z0-9_]{0,63}$/u.test(tool) ? tool : 'request';
  const [prefix, ...words] = safe.split('_');
  const verb = verbCopy[prefix];
  const subject = (words.length === 0 ? safe : words.join(' ')).slice(0, 96);
  // fall back to plain work language for an unfamiliar canonical tool
  if (verb === undefined) {
    if (phase === 'running') return `Working on ${subject}...`;
    if (phase === 'succeeded') return `Finished ${subject}.`;
    if (phase === 'failed') return `Couldn't finish ${subject}.`;
    if (phase === 'unknown') return `Work on ${subject} may not have finished.`;
    return `Work on ${subject} was interrupted.`;
  }
  if (phase === 'running') return `${verb.running} ${subject}...`;
  if (phase === 'succeeded') return `${verb.succeeded} ${subject}.`;
  if (phase === 'failed') return `Couldn't ${prefix} ${subject}.`;
  if (phase === 'unknown') return `${verb.running} ${subject} may not have finished.`;
  return `${verb.running} ${subject} was interrupted.`;
}

// map one authoritative gateway outcome to durable activity state
export function davoMcpActivityPhase(outcome: DavoMcpActivityOutcome): DavoMcpActivityPhase {
  if (outcome === 'success') return 'succeeded';
  if (outcome === 'error') return 'failed';
  return 'unknown';
}
