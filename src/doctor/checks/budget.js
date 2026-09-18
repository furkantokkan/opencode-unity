// The fixed prefix every request pays, against the budget and the server's truncation limit (spec 8.8).
//
// The fixed prefix is the tool schemas plus the project facts: the part of the prompt that is there
// before the user has said anything. When it grows, nothing fails - the conversation just gets shorter
// until the server starts cutting it, which is evidence E1.
import { error, pass, skip, warn } from '../finding.js';

/** @typedef {import('../engine.js').CheckSpec} CheckSpec */

/** Calibrated at 3.5 characters per token for this model family (spec 8.8). */
const CHARS_PER_TOKEN = 3.5;

/** @type {readonly CheckSpec[]} */
export const BUDGET_CHECKS = Object.freeze([
  {
    id: 'budget.fixed-prefix',
    group: 'budget',
    title: 'Fixed prefix against the budget',
    severities: ['error', 'warn'],
    why: 'Tool schemas and project facts are sent before the task is; what they take is taken from every turn of the conversation, not once.',
    fix: 'Shorten the facts file, or reduce the tools the agent sees, until the prefix is back under the target.',
    source: 'spec 8.8',
    run: (context) => {
      const runtime = context.profileInfo.runtime;
      if (runtime === null) return skip('the runtime profile could not be built');
      const factsTokens = Math.round((context.project.factsText?.length ?? 0) / CHARS_PER_TOKEN);
      const measured = runtime.budget.toolsTokensSource !== 'default-allowance';
      /** @type {Array<{ agent: string, prefix: number, target: number, fail: number }>} */
      const agents = Object.entries(runtime.budget.prefixTargetTokens).map(([agent, target]) => ({
        agent,
        prefix: readAgentTokens(runtime.budget.toolsTokens, agent) + factsTokens,
        target,
        fail: readAgentTokens(runtime.budget.prefixFailTokens, agent),
      }));
      const over = agents.filter((entry) => entry.prefix > entry.fail);
      const near = agents.filter((entry) => entry.prefix > entry.target && entry.prefix <= entry.fail);
      const details = [
        ...agents.map((entry) => `${entry.agent}: about ${entry.prefix} tokens against a target of ${entry.target}`),
        measured ? `tool tokens measured by ${runtime.budget.toolsTokensSource}` : 'tool tokens are the conservative default allowance; run doctor --capture to measure them',
      ];
      const data = { agents, factsTokens, promptBudget: runtime.budget.promptBudget, toolsTokensSource: runtime.budget.toolsTokensSource, measured };
      if (over.length > 0) return error(`the fixed prefix is over the failure threshold for ${over.map((entry) => entry.agent).join(', ')}`, { details, data });
      if (near.length > 0) return warn(`the fixed prefix is over the target for ${near.map((entry) => entry.agent).join(', ')}`, { details, data });
      return pass('the fixed prefix is within the target for every agent', { details, data });
    },
  },
  {
    id: 'budget.truncation-limit',
    group: 'budget',
    title: 'Prompt budget below the server truncation limit',
    severities: ['error'],
    why: 'Past the context size the server keeps the first few tokens and the tail and drops the middle, which is where the task and the file usually are.',
    fix: 'Lower limit.context, or recreate the model tag with a larger num_ctx.',
    source: 'spec 8.8 and evidence E1',
    run: (context) => {
      const runtime = context.profileInfo.runtime;
      if (runtime === null) return skip('the runtime profile could not be built');
      const reported = context.ollama.show?.parameters.num_ctx?.at(-1);
      const serverCtx = reported === undefined ? null : Number(reported);
      const planned = runtime.budget.promptBudget + runtime.provider.limit.output;
      const limit = serverCtx ?? runtime.provider.numCtx;
      const data = { promptBudget: runtime.budget.promptBudget, output: runtime.provider.limit.output, serverContext: limit, measured: serverCtx !== null };
      if (planned <= limit) return pass(`the planned prompt and output fit the ${limit} token window`, { data });
      return error(`the planned prompt and output need ${planned} tokens but the model holds ${limit}`, { data });
    },
  },
]);

/**
 * @param {Record<string, number>} tokens
 * @param {string} agent
 * @returns {number}
 */
function readAgentTokens(tokens, agent) {
  const value = tokens[agent];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
