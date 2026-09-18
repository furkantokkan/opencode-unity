// The `dotnet-service` detector (amendment 37.3, `D-B18`, area 14.9.3).
//
// The most likely non-Node backend behind a Unity game is C#, and `dotnet build` already exists in the
// design, so a `Microsoft.NET.Sdk.Web` project is a first-class anchor rather than a special case
// (claim B20). Discovery has already matched the SDK attribute to declare the component; this module
// reads the same file once more for the facts a rule block and a verify command need.
//
// What it never opens is as important as what it reads. `appsettings*.json` is the standard place a
// connection string ends up, so it is read-denied for the scanner as well as for the model (37.9): it
// is listed as a path and nothing more. The `Migrations/` folder belongs to the `database` overlay,
// which counts its entries without opening one.
import { evidenceRow } from '../signatures.js';
import { joinInsideWorkspace } from '../entry.js';

/** claim B20: the MSBuild SDK for ASP.NET Core apps, and the only SDK that declares this anchor. */
export const WEB_SDK = 'Microsoft.NET.Sdk.Web';

const SDK_PATTERN = /Sdk\s*=\s*"([^"]+)"/;
const TARGET_FRAMEWORK_PATTERN = /<TargetFrameworks?>([^<]+)<\/TargetFrameworks?>/;
const PACKAGE_REFERENCE_PATTERN = /<PackageReference\s[^>]*Include\s*=\s*"([^"]+)"/g;
const PROJECT_REFERENCE_PATTERN = /<ProjectReference\s[^>]*Include\s*=\s*"([^"]+)"/g;

/** The package family whose presence, beside a `Migrations/` folder, declares a database overlay. */
export const EF_CORE_PREFIX = 'Microsoft.EntityFrameworkCore';

/** A project this one is not: reading every `.csproj` in a large tree is the cost this cap removes. */
const MAX_REFERRING_PROJECTS = 8;

/**
 * @typedef {object} DotnetServiceFacts
 * @property {'ok' | 'unreadable' | 'unbudgeted'} status
 * @property {string} dir
 * @property {string} declaredBy
 * @property {string | null} sdk
 * @property {string | null} targetFramework   Verbatim; a multi-target list is kept as written.
 * @property {string[]} packageReferences      Names only, sorted. Never a version (37.5).
 * @property {boolean} efCore
 * @property {string[]} projectReferences      Resolved workspace paths, sorted.
 * @property {string[]} testProjects           Projects that reference this one, sorted.
 * @property {boolean} testProjectsTruncated
 * @property {string[]} secretFiles            `appsettings*.json` beside the project; never opened.
 * @property {import('../signatures.js').EvidenceEntry[]} evidence
 * @property {string[]} warnings
 */

/**
 * @param {string} dir
 * @param {string} declaredBy
 * @param {'ok' | 'unreadable' | 'unbudgeted'} status
 * @returns {DotnetServiceFacts}
 */
function emptyFacts(dir, declaredBy, status) {
  return {
    status,
    dir,
    declaredBy,
    sdk: null,
    targetFramework: null,
    packageReferences: [],
    efCore: false,
    projectReferences: [],
    testProjects: [],
    testProjectsTruncated: false,
    secretFiles: [],
    evidence: [],
    warnings: status === 'unreadable' ? ['component.unreadable'] : [],
  };
}

/**
 * @param {import('../budget.js').ReadBudget} budget
 * @param {object} options
 * @param {string} options.dir
 * @param {string} options.declaredBy        The `.csproj` that declared the component.
 * @param {readonly string[]} [options.files]
 * @param {string} [options.component]
 * @param {boolean} [options.findTestProjects]
 * @returns {DotnetServiceFacts}
 */
