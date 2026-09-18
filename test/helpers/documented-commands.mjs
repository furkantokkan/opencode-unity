// Pulls the `opencode-unity ...` commands out of Markdown so a test can parse each one against the CLI
// argument table without running it (amendment 34.6: "every command parses against the CLI argument
// table"). A documented command the parser rejects is exactly the failure a reader hits first.

/** Sample values for the placeholders the docs use, so a documented command becomes a concrete argv. */
const PLACEHOLDER_VALUES = Object.freeze({
  reviewId: '20260918-120000-edit-abc123.0123abcd',
  jobId: '20260918-120000-edit-abc123',
  path: 'Assets/Scripts/Player.cs',
  file: 'task.md',
  dir: 'MyGame',
  id: 'nvidia-24gb-qwen3-coder-30b-16k',
});

/**
 * @typedef {object} DocumentedCommand
 * @property {string} source   The line as written.
 * @property {number} line     1-based line in the Markdown file.
 * @property {boolean} inline  From an inline code span rather than a code block.
 * @property {string[]} argv   Arguments after `opencode-unity`, placeholders filled in.
 */

/**
 * Every `opencode-unity` invocation in fenced code blocks and in inline code spans.
 * @param {string} markdown
 * @returns {DocumentedCommand[]}
 */
export function extractDocumentedCommands(markdown) {
  /** @type {DocumentedCommand[]} */
  const commands = [];
  let inFence = false;
  markdown.split(/\r?\n/).forEach((text, index) => {
    if (/^\s*(```|~~~)/.test(text)) {
      inFence = !inFence;
      return;
    }
    const candidates = inFence ? [text] : [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
    for (const candidate of candidates) {
      const command = stripPrompt(stripComment(candidate)).trim();
      if (!/^opencode-unity(\s|$)/.test(command)) continue;
      commands.push({ source: command, line: index + 1, inline: !inFence, argv: toArgv(command).slice(1) });
    }
  });
  return commands;
}

/**
 * Parses one documented command with the CLI's own parser. Prose may name a command group in inline
 * code (`opencode-unity delegate`) without a subcommand; that is a reference, not an invocation, so only
 * that one error is accepted, and only inline.
 * @param {DocumentedCommand} command
 * @param {(argv: string[]) => { kind: string }} parse  `parseArgv` from src/cli/args.js.
 * @returns {{ kind: string } | null}  Null for an accepted group reference.
 */
export function parseDocumentedCommand(command, parse) {
  try {
    return parse(command.argv);
  } catch (error) {
    if (command.inline && /** @type {{ code?: string }} */ (error)?.code === 'missing_subcommand') return null;
    throw new Error(`line ${command.line}: '${command.source}' does not parse: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Drops a shell prompt (`$ `, `PS> `) or a numbered-list marker (`3. `) in front of a command.
 * @param {string} text
 * @returns {string}
 */
function stripPrompt(text) {
  return text.replace(/^\s*(?:\$|PS>|>|\d+\.)\s+/, '');
}

/**
 * A `#` that starts a word begins a shell comment; one inside a word (`github:x/y#v1`) does not.
 * @param {string} text
 * @returns {string}
 */
function stripComment(text) {
  return text.replace(/(^|\s)#.*$/, '');
}

/**
 * Fills placeholders, drops optional-part brackets and `...` repeats, then splits like a shell.
 * @param {string} command
 * @returns {string[]}
 */
export function toArgv(command) {
  const filled = command
    .replace(/\[([^\]]*)\]/g, (_, inner) => (/\.\.\./.test(inner) ? '' : inner))
    .replace(/<([A-Za-z]+)>/g, (match, name) => PLACEHOLDER_VALUES[/** @type {keyof typeof PLACEHOLDER_VALUES} */ (name)] ?? 'value')
    .replace(/<[^>]*>/g, 'value')
    .replace(/(^|\s)\.\.\.(?=\s|$)/g, ' ');
  /** @type {string[]} */
  const argv = [];
  let current = '';
  let quote = '';
  let started = false;
  for (const char of filled) {
    if (quote !== '') {
      if (char === quote) quote = '';
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) argv.push(current);
      current = '';
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (started) argv.push(current);
  return argv;
}
