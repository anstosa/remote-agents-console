export const screensaverTailRows = 7;

// coordinate the agent's displayed mode across the API and browser
export const screensaverShowsOutput = (agent: { attention?: 'working' | 'finished' | 'question'; structured?: { compacting?: boolean; lifecycle?: string } }): boolean =>
  agent.attention === 'working' || agent.attention === 'question' || agent.structured?.compacting === true || agent.structured?.lifecycle === 'starting';
