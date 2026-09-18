// Unity project checks (spec 5.4, 9.3, 9.8).
import { checkFactsFreshness } from '../../facts/stale.js';
import { info, pass, quantity, skip, warn } from '../finding.js';

/** @typedef {import('../engine.js').CheckSpec} CheckSpec */

const STALE_REASONS = Object.freeze({
  missing: 'the recorded inputs hash is missing',
  generator: 'the facts were written by a different generator version',
  inputs: 'a file the facts were built from has changed',
});

/** @type {readonly CheckSpec[]} */
export const UNITY_CHECKS = Object.freeze([
  {
    id: 'unity.compile-check',
    group: 'unity',
    title: 'Compile check available',
    severities: ['warn'],
    why: 'Without a generated project file and a .NET SDK the agent cannot compile what it wrote, so a change is reviewed on the strength of how plausible it reads.',
    fix: 'Open the project in Unity once to generate the project files, and install a .NET SDK.',
    source: 'spec 9.3',
    run: (context) => {
      const scan = context.project.scan;
      if (scan === null) return skip('there is no Unity project here to scan');
      const csproj = scan.projectFiles.csproj;
      /** @type {string[]} */
      const problems = [];
      if (csproj.length === 0) problems.push('no generated csproj was found; open the project in Unity once');
      if (scan.dotnet.checked && !scan.dotnet.present) problems.push('no .NET SDK was found on PATH');
      if (!scan.dotnet.checked) problems.push('the .NET SDK was not checked on this run');
      if (scan.staleness.stale) {
        problems.push(`${scan.staleness.count} source file or assembly is not in any generated project file`);
      }
      const data = {
        csproj: csproj.map((file) => file.name),
        dotnet: scan.dotnet,
        staleness: { count: scan.staleness.count, examples: scan.staleness.examples },
      };
      if (problems.length === 0) return pass(`${quantity(csproj.length, 'generated project file')} and a .NET SDK are available`, { data });
      return warn('the compile check is not fully available in this project', { details: problems, data });
    },
  },
  {
    id: 'unity.facts-stale',
    group: 'unity',
    title: 'Project facts current',
    severities: ['warn'],
    why: 'Stale facts describe a project that no longer exists, and the model trusts them over what it can see.',
    fix: 'Run opencode-unity init --refresh.',
    source: 'spec 9.8',
    run: (context) => {
      const hash = context.project.inputsHash;
      if (!context.project.initialized || hash === null) return skip('no facts have been written for this project');
      const freshness = checkFactsFreshness(context.project.projectJson, hash);
      if (!freshness.stale) return pass('the project facts match the files they were built from');
      return warn(`the project facts are out of date: ${STALE_REASONS[freshness.reason ?? 'inputs']}`, {
        data: { reason: freshness.reason },
      });
    },
  },
  {
    id: 'unity.opencode-dir',
    group: 'unity',
    title: 'No .opencode folder in the project',
    severities: ['warn'],
    why: 'OpenCode treats a project .opencode folder as a configuration directory and writes into it at every start, which means a version-controlled tree gains files nobody added.',
    fix: 'Remove the folder, or add it to the ignore file for this version control system.',
    source: 'OpenCode config/config.ts and spec 9.4',
    run: (context) => {
      const scan = context.project.scan;
      if (scan === null) return skip('there is no Unity project here to scan');
      if (!scan.opencodeDir) return pass('the project has no .opencode folder');
      return warn('the project has an .opencode folder that OpenCode writes into at every start', {
        details: ['OpenCode writes a .gitignore there and installs its plugin package into it'],
        data: { root: scan.root },
      });
    },
  },
  {
    id: 'unity.project-found',
    group: 'unity',
    title: 'Unity project found',
    severities: ['warn', 'info'],
    why: 'Half of this report is about one project; when there is none under the given path, those checks were never asked rather than answered.',
    fix: 'Point doctor at a Unity project directory, or pass --project <dir>.',
    source: 'spec 5.4',
    run: (context) => {
      if (context.project.scanError !== null) {
        return warn(`the Unity project could not be scanned: ${context.project.scanError}`, { data: { path: context.project.path } });
      }
      if (context.project.root === null) {
        return info(`no Unity project was found at or above ${context.project.path}`, {
          details: ['the project checks in this report were skipped'],
          data: { path: context.project.path },
        });
      }
      const editorVersion = context.project.scan?.unity.editorVersion ?? 'of an unknown version';
      return pass(`Unity project ${editorVersion} at ${context.project.root}`, {
        data: { root: context.project.root, projectId: context.project.projectId, editorVersion },
      });
    },
  },
]);
