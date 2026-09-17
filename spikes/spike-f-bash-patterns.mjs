// Spike F: do the bash allow-list patterns evaluate correctly under OpenCode's Windows shell, including
// the quoted `-clp:ErrorsOnly;NoSummary`, command chains and shell wrappers?
import fs from 'node:fs/promises';
import path from 'node:path';

import { scriptedToolCalls, startMockLlm, toolNames, toolResultAfter } from './lib/mock-llm.mjs';
import { runOpencode } from './lib/opencode.mjs';
import { SpikeContext, summarizeRun } from './lib/spike.mjs';
import { createWorkspace, profileConfig, providerPluginConfig } from './lib/workspace.mjs';

/** @type {import('./lib/spike.mjs').SpikeMeta} */
export const meta = {
  id: 'F',
  title: 'Bash allow-list under the Windows shell',
  question: 'Do bash allow-list patterns evaluate correctly under OpenCode\'s Windows shell, including the quoted -clp:ErrorsOnly;NoSummary?',
  contractTest: 'C3',
  fallback: 'Ship ocu-compile.cmd <csproj> in the profile and allow that one command pattern',
};

const CSPROJ = 'Assembly-CSharp.csproj';
const COMPILE = `dotnet build ${CSPROJ} -nologo -tl:off -v q "-clp:ErrorsOnly;NoSummary"`;
const DENIED_TEXT = 'rule which prevents you';

/** Every command the scripted model tries, with the verdict the spec expects. */
const CASES = [
  { id: 'F1 compile check from the facts table', command: COMPILE, expect: 'allow' },
  { id: 'F2 dotnet --version', command: 'dotnet --version', expect: 'allow' },
  { id: 'F3 read-only git', command: 'git status --short', expect: 'allow' },
  { id: 'F4 git push', command: 'git push origin main', expect: 'deny' },
  { id: 'F5 git commit', command: 'git commit -m "wip"', expect: 'deny' },
  { id: 'F6 cm checkin', command: 'cm checkin -c "wip"', expect: 'deny' },
  { id: 'F7 allowed command chained with git push (&&)', command: `dotnet build ${CSPROJ} && git push origin main`, expect: 'deny' },
  { id: 'F8 allowed command chained with git push (;)', command: `dotnet build ${CSPROJ}; git push origin main`, expect: 'deny' },
  { id: 'F9 cmd wrapper', command: 'cmd /c git push origin main', expect: 'deny' },
  { id: 'F10 powershell wrapper', command: 'powershell -Command git push origin main', expect: 'deny' },
  { id: 'F11 recursive delete (PowerShell)', command: 'Remove-Item -Recurse -Force Assets', expect: 'deny' },
  { id: 'F12 recursive delete (posix form)', command: 'rm -rf Assets', expect: 'deny' },
  { id: 'F13 redirect into a protected asset', command: 'echo broken > Assets/UI/Menu.prefab', expect: 'deny' },
  { id: 'F14 compile of an unmapped csproj', command: 'dotnet build Other.csproj', expect: 'deny' },
];

/** Config level, from spec 8.5.2 (shortened read/edit rules; the full sets are rendered by S09). */
const CONFIG_PERMISSION = {
  '*_*': 'deny',
  task: 'deny',
  todowrite: 'deny',
  webfetch: 'deny',
  skill: 'deny',
  question: 'deny',
  doom_loop: 'deny',
  external_directory: { '*': 'deny' },
  bash: { '*': 'deny' },
  read: { '*.unity': 'deny', '*.env': 'deny' },
  edit: { '*.prefab': 'deny', '*.unity': 'deny', '*.meta': 'deny' },
};

/** Agent level, ordered as spec 8.5.2 renders it for a git project. */
const AGENT_BASH_PERMISSION = {
  '*': 'deny',
  'git *': 'deny',
  'cm *': 'deny',
  'p4 *': 'deny',
  'svn *': 'deny',
  'hg *': 'deny',
  'rm -r *': 'deny',
  'rm -rf *': 'deny',
  'rm -fr *': 'deny',
  'rmdir /s *': 'deny',
  'rd /s *': 'deny',
  'del /s *': 'deny',
  'Remove-Item *-Recurse*': 'deny',
  'format *': 'deny',
  'dotnet --version': 'allow',
  [`dotnet build ${CSPROJ} *`]: 'allow',
  'git status *': 'allow',
  'git diff *': 'allow',
  'git log *': 'allow',
  'git show *': 'allow',
  'git blame *': 'allow',
};

/**
 * Permission decisions OpenCode logged, one line per evaluated command node.
 * @param {string} stderr
 */
function parseEvaluations(stderr) {
  const decisions = [];
  for (const line of stderr.split(/\r?\n/)) {
    const match = /message=evaluated permission=(\S+) pattern=(.*) action\.permission=(\S+) action\.pattern=(.*) action\.action=(\S+)/.exec(line);
    if (!match) continue;
    decisions.push({ permission: match[1], pattern: unquote(match[2]), rulePattern: unquote(match[4]), action: match[5] });
  }
  return decisions;
}

/**
 * @param {string} value
 */
