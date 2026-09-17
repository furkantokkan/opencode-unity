// Test assemblies (spec 9.2): which asmdefs are Unity Test Framework assemblies, and in which mode.
import { findPackage } from './packages.js';

export const TEST_FRAMEWORK_PACKAGE_ID = 'com.unity.test-framework';

const TEST_RUNNER_NAMES = new Set(['UnityEngine.TestRunner', 'UnityEditor.TestRunner']);

// GUIDs of the Test Framework's runner assemblies, as written by asmdefs saved with "Use GUIDs".
const TEST_RUNNER_GUIDS = new Set(['27619889b8ba8c24980f49ee34dbb44a', '0acc523941302664db1f4e527237feb3']);

/** @typedef {'EditMode' | 'PlayMode'} TestMode */

/**
 * @param {{ includePlatforms: string[], defineConstraints: string[], references: string[], optionalUnityReferences: string[] }} asmdef
 * @returns {{ isTest: boolean, testMode: TestMode | null }}
 */
export function classifyTestAssembly(asmdef) {
  const isTest =
    asmdef.defineConstraints.some((constraint) => constraint.trim() === 'UNITY_INCLUDE_TESTS') ||
    asmdef.references.some(isTestRunnerReference) ||
    asmdef.optionalUnityReferences.includes('TestAssemblies');
  if (!isTest) return { isTest: false, testMode: null };
  const editorOnly = asmdef.includePlatforms.length === 1 && asmdef.includePlatforms[0] === 'Editor';
  return { isTest: true, testMode: editorOnly ? 'EditMode' : 'PlayMode' };
}

/**
 * @param {string} reference  An assembly name or `GUID:<hex>`.
 * @returns {boolean}
 */
export function isTestRunnerReference(reference) {
  if (TEST_RUNNER_NAMES.has(reference)) return true;
  const guid = /^GUID:([0-9a-fA-F]{32})$/.exec(reference);
  return Boolean(guid && TEST_RUNNER_GUIDS.has(guid[1].toLowerCase()));
}

/**
 * @typedef {object} TestsFact
 * @property {Array<{ name: string, folder: string, mode: TestMode }>} assemblies  EditMode first, then by name.
 * @property {{ present: boolean, version: string | null }} testFramework
 */

/**
 * @param {import('./assemblies.js').AsmdefRecord[]} definitions
 * @param {import('./packages.js').PackageInfo[]} packages
 * @returns {TestsFact}
 */
export function summarizeTests(definitions, packages) {
  const assemblies = definitions
    .filter((definition) => definition.isTest && definition.testMode)
    .map((definition) => ({ name: definition.name, folder: definition.folder, mode: /** @type {TestMode} */ (definition.testMode) }))
    .sort((a, b) => (a.mode === b.mode ? compareText(a.name, b.name) : a.mode === 'EditMode' ? -1 : 1));
  const framework = findPackage(packages, TEST_FRAMEWORK_PACKAGE_ID);
  return { assemblies, testFramework: { present: Boolean(framework), version: framework?.version ?? null } };
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareText(a, b) {
  return a === b ? 0 : a < b ? -1 : 1;
}