export function detectDotnetService(budget, { dir, declaredBy, files = [], component = `dotnet:${dir}`, findTestProjects = true }) {
  const read = budget.readText(declaredBy, { component });
  if (read.status !== 'ok') return emptyFacts(dir, declaredBy, read.status === 'unbudgeted' ? 'unbudgeted' : 'unreadable');

  const facts = emptyFacts(dir, declaredBy, 'ok');
  const text = read.text ?? '';
  facts.sdk = SDK_PATTERN.exec(text)?.[1] ?? null;
  facts.evidence.push(evidenceRow('anchor', 'dotnet/anchor.web-sdk', declaredBy));

  const target = TARGET_FRAMEWORK_PATTERN.exec(text)?.[1]?.trim();
  if (target !== undefined && target !== '') facts.targetFramework = target;

  facts.packageReferences = matchAll(text, PACKAGE_REFERENCE_PATTERN);
  facts.efCore = facts.packageReferences.some((name) => name === EF_CORE_PREFIX || name.startsWith(`${EF_CORE_PREFIX}.`));
  // The rule that a project referencing EF Core turns a `Migrations/` folder into a database overlay
  // is this product's own (37.3), so that is what the evidence names rather than a vendor page.
  if (facts.efCore) facts.evidence.push(evidenceRow('signal', 'spec:37.3', declaredBy));

  facts.projectReferences = resolveReferences(dir, matchAll(text, PROJECT_REFERENCE_PATTERN));
  readSecretFiles(facts, files);
  if (findTestProjects) readTestProjects(facts, budget, files, component);
  return facts;
}

/**
 * A test project is one that references this one; the name it happens to carry is a convention, not a
 * fact, so the reference is what decides. Bounded: at most eight other projects are opened.
 * @param {DotnetServiceFacts} facts
 * @param {import('../budget.js').ReadBudget} budget
 * @param {readonly string[]} files
 * @param {string} component
 */
function readTestProjects(facts, budget, files, component) {
  const others = files.filter((file) => file !== facts.declaredBy && file.toLowerCase().endsWith('.csproj'));
  facts.testProjectsTruncated = others.length > MAX_REFERRING_PROJECTS;
  for (const other of others.slice(0, MAX_REFERRING_PROJECTS)) {
    const read = budget.readText(other, { component });
    if (read.status !== 'ok') continue;
    const dir = other.includes('/') ? other.slice(0, other.lastIndexOf('/')) : '';
    if (!resolveReferences(dir, matchAll(read.text ?? '', PROJECT_REFERENCE_PATTERN)).includes(facts.declaredBy)) continue;
    facts.testProjects.push(other);
  }
  facts.testProjects.sort();
}

/**
 * MSBuild writes references with backslashes, and they are relative to the project file. Every one is
 * repository content, so a reference that leaves the workspace resolves to nothing (S15).
 * @param {string} dir
 * @param {readonly string[]} references
 * @returns {string[]}
 */
function resolveReferences(dir, references) {
  /** @type {Set<string>} */
  const resolved = new Set();
  for (const reference of references) {
    const target = joinInsideWorkspace(dir, reference);
    if (target !== null) resolved.add(target);
  }
  return [...resolved].sort();
}

/**
 * @param {DotnetServiceFacts} facts
 * @param {readonly string[]} files
 */
function readSecretFiles(facts, files) {
  const prefix = facts.dir === '' ? '' : `${facts.dir}/`;
  for (const file of files) {
    if (!file.startsWith(prefix)) continue;
    const name = file.slice(prefix.length);
    if (name.includes('/')) continue;
    if (!/^appsettings.*\.json$/i.test(name)) continue;
    facts.secretFiles.push(file);
  }
  if (facts.secretFiles.length > 0) facts.warnings.push('component.secret-file-present');
}

/**
 * @param {string} text
 * @param {RegExp} pattern  Global; a fresh `lastIndex` is taken for every call.
 * @returns {string[]} Sorted, deduplicated captures.
 */
function matchAll(text, pattern) {
  /** @type {Set<string>} */
  const found = new Set();
  for (const match of text.matchAll(new RegExp(pattern.source, pattern.flags))) {
    const value = match[1]?.trim();
    if (value !== undefined && value !== '') found.add(value);
  }
  return [...found].sort();
}