function unquote(value) {
  const trimmed = value.trim();
  if (!trimmed.startsWith('"')) return trimmed;
  return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

export async function run() {
  const ctx = new SpikeContext();
  try {
    const llm = ctx.track(await startMockLlm({ respond: scriptedToolCalls(CASES.map((item) => ({ name: 'bash', arguments: { command: item.command, description: item.id } }))) }));
    const ws = ctx.track(await createWorkspace({
      label: 'f-bash',
      opencodeConfig: profileConfig({ permission: CONFIG_PERMISSION }),
      pluginConfig: providerPluginConfig(llm.baseURL),
    }));
    // Fake dotnet and cm executables, so an allowed command proves it ran without touching a real
    // toolchain or version-control client.
    const bin = ws.sandbox.dirs.bin;
    const dotnetLog = path.join(bin, 'dotnet-calls.log');
    const cmLog = path.join(bin, 'cm-calls.log');
    await fs.writeFile(path.join(bin, 'dotnet.cmd'), `@echo off\r\n>>"${dotnetLog}" echo %*\r\necho BUILD_OK\r\n`);
    await fs.writeFile(path.join(bin, 'cm.cmd'), `@echo off\r\n>>"${cmLog}" echo %*\r\necho FAKE_CM\r\n`);
    const env = ws.env({
      PATH: `${bin};${ws.sandbox.env.PATH}`,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ agent: { 'unity-code': { permission: { ...CONFIG_PERMISSION, bash: AGENT_BASH_PERMISSION } } } }),
    });
    const result = await runOpencode({
      args: ['run', '--print-logs', '--log-level', 'INFO', '--format', 'json', '--agent', 'unity-code', 'Run the checks'],
      env,
      cwd: ws.project,
      timeoutMs: 300_000,
    });
    const hooks = ws.readHooks();
    const decisions = parseEvaluations(result.stderr).filter((decision) => decision.permission === 'bash');
    const shellLine = /message="shell tool using shell" shell="?([^"\n\r]+)"?/.exec(result.stderr);
    const dotnetCalls = await readLines(dotnetLog);
    const cmCalls = await readLines(cmLog);

    /** @type {Array<Record<string, unknown>>} */
    const cases = [];
    CASES.forEach((item, index) => {
      const output = String(toolResultAfter(llm.chatRequests, index) ?? '');
      const denied = output.includes(DENIED_TEXT);
      // OpenCode evaluates one pattern per parsed command node, so a chain logs one decision per part.
      const evaluated = decisions.filter((decision) => item.command.includes(decision.pattern));
      const actual = denied ? 'deny' : 'allow';
      cases.push({ id: item.id, command: item.command, expected: item.expect, actual, rules: evaluated.map((decision) => `${decision.rulePattern} -> ${decision.action}`), output: output.slice(0, 120) });
      ctx.checks.add(`${item.id}: ${item.expect}`, actual === item.expect, { rules: evaluated.map((decision) => `${decision.rulePattern} -> ${decision.action}`), output: output.slice(0, 160) });
    });

    ctx.evidence.run = summarizeRun(result, llm, hooks);
    ctx.evidence.shell = shellLine ? path.basename(shellLine[1]) : null;
    ctx.evidence.shellToolId = toolNames(llm.chatRequests[0]?.body).includes('bash') ? 'bash' : toolNames(llm.chatRequests[0]?.body).join(',');
    ctx.evidence.cases = cases;
    ctx.evidence.fakeCalls = { dotnet: dotnetCalls, cm: cmCalls };
    ctx.evidence.decisions = decisions.map((decision) => ({ pattern: decision.pattern, rule: decision.rulePattern, action: decision.action }));

    ctx.checks.add('F15 the shell tool id is "bash"', ctx.evidence.shellToolId === 'bash', ctx.evidence.shellToolId);
    ctx.checks.add('F16 only the two allowed dotnet commands ran', dotnetCalls.length === 2 && cmCalls.length === 0, { dotnet: dotnetCalls, cm: cmCalls });
    ctx.checks.add('F17 the quoted -clp argument survives to the command line', dotnetCalls.some((line) => line.includes('-clp:ErrorsOnly;NoSummary')), dotnetCalls);
  } finally {
    await ctx.closeAll();
  }
  ctx.decision = ctx.checks.allPass
    ? 'Keep the rendered bash allow-list (spec 8.5.2). No ocu-compile.cmd wrapper is needed; the compile command may keep its quoted -clp argument.'
    : 'Ship ocu-compile.cmd <csproj> in the profile and allow that one command pattern instead of the full dotnet command.';
  ctx.findings.push(
    `The Windows shell OpenCode picked was ${ctx.evidence.shell ?? 'unknown'} (first acceptable of pwsh, powershell, git bash, cmd; SHELL is unset in the clean room). The shell tool id is "bash".`,
    'The permission pattern is the whole command text of each parsed command node, so a chain such as `dotnet build X.csproj && git push` is evaluated per node and the VCS write still loses.',
    'A quoted argument containing a semicolon stays inside one pattern and reaches the process command line unchanged, so `dotnet build <csproj> *` covers the facts compile command.',
    'Denied calls return the tool error "The user has specified a rule which prevents you from using this specific tool call", including the matching ruleset, and the session keeps running.',
    'With `--print-logs --log-level INFO`, every decision is logged as `message=evaluated permission=bash pattern=<command> action.pattern=<rule> action.action=<allow|deny>`, which is the cheapest evidence for contract test C3.',
  );
  return ctx;
}

/**
 * @param {string} file
 * @returns {Promise<string[]>}
 */
async function readLines(file) {
  const text = await fs.readFile(file, 'utf8').catch(() => '');
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}
