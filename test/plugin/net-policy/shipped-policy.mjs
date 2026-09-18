// The resolved `standard` policy of amendment 35.6, as the runtime profile would carry it. The
// shipped list itself is data owned by `src/network/shipped-hosts.json` (build step S37); this copy
// exists so the policy core can be tested without the renderer, and the render suite asserts the two
// agree.
import { hashPolicy, normalizeNetworkPolicy, resolveReservedPorts } from '../../../plugin/opencode-unity-lib/net/policy.js';

const DOC_BUDGET = { maxPathChars: 512, maxQueryChars: 128, maxRequestBodyBytes: 0 };
const LOOPBACK_READ_BUDGET = { maxPathChars: 2048, maxQueryChars: 1024, maxRequestBodyBytes: 0 };
const LOOPBACK_WRITE_BUDGET = { maxPathChars: 2048, maxQueryChars: 1024, maxRequestBodyBytes: 8192 };

/** The five documentation and package hosts of 35.6.1: `GET`/`HEAD`, `https`, no request body. */
export const SHIPPED_HOST_ENTRIES = [
  docs('unity-docs', 'docs.unity3d.com', ['/']),
  { ...docs('dotnet-api', 'learn.microsoft.com', ['/dotnet/', '/nuget/']), stripLocaleSegment: true },
  docs('nuget-api', 'api.nuget.org', ['/v3/']),
  { ...docs('npm-registry', 'registry.npmjs.org', ['/']), budget: { ...DOC_BUDGET, maxQueryChars: 64 } },
  docs('firebase-docs', 'firebase.google.com', ['/docs/']),
];

/**
 * 35.6.2 after `D-M24`: every loopback port, both schemes, read-only, and a zero request body. The
 * entry that used to carry `POST` and 32 KiB and therefore swallowed every narrower loopback rule.
 */
export const LOOPBACK_DEV_ENTRY = {
  id: 'loopback-dev',
  host: '127.0.0.1',
  hostKind: 'loopback',
  ports: '*',
  scheme: '*',
  methods: ['GET', 'HEAD'],
  pathPrefix: ['/'],
  loopback: true,
  shipped: true,
  budget: LOOPBACK_READ_BUDGET,
};

/** What `init --derive` writes for a Cloud Functions emulator: its own port, its own methods, its gate. */
export const FUNCTIONS_ENTRY = {
  id: 'firebase-functions',
  host: '127.0.0.1',
  hostKind: 'loopback',
  ports: [5001],
  scheme: 'http',
  methods: ['GET', 'POST'],
  pathPrefix: ['/'],
  loopback: true,
  firebaseEmulator: 'functions',
  budget: LOOPBACK_WRITE_BUDGET,
};

/**
 * Builds a resolved policy. `derived` are the entries `init` produced; when `disjoint` is set their
 * ports are carved out of `loopback-dev`, which is what the render must do for `DN25` to leave a
 * derived write method reachable.
 * @param {{ entries?: object[], derived?: object[], disjoint?: boolean, reservedPorts?: object[], deniedProjectSegments?: string[], limits?: Record<string, number> }} [options]
 */
export function buildPolicy({ entries, derived = [], disjoint = false, reservedPorts, deniedProjectSegments = [], limits } = {}) {
  const claimed = disjoint ? derived.flatMap((entry) => (Array.isArray(entry.ports) ? entry.ports : [])) : [];
  const base = entries ?? [...SHIPPED_HOST_ENTRIES, { ...LOOPBACK_DEV_ENTRY, excludePorts: claimed }];
  const rendered = {
    enabled: true,
    toolId: 'unitynet',
    profile: 'standard',
    entries: [...base, ...derived],
    limits: limits ?? { maxResponseBytes: 65536, maxOutputChars: 8192, maxUrlChars: 2048, maxRequestsPerSession: 40, maxRequestsPerMinute: 20 },
    reservedPorts: reservedPorts ?? resolveReservedPorts({ ollamaPort: 11434 }),
    deniedQueryKeys: ['key', 'api_key', 'token', 'access_token', 'authorization', 'password', 'secret'],
    deniedProjectSegments,
    consentIds: [],
    policyHash: null,
  };
  // The plugin never sees the rendered shape directly, only what it could normalise out of it, so the
  // fixture goes through the same reader and the hash covers the resolved form.
  const result = normalizeNetworkPolicy(rendered);
  if (!result.ok) throw new Error(`fixture policy is not usable: ${result.reason}`);
  result.policy.policyHash = hashPolicy(result.policy);
  return result.policy;
}

/**
 * @param {string} id
 * @param {string} host
 * @param {string[]} pathPrefix
 */
function docs(id, host, pathPrefix) {
  return {
    id,
    host,
    hostKind: 'exact',
    ports: [443],
    scheme: 'https',
    methods: ['GET', 'HEAD'],
    pathPrefix,
    loopback: false,
    shipped: true,
    budget: DOC_BUDGET,
  };
}
