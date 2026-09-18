// The machine report (spec 5.3, 5.4; amendment 33.9 `data.platform`).
//
// Every finding is in the document, including the ones that passed and the ones that did not apply,
// because a consumer comparing two runs needs to tell "clean" from "never asked".
import { describeLogSource } from './logs.js';

/** @typedef {import('./context.js').DoctorContext} DoctorContext */
/** @typedef {import('./engine.js').DoctorReport} DoctorReport */

/**
 * @param {DoctorContext} context
 * @param {DoctorReport} report
 * @returns {Record<string, unknown>}
 */
export function buildJsonReport(context, report) {
  const { facts, doctorTier, capabilities, refusedCommands } = context.platformInfo;
  return {
    platform: {
      os: facts.os,
      arch: facts.arch,
      backend: facts.backend,
      tier: doctorTier.tier,
      reason: doctorTier.reason,
      notMeasured: doctorTier.notMeasured,
      row: doctorTier.row,
      rowLabel: doctorTier.rowLabel,
      virtualization: facts.virtualization,
      capabilities: capabilities.map((capability) => ({
        id: capability.id,
        applicable: capability.applicable,
        measured: capability.measured,
        required: capability.required,
      })),
      refusedCommands,
    },
    scope: context.home.installed ? 'installed' : 'not-installed',
    target: context.opencode.config.target,
    strict: report.strict,
    counts: report.counts,
    worst: report.worst,
    home: context.home.dir,
    cliVersion: context.cliVersion,
    project: {
      path: context.project.path,
      root: context.project.root,
      projectId: context.project.projectId,
      initialized: context.project.initialized,
    },
    ollama: {
      baseUrl: context.ollama.baseUrl,
      reachable: context.ollama.reachable,
      version: context.ollama.version,
      testedVersion: context.ollama.testedVersion,
    },
    opencode: {
      path: context.opencode.binary.path,
      version: context.opencode.binary.version,
      testedVersion: context.opencode.testedVersion,
      deep: context.opencode.deep === null ? null : { ok: context.opencode.deep.ok },
    },
    logs: { source: context.logs.source.kind, location: describeLogSource(context.logs.source), checked: context.logs.read },
    checks: report.findings.map((finding) => ({
      id: finding.id,
      group: finding.group,
      severity: finding.severity,
      declaredSeverity: finding.declaredSeverity,
      loweredBy: finding.loweredBy,
      message: finding.message,
      details: finding.details,
      fix: finding.fix,
      data: finding.data,
    })),
  };
}
