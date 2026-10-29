import { VERSION, type ExtensionAPI } from '@earendil-works/pi-coding-agent';

/**
 * The RAC Pi extension, loaded into every Pi the console launches (ADR 0017). Pi loads it
 * itself (`-e`), so it imports nothing from the console: the status key is the Pi client's
 * `piReportStatusKey`, and a dialog's title has the shape the Pi client's `dialogTitle` reads.
 *
 * At process startup it sends the launch report: that it loaded, whether the sandbox is engaged,
 * and Pi's version. The console dispatches nothing to the Agent until the report arrives.
 *
 * It ships `ask_user`, the Agent's way to ask the operator. Pi's dialog requests carry no tool
 * call, so every dialog this extension raises names its tool call in its title.
 */
export default function rac(pi: ExtensionAPI): void {
  pi.on('session_start', (event, ctx) => {
    if (event.reason !== 'startup') return;
    ctx.ui.setStatus('rac-launch', JSON.stringify({ loaded: true, sandbox: { engaged: false, reason: 'not sandboxed' }, version: VERSION }));
  });

  pi.registerTool({
    name: 'ask_user',
    label: 'Ask the operator',
    description: 'Ask the operator a question and wait for the answer. Offer choices when the answer is one of a few options; otherwise the operator types an answer. Ask instead of guessing when a decision is theirs.',
    promptSnippet: 'Ask the operator a question and wait for the answer',
    // plain JSON Schema: TypeBox is Pi's own dependency, not the console's
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question, on its own' },
        choices: { type: 'array', items: { type: 'string' }, description: 'The answers to choose from, when there are a few' }
      },
      required: ['question'],
      additionalProperties: false
    } as never,
    executionMode: 'sequential',
    async execute(toolCallId, params: { question: string; choices?: string[] }, signal, _onUpdate, ctx) {
      const title = JSON.stringify({ rac: 'dialog', toolCallId, text: params.question });
      const answer = params.choices !== undefined && params.choices.length > 0
        ? await ctx.ui.select(title, params.choices, { signal })
        : await ctx.ui.input(title, undefined, { signal });
      const text = answer === undefined ? 'The operator dismissed the question without answering.' : answer;
      return { content: [{ type: 'text', text }], details: { answered: answer !== undefined } };
    }
  });
}
