// Instruction files OpenCode attaches to a session (spec 5.4, evidence E5).
//
// Every one of these is prompt the model pays for before it sees the task. On a cloud model that is a
// bill; on a 16K local context it is the difference between the agent seeing the file it was asked
// about and not seeing it.
import { FACTS_CAP } from '../../facts/render.js';
import { error, pass, quantity, skip, warn } from '../finding.js';

/** @typedef {import('../engine.js').CheckSpec} CheckSpec */

/** Spec 5.4: above this many tokens of injected instructions the finding becomes a warning. */
export const INJECTED_TOKEN_WARN = 1000;

/** @type {readonly CheckSpec[]} */
export const INSTRUCTION_CHECKS = Object.freeze([
  {
    id: 'instructions.injected',
    group: 'instructions',
    title: 'Instruction files added to every request',
    severities: ['warn'],
    why: 'OpenCode prepends the project instruction files it finds above the working directory to every request, whether or not they are relevant to the task.',
    fix: 'Shorten the file, or launch with --no-project-config so the session does not read project instruction files.',
    source: 'OpenCode session/instruction.ts and evidence E5',
    run: (context) => {
      const files = (context.project.scan?.instructionFiles ?? []).filter((file) => file.scope === 'upward');
      if (context.project.scan === null) return skip('there is no Unity project here to scan');
      if (files.length === 0) return pass('no project instruction file is attached above this project');
      const tokens = files.reduce((total, file) => total + file.tokens, 0);
      const details = files.map((file) => `${file.path}: about ${file.tokens} tokens`);
      const data = { files: files.map((file) => ({ path: file.path, chars: file.chars, tokens: file.tokens })), tokens };
      const message = `project instructions add about ${tokens} tokens to every request (${quantity(files.length, 'file')})`;
      return tokens > INJECTED_TOKEN_WARN ? warn(message, { details, data }) : pass(message, { details, data });
    },
  },
  {
    id: 'instructions.nested',
    group: 'instructions',
    title: 'Nested instruction files under Assets and Packages',
    severities: ['warn'],
    why: 'A nested instruction file is attached the moment the agent reads any file beneath it, so it lands in the middle of a session with no way to decline it.',
    fix: 'Move the guidance into the project instruction file, or delete the nested copies.',
    source: 'OpenCode session/instruction.ts nested attachment',
    run: (context) => {
      const files = (context.project.scan?.instructionFiles ?? []).filter((file) => file.scope === 'nested');
      if (context.project.scan === null) return skip('there is no Unity project here to scan');
      if (files.length === 0) return pass('no nested instruction file was found under Assets or Packages');
      const tokens = files.reduce((total, file) => total + file.tokens, 0);
      return warn(`${quantity(files.length, 'nested instruction file')} attached when a file below it is read`, {
        details: files.map((file) => `${file.path}: about ${file.tokens} tokens`),
        data: { files: files.map((file) => ({ path: file.path, tokens: file.tokens })), tokens },
      });
    },
  },
  {
    id: 'unity.facts-cap',
    group: 'instructions',
    title: 'Project facts within the cap',
    severities: ['error'],
    why: 'The facts file is part of the fixed prefix of every request, so a file over the cap takes context away from the task on every single turn.',
    fix: 'Run opencode-unity init --refresh to rewrite the facts, or shorten your edits to it.',
    source: 'spec 9.6',
    run: (context) => {
      const text = context.project.factsText;
      if (text === null) return skip('no facts file has been written for this project');
      if (text.length <= FACTS_CAP) return pass(`the facts file is within the cap (${text.length} of ${FACTS_CAP} characters)`);
      return error(`the facts file is ${text.length} characters, over the ${FACTS_CAP} character cap`, {
        details: [`file: ${context.project.factsPath ?? 'unknown'}`],
        data: { chars: text.length, cap: FACTS_CAP },
      });
    },
  },
]);
