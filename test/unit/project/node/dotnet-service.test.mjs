import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createMemoryFsView, createNodeFsView } from '../../../../src/unity/fs-view.js';
import { createReadBudget } from '../../../../src/project/budget.js';
import { discoverComponents, walkTree } from '../../../../src/project/discover.js';
import { detectDotnetService, EF_CORE_PREFIX, WEB_SDK } from '../../../../src/project/components/dotnet-service.js';

const WORKSPACES = fileURLToPath(new URL('../../../fixtures/workspaces/', import.meta.url));
const ROOT = process.platform === 'win32' ? 'C:\\dotnet-tests' : '/dotnet-tests';

/**
 * @param {Record<string, string | null>} tree
 * @param {{ declaredBy?: string }} [options]
 */
function detect(tree, { declaredBy = 'Api/Api.csproj' } = {}) {
  const view = createMemoryFsView(Object.fromEntries(Object.entries(tree).map(([file, value]) => [path.join(ROOT, file), value])));
  const walk = walkTree(view, ROOT);
  const budget = createReadBudget(view, ROOT);
  const dir = declaredBy.includes('/') ? declaredBy.slice(0, declaredBy.lastIndexOf('/')) : '';
  return { facts: detectDotnetService(budget, { dir, declaredBy, files: walk.files }), budget };
}

/**
 * @param {...string} lines
 */
function project(...lines) {
  return ['<Project Sdk="Microsoft.NET.Sdk.Web">', '  <PropertyGroup>', '    <TargetFramework>net10.0</TargetFramework>', '  </PropertyGroup>', ...lines, '</Project>'].join('\n');
}

describe('the web SDK anchor (claim B20)', () => {
  it('records the SDK and the target framework', () => {
    const { facts } = detect({ 'Api/Api.csproj': project() });
    assert.equal(facts.status, 'ok');
    assert.equal(facts.sdk, WEB_SDK);
    assert.equal(facts.targetFramework, 'net10.0');
    assert.ok(facts.evidence.some((entry) => entry.signature === 'dotnet/anchor.web-sdk' && entry.file === 'Api/Api.csproj'));
  });

  it('keeps a multi-target list as written', () => {
    const text = '<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><TargetFrameworks>net8.0;net10.0</TargetFrameworks></PropertyGroup></Project>';
    assert.equal(detect({ 'Api/Api.csproj': text }).facts.targetFramework, 'net8.0;net10.0');
  });

  it('records package reference names and never their versions', () => {
    const { facts } = detect({
      'Api/Api.csproj': project('  <ItemGroup>', `    <PackageReference Include="${EF_CORE_PREFIX}.Design" Version="10.0.0" />`, '    <PackageReference Include="Serilog.AspNetCore" Version="9.0.0" />', '  </ItemGroup>'),
    });
    assert.deepEqual(facts.packageReferences, [`${EF_CORE_PREFIX}.Design`, 'Serilog.AspNetCore']);
    assert.equal(JSON.stringify(facts.packageReferences).includes('10.0.0'), false);
  });

  it('reports EF Core only when a reference names it', () => {
    assert.equal(detect({ 'Api/Api.csproj': project('  <ItemGroup><PackageReference Include="Microsoft.EntityFrameworkCore" /></ItemGroup>') }).facts.efCore, true);
    assert.equal(detect({ 'Api/Api.csproj': project('  <ItemGroup><PackageReference Include="Serilog.AspNetCore" /></ItemGroup>') }).facts.efCore, false);
  });

  it('returns unreadable rather than a guess when the project file cannot be read', () => {
    const { facts } = detect({ 'Api/Other.csproj': project() });
    assert.equal(facts.status, 'unreadable');
    assert.deepEqual(facts.warnings, ['component.unreadable']);
    assert.equal(facts.sdk, null);
  });
});

describe('references are repository content (S15)', () => {
  it('resolves a reference written with backslashes, relative to the project file', () => {
    const { facts } = detect({
      'Api/Api.csproj': project('  <ItemGroup><ProjectReference Include="..\\Shared\\Shared.csproj" /></ItemGroup>'),
      'Shared/Shared.csproj': '<Project Sdk="Microsoft.NET.Sdk" />',
    });
    assert.deepEqual(facts.projectReferences, ['Shared/Shared.csproj']);
  });

  it('drops a reference that leaves the workspace instead of recording it', () => {
    const { facts } = detect({ 'Api/Api.csproj': project('  <ItemGroup><ProjectReference Include="..\\..\\..\\elsewhere\\X.csproj" /></ItemGroup>') });
    assert.deepEqual(facts.projectReferences, []);
  });
});

describe('a test project is one that references this one, not one that is named like it', () => {
  it('finds the referencing project and ignores a similarly named one that does not', () => {
    const { facts } = detect({
      'Api/Api.csproj': project(),
      'Api.Tests/Api.Tests.csproj': '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><ProjectReference Include="..\\Api\\Api.csproj" /></ItemGroup></Project>',
      'Api.Bench/Api.Bench.csproj': '<Project Sdk="Microsoft.NET.Sdk" />',
    });
    assert.deepEqual(facts.testProjects, ['Api.Tests/Api.Tests.csproj']);
  });

  it('stops after the bounded number of other projects', () => {
    /** @type {Record<string, string>} */
    const tree = { 'Api/Api.csproj': project() };
    for (let index = 0; index < 12; index += 1) tree[`P${index}/P${index}.csproj`] = '<Project Sdk="Microsoft.NET.Sdk" />';
    const { facts } = detect(tree);
    assert.equal(facts.testProjectsTruncated, true);
    assert.deepEqual(facts.testProjects, []);
  });
});

describe('appsettings is listed and never opened (37.9)', () => {
  it('records every appsettings file beside the project as a path', () => {
    const { facts, budget } = detect({
      'Api/Api.csproj': project(),
      'Api/appsettings.json': '{"ConnectionStrings":{"Default":"OCU-TEST-SECRET"}}',
      'Api/appsettings.Production.json': '{"ConnectionStrings":{"Default":"OCU-TEST-SECRET"}}',
    });
    assert.deepEqual(facts.secretFiles, ['Api/appsettings.Production.json', 'Api/appsettings.json']);
    assert.ok(facts.warnings.includes('component.secret-file-present'));
    assert.deepEqual(budget.state.opened, ['Api/Api.csproj']);
    assert.equal(JSON.stringify(facts).includes('OCU-TEST-SECRET'), false);
  });
});

describe('the committed fixture', () => {
  it('describes the .NET workspace and reads no connection string out of it', () => {
    const root = path.join(WORKSPACES, 'backend-only-dotnet');
    const discovery = discoverComponents(createNodeFsView(), root);
    const anchor = discovery.anchors.find((component) => component.kind === 'dotnet-service');
    assert.ok(anchor);

    const facts = detectDotnetService(discovery.budget, { dir: anchor.dir, declaredBy: anchor.declaredBy, files: discovery.walk.files });
    assert.equal(facts.sdk, WEB_SDK);
    assert.equal(facts.targetFramework, 'net10.0');
    assert.deepEqual(facts.secretFiles, ['Api/appsettings.json']);
    assert.equal(discovery.budget.state.opened.includes('Api/appsettings.json'), false);
    assert.equal(discovery.budget.readText('Api/appsettings.json').status, 'denied', 'the scanner itself is refused, not only the model');
    assert.equal(JSON.stringify(facts).includes('CANARY'), false);
  });
});
