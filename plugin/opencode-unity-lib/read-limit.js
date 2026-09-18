// The read clamp (spec 8.7, `tool.execute.before`). A 16K context cannot afford OpenCode's default
// read size, so every `read` call is capped at `safety.readLimitLines` by mutating the argument
// object in place — the hook has no other way to change a tool's arguments.
export const DEFAULT_READ_LIMIT_LINES = 200;

/** Tool ids whose `limit` argument counts lines of a file. */
export const READ_TOOL_IDS = Object.freeze(['read']);

/**
 * @param {string} toolId
 * @returns {boolean}
 */
export function isReadTool(toolId) {
  return READ_TOOL_IDS.includes(toolId);
}

/**
 * Caps `args.limit` at `limitLines` and fills it in when the model left it out. A limit that is not a
 * usable number is replaced rather than trusted, so a `"limit": "all"` cannot read a whole scene file.
 * @param {unknown} args
 * @param {number} [limitLines]
 * @returns {{ changed: boolean, limit: number }}
 */
export function clampReadArgs(args, limitLines = DEFAULT_READ_LIMIT_LINES) {
  const cap = Number.isFinite(limitLines) && limitLines >= 1 ? Math.floor(limitLines) : DEFAULT_READ_LIMIT_LINES;
  if (args === null || typeof args !== 'object') return { changed: false, limit: cap };
  const target = /** @type {{ limit?: unknown }} */ (args);
  const requested = target.limit;
  const usable = typeof requested === 'number' && Number.isFinite(requested) && requested >= 1;
  const limit = usable ? Math.min(Math.floor(/** @type {number} */ (requested)), cap) : cap;
  const changed = limit !== requested;
  if (changed) target.limit = limit;
  return { changed, limit };
}
