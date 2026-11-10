/**
 * `ask_user`, the Agent's way to ask the operator: one definition for the RAC Pi extension, which
 * registers it as a Pi tool, and the Claude client, which serves it from its MCP server. The Pi
 * extension loads this module itself (also from the host bridge's build), so it imports nothing.
 */
export const askUser = {
  name: 'ask_user',
  description: 'Ask the operator a question and wait for the answer. Offer choices when the answer is one of a few options; otherwise the operator types an answer. Ask instead of guessing when a decision is theirs.',
  // plain JSON Schema, as Pi takes it and an MCP tool's `inputSchema` is
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The question, on its own' },
      choices: { type: 'array', items: { type: 'string' }, description: 'The answers to choose from, when there are a few' }
    },
    required: ['question'],
    additionalProperties: false
  }
} as const;

/** What the model is told of the operator's answer: the choice or text, a reply off the list, or that they dismissed it. */
export const askUserReply = (choices: readonly string[] | undefined, answer: string | undefined): string =>
  answer === undefined ? 'The operator dismissed the question without answering.'
    : choices !== undefined && choices.length > 0 && !choices.includes(answer) ? `The operator answered in their own words instead of choosing:\n\n${answer}`
    : answer;
