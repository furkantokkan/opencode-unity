// What the Ollama server log says happened (spec 5.4, evidence E1 and E3).
//
// These two findings are the product's strongest evidence, because they are the server's own record of
// prompts it cut and samplers it ran at their defaults. Amendment R22: a log that cannot be read is
// reported as `not checked`, never as a pass, and fails under --strict.
import { error, pass, quantity, skip, warn } from '../finding.js';
import { describeLogSource } from '../logs.js';

/** @typedef {import('../engine.js').CheckSpec} CheckSpec */

/** @type {readonly CheckSpec[]} */
export const LOG_CHECKS = Object.freeze([
  {
    id: 'logs.truncation',
    group: 'logs',
    title: 'Prompts the server truncated',
    severities: ['error', 'warn'],
    why: 'A truncated prompt keeps the first few tokens and the tail, so the agent silently loses the middle of what it was told and answers about the rest.',
    fix: 'Lower limit.context to the model num_ctx, or recreate the model tag with a larger num_ctx.',
    source: 'Ollama llm/llama_server.go and evidence E1',
    run: (context) => {
      const { summary, read, source, unreadableReason, fix } = context.logs;
      if (!read || summary === null) {
        const what = source.kind === 'none' ? 'no Ollama server log was found' : `${describeLogSource(source)} could not be read`;
        return warn(`truncation history is not checked: ${what}`, {
          details: [unreadableReason ?? 'no reason reported'],
          data: { source: source.kind, checked: false },
          fix,
        });
      }
      const recent = context.logs.recent?.truncations ?? 0;
      const data = {
        source: source.kind,
        checked: true,
        truncations: summary.truncations,
        recentTruncations: recent,
        limits: summary.truncationLimits,
        promptTokens: summary.truncatedPromptTokens,
      };
      if (summary.truncations === 0) return pass(`no truncated prompt in ${describeLogSource(source)}`, { data });
      const range = summary.truncatedPromptTokens;
      const details = [
        ...(range === null ? [] : [`prompt sizes cut: ${range.min} to ${range.max} tokens, median ${range.median}`]),
        ...(summary.truncationLimits.length > 0 ? [`limits seen: ${summary.truncationLimits.join(', ')}`] : []),
      ];
      const message = `the server truncated ${quantity(summary.truncations, 'prompt')}`;
      // Spec 5.4: an old truncation is history, a recent one is what is happening to this setup now.
      if (recent === 0) return warn(`${message}, none of them recently`, { details, data });
      return error(`${message}, ${recent} of them recently`, { details, data });
    },
  },
  {
    id: 'logs.sampling-default',
    group: 'logs',
    title: 'Requests that ran at the sampler defaults',
    severities: ['warn'],
    why: 'A sampler at temperature one and top_p one means the request carried no sampling settings, which for a coding model is the least reliable setting available.',
    fix: 'Add "temperature": true to the model entry so OpenCode sends the sampling settings.',
    source: 'evidence E3',
    run: (context) => {
      const { summary, read } = context.logs;
      if (!read || summary === null) return skip('the server log could not be read; logs.truncation reports why');
      const data = { samplers: summary.samplers, defaults: summary.defaultSamplers };
      if (summary.samplers === 0) return pass('the log records no sampler line to judge', { data });
      if (summary.defaultSamplers === 0) return pass(`all ${summary.samplers} recorded requests carried sampling settings`, { data });
      return warn(`${summary.defaultSamplers} of ${summary.samplers} recorded requests ran at the sampler defaults`, { data });
    },
  },
]);
