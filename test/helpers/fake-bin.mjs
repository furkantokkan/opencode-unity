// Fake executables (for example nvidia-smi, ollama or opencode) generated at test time into a temp
// directory outside test/, so `node --test` never runs them as suites (spec section 20.1).
//
// Behavior comes from a JSON spec file that tests can change between calls:
//   { "routes": [ { "args": ["--version"] | null, "responses": [Response, ...] } ], "fallback": Response }
//   Response = { "stdout"?: string, "stderr"?: string, "exitCode"?: number, "delayMs"?: number }
// A call uses the first route whose `args` equal its arguments exactly, else the first route with
// `args: null`. The n-th call to a route gets its n-th response; the last response repeats. Calls are
// appended to `<spec>.calls.jsonl`. Calls running at the same moment may read the same call count.
import fs from 'node:fs/promises';
import path from 'node:path';

const FAKE_BIN_SOURCE = `import fs from 'node:fs';
const [specPath, ...args] = process.argv.slice(2);
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
const callsPath = specPath + '.calls.jsonl';
const previous = fs.existsSync(callsPath)
  ? fs.readFileSync(callsPath, 'utf8').split('\\n').filter(Boolean).map((line) => JSON.parse(line))
  : [];
const routes = spec.routes ?? [];
const key = JSON.stringify(args);
let routeIndex = routes.findIndex((route) => Array.isArray(route.args) && JSON.stringify(route.args) === key);
if (routeIndex === -1) routeIndex = routes.findIndex((route) => route.args === null || route.args === undefined);
fs.appendFileSync(callsPath, JSON.stringify({ args, routeIndex, cwd: process.cwd() }) + '\\n');
let response = spec.fallback ?? { stderr: 'fake-bin: unexpected arguments ' + key + '\\n', exitCode: 97 };
if (routeIndex !== -1) {
  const responses = routes[routeIndex].responses ?? [];
  const count = previous.filter((call) => call.routeIndex === routeIndex).length;
  response = responses[Math.min(count, responses.length - 1)] ?? {};
}
const finish = () => {
  if (response.stdout) process.stdout.write(response.stdout);
  if (response.stderr) process.stderr.write(response.stderr);
  process.exitCode = response.exitCode ?? 0;
};
if (response.delayMs) setTimeout(finish, response.delayMs);
else finish();
`;

/**
 * @typedef {object} FakeResponse
 * @property {string} [stdout]
 * @property {string} [stderr]
 * @property {number} [exitCode]
 * @property {number} [delayMs]
 */

/**
 * @typedef {object} FakeRoute
 * @property {string[] | null} args
 * @property {FakeResponse[]} responses
 */

/**
 * @typedef {object} FakeSpec
 * @property {FakeRoute[]} [routes]
 * @property {FakeResponse} [fallback]
 */

/**
 * @typedef {object} FakeBin
 * @property {string} name
 * @property {string} command     Launcher path: `<name>.cmd` on Windows (spawn it with a shell), `<name>` elsewhere.
 * @property {{ file: string, args: string[] }} invocation  Shell-free form: spawn `file` with `args` plus call arguments.
 * @property {string} specPath
 * @property {(spec: FakeSpec | FakeResponse) => Promise<void>} setSpec
 * @property {() => Promise<Array<{ args: string[], routeIndex: number, cwd: string }>>} readCalls
 */

/**
 * @param {string} dir   Target directory, for example `sandbox.dirs.bin`.
 * @param {string} name  Executable name without extension.
 * @param {FakeSpec | FakeResponse} [spec]  A single response is shorthand for one catch-all route.
 * @returns {Promise<FakeBin>}
 */
export async function createFakeBin(dir, name, spec = {}) {
  await fs.mkdir(dir, { recursive: true });
  const scriptPath = path.join(dir, `${name}.fake.mjs`);
  const specPath = path.join(dir, `${name}.fake.json`);
  await fs.writeFile(scriptPath, FAKE_BIN_SOURCE);
  const command = await writeLauncher(dir, name, scriptPath, specPath);
  const setSpec = async (/** @type {FakeSpec | FakeResponse} */ next) => {
    await fs.writeFile(specPath, JSON.stringify(normalizeSpec(next), null, 2));
    await fs.rm(`${specPath}.calls.jsonl`, { force: true });
  };
  await setSpec(spec);
  return {
    name,
    command,
    invocation: { file: process.execPath, args: [scriptPath, specPath] },
    specPath,
    setSpec,
    readCalls: async () => {
      const text = await fs.readFile(`${specPath}.calls.jsonl`, 'utf8').catch(() => '');
      return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    },
  };
}

/**
 * Returns a copy of `env` whose PATH starts with `dir`, keeping the platform's PATH variable name.
 * @param {Record<string, string>} env
 * @param {string} dir
 * @returns {Record<string, string>}
 */
export function prependPath(env, dir) {
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
  const current = env[pathKey];
  return { ...env, [pathKey]: current ? `${dir}${path.delimiter}${current}` : dir };
}

/**
 * @param {FakeSpec | FakeResponse} spec
 * @returns {FakeSpec}
 */
function normalizeSpec(spec) {
  if ('routes' in spec || 'fallback' in spec) return /** @type {FakeSpec} */ (spec);
  return { routes: [{ args: null, responses: [/** @type {FakeResponse} */ (spec)] }] };
}

/**
 * @param {string} dir
 * @param {string} name
 * @param {string} scriptPath
 * @param {string} specPath
 * @returns {Promise<string>}
 */
async function writeLauncher(dir, name, scriptPath, specPath) {
  if (process.platform === 'win32') {
    const launcher = path.join(dir, `${name}.cmd`);
    await fs.writeFile(launcher, `@"${process.execPath}" "${scriptPath}" "${specPath}" %*\r\n`);
    return launcher;
  }
  const launcher = path.join(dir, name);
  await fs.writeFile(launcher, `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "${specPath}" "$@"\n`, { mode: 0o755 });
  return launcher;
}
