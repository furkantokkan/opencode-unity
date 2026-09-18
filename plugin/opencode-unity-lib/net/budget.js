// The outbound budget of amendment 35.6.3 (`DN14`, `DN26`). It is the arithmetic that turns "a
// documentation fetch cannot ship your codebase" from an assertion into a measurement: every request
// spends path characters, query characters and body bytes against a per-entry cap, and the session
// spends requests against a count. Multiply the caps by `maxRequestsPerSession` and the ceiling on
// model-chosen bytes reaching a host is a number a reader can hold onto.
//
// `DN26` is why loopback is in here too. A1.1 exempted the one entry with no path cap, no query cap
// and a 32 KiB body, on the grounds that nothing leaves the machine — which is false on a workspace
// whose own repository defines the service listening on that port.

/** The deny code every cap in this module produces. */
export const BUDGET_EXCEEDED_CODE = 'net_budget_exceeded';

/**
 * The narrowest budget: what an entry gets when it declares nothing. A missing cap must never read as
 * "unbounded", so the fallback is the read-only documentation row of 35.6.3.
 */
export const DEFAULT_ENTRY_BUDGET = Object.freeze({ maxPathChars: 512, maxQueryChars: 128, maxRequestBodyBytes: 0 });

/**
 * @typedef {object} EntryBudget
 * @property {number} maxPathChars
 * @property {number} maxQueryChars
 * @property {number} maxRequestBodyBytes
 */

/** The three caps, with the request field each one measures. */
const CAPS = Object.freeze([
  { cap: 'maxPathChars', field: 'path' },
  { cap: 'maxQueryChars', field: 'query' },
  { cap: 'maxRequestBodyBytes', field: 'body' },
]);

/**
 * Reads a declared budget into three finite, non-negative integers. Anything else falls back to the
 * default for that cap rather than to no cap at all.
 * @param {unknown} raw
 * @returns {EntryBudget}
 */
export function normalizeBudget(raw) {
  const source = raw && typeof raw === 'object' ? /** @type {Record<string, unknown>} */ (raw) : {};
  /** @type {EntryBudget} */
  const budget = { ...DEFAULT_ENTRY_BUDGET };
  for (const { cap } of CAPS) {
    const value = source[cap];
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) budget[/** @type {keyof EntryBudget} */ (cap)] = value;
  }
  return budget;
}

/**
 * The intersection rule of `DN25`, for budgets: the cap is the smallest any matching entry declares.
 * With no entries there is no request to budget, so the default stands.
 * @param {readonly unknown[]} budgets
 * @returns {EntryBudget}
 */
export function intersectBudgets(budgets) {
  const list = (Array.isArray(budgets) ? budgets : []).map(normalizeBudget);
  if (list.length === 0) return { ...DEFAULT_ENTRY_BUDGET };
  /** @type {EntryBudget} */
  const budget = { ...list[0] };
  for (const other of list.slice(1)) {
    for (const { cap } of CAPS) {
      const key = /** @type {keyof EntryBudget} */ (cap);
      budget[key] = Math.min(budget[key], other[key]);
    }
  }
  return budget;
}

/**
 * The bytes a request body puts on the wire. `TextEncoder` rather than `Buffer.byteLength`, because
 * this module runs under Bun inside the plugin and under Node in the tests, and a character count
 * would under-report every non-ASCII body.
 * @param {unknown} body
 * @returns {number}
 */
export function measureBodyBytes(body) {
  if (typeof body !== 'string' || body === '') return 0;
  return new TextEncoder().encode(body).length;
}

/**
 * Step 8: the three caps, against the already intersected budget. The path and query are measured in
 * their wire form, because that is what leaves the machine, not the shorter decoded spelling.
 * @param {{ path?: string, query?: string, body?: string, bodyBytes?: number }} request
 * @param {unknown} budget
 * @returns {{ ok: true, spent: { path: number, query: number, body: number } } | { ok: false, code: string, field: string, limit: number, actual: number }}
 */
export function checkOutboundBudget(request, budget) {
  const limits = normalizeBudget(budget);
  const spent = {
    path: typeof request.path === 'string' ? request.path.length : 0,
    query: typeof request.query === 'string' ? request.query.length : 0,
    body: typeof request.bodyBytes === 'number' ? request.bodyBytes : measureBodyBytes(request.body),
  };
  for (const { cap, field } of CAPS) {
    const limit = limits[/** @type {keyof EntryBudget} */ (cap)];
    const actual = spent[/** @type {keyof typeof spent} */ (field)];
    if (actual > limit) return { ok: false, code: BUDGET_EXCEEDED_CODE, field, limit, actual };
  }
  return { ok: true, spent };
}

/**
 * The published ceiling of 35.6.3: the most model-chosen bytes an entry can put on the wire across a
 * whole session. `docs/network.md` prints this rather than a constant, so the number in the docs and
 * the number the limits produce cannot drift apart.
 * @param {unknown} budget
 * @param {number} maxRequestsPerSession
 * @returns {number}
 */
export function sessionOutboundCeiling(budget, maxRequestsPerSession) {
  const limits = normalizeBudget(budget);
  const requests = Number.isInteger(maxRequestsPerSession) && maxRequestsPerSession > 0 ? maxRequestsPerSession : 0;
  return requests * (limits.maxPathChars + limits.maxQueryChars + limits.maxRequestBodyBytes);
}

/**
 * @typedef {object} OutboundLedger
 * @property {(now?: number) => { ok: true } | { ok: false, code: string, scope: 'session' | 'minute', limit: number }} check
 * @property {(input: { entryIds?: readonly string[], bytes?: number, now?: number }) => void} record
 * @property {() => { requests: number, bytes: number, entries: Array<{ id: string, requests: number, bytes: number }> }} snapshot
 */

/**
 * The per-session and per-minute request counters of step 3, and the per-entry outbound byte counts
 * `status` and the session summary print (`DN26`). Time is injected so the minute window is testable
 * without waiting for one.
 * @param {{ maxRequestsPerSession?: number, maxRequestsPerMinute?: number, now?: () => number }} limits
 * @returns {OutboundLedger}
 */
export function createOutboundLedger({ maxRequestsPerSession = 40, maxRequestsPerMinute = 20, now = Date.now } = {}) {
  /** @type {number[]} */
  const recent = [];
  /** @type {Map<string, { requests: number, bytes: number }>} */
  const perEntry = new Map();
  let requests = 0;
  let bytes = 0;

  /** @param {number} at */
  const prune = (at) => {
    while (recent.length > 0 && at - recent[0] >= 60_000) recent.shift();
  };

  return {
    check(at = now()) {
      if (requests >= maxRequestsPerSession) return { ok: false, code: 'net_rate_limited', scope: 'session', limit: maxRequestsPerSession };
      prune(at);
      if (recent.length >= maxRequestsPerMinute) return { ok: false, code: 'net_rate_limited', scope: 'minute', limit: maxRequestsPerMinute };
      return { ok: true };
    },
    record({ entryIds = [], bytes: spent = 0, now: at = now() } = {}) {
      requests += 1;
      bytes += spent;
      prune(at);
      recent.push(at);
      for (const id of entryIds) {
        const row = perEntry.get(id) ?? { requests: 0, bytes: 0 };
        row.requests += 1;
        row.bytes += spent;
        perEntry.set(id, row);
      }
    },
    snapshot() {
      const entries = [...perEntry.entries()].map(([id, row]) => ({ id, requests: row.requests, bytes: row.bytes }));
      entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return { requests, bytes, entries };
    },
  };
}
