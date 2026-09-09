import { serverStorageFixture, storageImageFixture } from './test-fixtures/server-storage.ts';
import { serverStoragePolicy } from './server-storage.ts';
import { cargoConfigurationFixture, rustBuildIdentityFixture } from './test-fixtures/cargo.ts';
import { rustBuildCommand } from './rust-build.ts';
import { configurationHash, configurationIdentity, containerConfiguration, readCampaignConfiguration } from './configuration.ts';
import { dependencyIdentity, readCampaignDependencies } from './dependencies.ts';
import { ACCESS_CONTRACT, ACCESS_REFRESH_CONTRACT, accessProfile, accessRefreshProfile, accessSeed } from './contracts/access.ts';
import { mkdtemp, readFile, rm, writeFile, mkdir, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { encodeSourceSnapshot, readCampaignSource, sha256, validateSourceSnapshot } from './source-snapshot.ts';
import { expect, test } from 'bun:test';
import { hash } from './contracts/screens.ts';
import { arrayScreenQuery, canonicalData, measureScreens } from './contracts/screens.ts';
import { publishCampaign, renderCampaign, renderCampaignDetails, validateAnnotations, validateManifest, type Annotation } from './campaign-report.ts';
import { compactCoverage, findingGroups, reportDetailsPath, validateFindingSelection } from './report-editorial.ts';
import { planCampaign, type CampaignConfig, type CampaignManifest } from './campaign.ts';
import { resultProfile } from './profiles.ts';
import type { BenchmarkResult, JsonObject } from './types.ts';
import { stacks } from './stacks.ts';
import { suites } from './suites.ts';

const fixturePackage = JSON.stringify({ dependencies: { fixture: '1.0.0' } });
const fixtureDependencyPackage = JSON.stringify({ name: 'fixture', version: '1.0.0' });
const fixtureContents = { 'package.json': Buffer.from(fixturePackage).toString('base64'), 'src/test.ts': Buffer.from('fixture source').toString('base64') };
const dependencyBody = { version: 1 as const, roots: ['node_modules'], rootManifestSha256: sha256(fixturePackage), entries: {
  'node_modules': { kind: 'directory' as const, mode: 0o755 },
  'node_modules/fixture': { kind: 'directory' as const, mode: 0o755 },
  'node_modules/fixture/package.json': { kind: 'file' as const, sha256: sha256(fixtureDependencyPackage), bytes: Buffer.byteLength(fixtureDependencyPackage), mode: 0o644 },
}, packages: { fixture: { declared: '1.0.0', version: '1.0.0', manifest: 'node_modules/fixture/package.json' } } };
const dependencyFixture = { ...dependencyBody, fingerprint: sha256(JSON.stringify(dependencyBody)) };
const dependencyBytes = Buffer.from(JSON.stringify(dependencyFixture, null, 2) + '\n');

function configurationFixture(source: JsonObject) {
  // Synthetic renderer evidence only; no Docker service or performance claim.
  const body = { version: 1 as const, sourceHash: String(source.sourceHash), runtime: { environment: { sha256: configurationHash({}) }, dotenv: {}, dockerContextEndpointSha256: configurationHash('synthetic') },
    services: Object.fromEntries(stacks.map(stack => [stack.id, { composeFile: 'src/test.ts', composeSha256: sha256('fixture source'), resolvedComposeSha256: configurationHash('synthetic compose'), containers: [containerConfiguration({ Name: '/test', Image: storageImageFixture, Config: { Labels: { 'com.docker.compose.service': 'test' } }, HostConfig: {} })] }])) };
  const record = { ...body, fingerprint: configurationHash(body) }, bytes = Buffer.from(JSON.stringify(record));
  return { bytes, identity: configurationIdentity(record, bytes) };
}

function fixture(): CampaignManifest {
  const config: CampaignConfig = { version: 1, purpose: 'publication', seed: 1, trials: 5, trialTimeoutMs: 1000, stacks: ['electric'], scenarios: ['local-query'], network: { id: 'local-loopback', injectedLatencyMs: 0, injectedLossPct: 0 }, stoppingRule: 'Five trials' };
  const files = { 'package.json': { kind: 'file', mode: 420, sha256: sha256(fixturePackage) }, 'src/test.ts': { kind: 'file', mode: 420, sha256: sha256('fixture source') } };
  const source = { version: 2, files, sourceHash: hash(files), revision: 'test-revision', dirty: false, snapshot: { path: 'SOURCE.json', format: 'benchmark-source-v1', sha256: '' } };
  source.snapshot.sha256 = sha256(encodeSourceSnapshot(source, fixtureContents));
  const manifest: CampaignManifest = { version: 1, id: 'test-campaign', status: 'complete', config, source, serverStoragePolicy, configuration: configurationFixture(source).identity, dependencies: dependencyIdentity(dependencyFixture, dependencyBytes), machine: { cpuModel: 'test', memoryBytes: 1000, nodeVersion: 'test', bunVersion: 'test' }, images: { electric: [{ imageId: 'sha256:test-image' }] }, plan: planCampaign(config), attempts: [], startedAt: '2026-09-06T00:00:00Z', annotations: [] };
  for (const entry of manifest.plan) {
    const result: BenchmarkResult = { runId: manifest.id, resultId: `trial-${entry.trial}`, stackId: entry.stackId, scenarioId: entry.scenarioId, status: 'failed', metrics: {}, notes: ['synthetic failure fixture'], startedAt: manifest.startedAt, finishedAt: manifest.startedAt, durationMs: 1, metadata: {} };
    result.metadata.serverStorage = serverStorageFixture(result.stackId);
    result.metadata.profile = resultProfile(result, { ...manifest, network: config.network });
    manifest.attempts.push({ ...entry, resultFile: `${result.resultId}.json`, result });
  }
  return manifest;
}
test('a complete campaign can truthfully report failures', () => { expect(() => validateManifest(fixture())).not.toThrow(); });
test('attachment reports expose their own milestones without inheriting screen workload labels', () => {
  const manifest = fixture(); manifest.config.scenarios = ['blob-flow']; manifest.plan = planCampaign(manifest.config);
  manifest.attempts = manifest.plan.map((entry, i) => {
    const result = { ...manifest.attempts[i].result, scenarioId: 'blob-flow' as const };
    result.metadata.serverStorage = serverStorageFixture(result.stackId);
    result.metadata.profile = resultProfile(result, { ...manifest, network: manifest.config.network });
    return { ...entry, result, resultFile: `${result.resultId}.json` };
  });
  const report = renderCampaignDetails(manifest);
  expect(report).toContain('## Attachments');
  expect(report).toContain('Two deterministic 2 MiB objects');
  expect(report).toContain('initial metadata visible');
  expect(report).toContain('trial durations');
  expect(report).not.toContain('100,000 validated local tasks');
});
test('publication rejects missing attempts, smoke campaigns and corrupt provenance', () => {
  let manifest = fixture(); manifest.attempts.pop(); expect(() => validateManifest(manifest)).toThrow('missing');
  manifest = fixture(); manifest.config.purpose = 'smoke'; expect(() => validateManifest(manifest)).toThrow('Smoke');
  manifest = fixture(); manifest.source.sourceHash = 'corrupted'; expect(() => validateManifest(manifest)).toThrow('provenance');
  manifest = fixture(); delete manifest.dependencies; expect(() => validateManifest(manifest)).toThrow('dependency provenance');
  manifest = fixture(); delete manifest.configuration; expect(() => validateManifest(manifest)).toThrow('configuration provenance');
  manifest = fixture(); manifest.images = {}; expect(() => validateManifest(manifest)).toThrow('Image provenance');
});
function annotation(manifest: CampaignManifest): Annotation {
  const result = manifest.attempts[0].result;
  return { id: 'failure', resultIds: [result.resultId], sourceHash: String(manifest.source.sourceHash), resultDigests: { [result.resultId]: hash(result) }, status: 'supported-hypothesis', observation: 'A failure occurred', explanation: 'Trace supports a possible cause', implication: 'Recovery requires investigation', nextExperiment: 'Isolate the failing operation', evidence: [{ path: 'trace.json', kind: 'trace', description: 'Recorded trace' }] };
}
function selectFindings(manifest: CampaignManifest) {
  manifest.annotations = Array.from({ length: 3 }, (_, i) => ({ ...annotation(manifest), id: `synthetic-finding-${i}`,
    observation: `Synthetic finding ${i}`, question: 'What happened to the attempted screen workload?',
    table: { scenarioId: 'local-query', metrics: [] },
    resultIds: manifest.attempts.map(a => a.result.resultId),
    resultDigests: Object.fromEntries(manifest.attempts.map(a => [a.result.resultId, hash(a.result)])),
  }));
  manifest.report = { findingIds: (manifest.annotations as Annotation[]).map(a => a.id) };
}
test('annotations expire when results/configurations change and confirmation requires causal evidence', () => {
  const manifest = fixture(); const item = annotation(manifest); manifest.annotations = [item];
  expect(() => validateAnnotations(manifest)).not.toThrow();
  item.status = 'confirmed'; expect(() => validateAnnotations(manifest)).toThrow('causal evidence');
  item.evidence[0].kind = 'controlled-experiment'; expect(() => validateAnnotations(manifest)).not.toThrow();
  manifest.attempts[0].result.notes.push('changed result'); expect(() => validateAnnotations(manifest)).toThrow('changed results');
});


test('publication requires verified source bytes and bundles them with the report', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bench-publish-'));
  try {
    const manifest = fixture();
    selectFindings(manifest);
    const path = join(dir, 'CAMPAIGN.json');
    await writeFile(path, JSON.stringify(manifest));
    for (const attempt of manifest.attempts) await writeFile(join(dir, attempt.resultFile), JSON.stringify(attempt.result));
    await expect(publishCampaign(path, dir)).rejects.toThrow();
    await writeFile(join(dir, 'SOURCE.json'), 'corrupted');
    await expect(publishCampaign(path, dir)).rejects.toThrow('artifact hash');
    const bytes = encodeSourceSnapshot(manifest.source, fixtureContents);
    await writeFile(join(dir, 'SOURCE.json'), bytes);
    await expect(publishCampaign(path, dir)).rejects.toThrow();
    await writeFile(join(dir, 'DEPENDENCIES.json'), dependencyBytes);
    await expect(publishCampaign(path, dir)).rejects.toThrow();
    const configurationBytes = configurationFixture(manifest.source).bytes;
    await writeFile(join(dir, 'CONFIGURATION.json'), configurationBytes);
    await writeFile(join(dir, 'trace.json'), JSON.stringify({ synthetic: true }));
    await expect(publishCampaign(path, dir)).rejects.toThrow(); // Missing trial logs.
    for (const attempt of manifest.attempts) await writeFile(join(dir, `${attempt.resultFile}.log`), `log for ${attempt.result.resultId}\n`);
    await publishCampaign(path, dir);
    const bundled = await readFile(join(dir, 'results/sources', String(manifest.source.sourceHash), 'SOURCE.json'));
    validateSourceSnapshot(bundled, manifest.source);
    const published = JSON.parse(await readFile(join(dir, 'RESULTS.json'), 'utf8'));
    validateManifest(published);
    expect(await readCampaignSource(dir, published.source)).toEqual(bundled);
    expect(await readCampaignDependencies(dir, published.dependencies, published.source)).toEqual(dependencyBytes);
    expect(await readCampaignConfiguration(dir, published.configuration, published.source, published.config.stacks)).toEqual(configurationBytes);
    expect(await readFile(join(dir, 'RESULTS.md'), 'utf8')).toContain('Exact benchmark source snapshot');
    const details = await readFile(join(dir, reportDetailsPath(manifest.id)), 'utf8');
    expect(details).toContain('[Recorded trace](../../../trace.json)');
    expect(details).toContain('[Measurements and manifest](../../../RESULTS.json)');
    expect(details).toContain(`[Individual trial files and logs](../../../results/reports/${manifest.id}/TRIALS.json)`);
    const index = JSON.parse(await readFile(join(dir, 'results/reports', manifest.id, 'TRIALS.json'), 'utf8'));
    expect(index.attempts).toHaveLength(manifest.attempts.length);
    for (const [i, attempt] of published.attempts.entries()) {
      expect(JSON.parse(await readFile(join(dir, attempt.resultFile), 'utf8'))).toEqual(manifest.attempts[i].result);
      expect(await readFile(join(dir, `${attempt.resultFile}.log`), 'utf8')).toBe(`log for ${attempt.result.resultId}\n`);
    }
    // A separate publication directory must be self-contained: remove the
    // original trial files and regenerate from the published manifest.
    for (const attempt of manifest.attempts) { await rm(join(dir, attempt.resultFile)); await rm(join(dir, `${attempt.resultFile}.log`)); }
    const regenerated = join(dir, 'regenerated'); await mkdir(regenerated);
    await cp(join(dir, 'trace.json'), join(regenerated, 'trace.json'));
    await publishCampaign(join(dir, 'RESULTS.json'), regenerated);
    const second = JSON.parse(await readFile(join(regenerated, 'RESULTS.json'), 'utf8'));
    expect(second.attempts.map((a: any) => a.resultFile)).toEqual(published.attempts.map((a: any) => a.resultFile));
    for (const attempt of second.attempts) expect(await readFile(join(regenerated, `${attempt.resultFile}.log`), 'utf8')).toContain(attempt.result.resultId);

  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('access reports keep native purge, memory refresh and persisted refresh in separate tables', () => {
  const manifest = fixture();
  manifest.config.stacks = ['syncular', 'electric', 'electric-tanstack'];
  manifest.config.scenarios = ['permission-change'];
  manifest.plan = planCampaign(manifest.config);
  manifest.images = Object.fromEntries(manifest.config.stacks.map(stack => [stack, [{ imageId: 'sha256:test-image' }]]));
  manifest.attempts = manifest.plan.map(entry => {
    const native = entry.stackId === 'syncular';
    const result: BenchmarkResult = { runId: manifest.id, resultId: `${entry.stackId}-${entry.trial}`, stackId: entry.stackId, scenarioId: entry.scenarioId, status: 'failed', metrics: {}, notes: ['synthetic failure'], startedAt: manifest.startedAt, finishedAt: manifest.startedAt, durationMs: 1,
      metadata: { workloadContract: native ? ACCESS_CONTRACT : ACCESS_REFRESH_CONTRACT, fixture: accessSeed, accessProfile: native ? accessProfile : accessRefreshProfile(entry.stackId === 'electric' ? 'memory' : 'sqlite') } };
    result.metadata.serverStorage = serverStorageFixture(result.stackId);
    result.metadata.profile = resultProfile(result, { ...manifest, network: manifest.config.network });
    return { ...entry, resultFile: `${result.resultId}.json`, result };
  });
  const report = renderCampaignDetails(manifest);
  expect(report).toContain('## Access revocation: native purge');
  expect(report).toContain('## Access revocation: application refresh (memory)');
  expect(report).toContain('## Access revocation: application refresh (sqlite)');
  expect(report.match(/^## Access revocation:/gm)).toHaveLength(3);
});

test('the main report selects findings while complete metric tables stay in the companion', () => {
  const manifest = fixture(); selectFindings(manifest);
  const extra = { ...annotation(manifest), id: 'unselected', observation: 'Supporting-only observation' };
  manifest.annotations.push(extra);
  const report = renderCampaign(manifest), details = renderCampaignDetails(manifest);
  expect(report.match(/^### /gm)).toHaveLength(3);
  expect(report).toContain('What happened to the attempted screen workload?');
  expect(report).toContain('1 failed; 1 not run; 5 failed trials');
  expect(report).toContain('| electric | 0 / 5 | failed |');
  expect(report).toContain('1 additional reviewed annotation');
  expect(report).not.toContain('Supporting-only observation');
  expect(report).not.toContain('## Task screens');
  expect(details).toContain('Supporting-only observation');
  expect(details).toContain('## Task screens');
  expect(report).toContain('results/reports/test-campaign/DETAILS.md');
});

test('editorial selection rejects missing review, cherry-picked attempts and unmeasured metrics', () => {
  const manifest = fixture();
  expect(() => validateFindingSelection(manifest, [], true)).toThrow('three to five');
  selectFindings(manifest);
  const annotations = manifest.annotations as Annotation[];
  expect(() => validateFindingSelection(manifest, annotations, true)).not.toThrow();
  const item = annotations[0];
  item.resultIds.pop(); expect(() => validateFindingSelection(manifest, annotations)).toThrow('every table attempt');
  item.resultIds.push(manifest.attempts.at(-1)!.result.resultId);
  item.table!.metrics = [{ key: 'invented_ms', label: 'Latency' }];
  expect(() => validateFindingSelection(manifest, annotations)).toThrow('unmeasured metric');
  item.table!.metrics = []; item.question = '';
  expect(() => validateFindingSelection(manifest, annotations)).toThrow('application question');
  item.question = 'Question'; manifest.report!.findingIds.push(item.id);
  expect(() => validateFindingSelection(manifest, annotations)).toThrow('distinct');
  expect(() => reportDetailsPath('../escape')).toThrow('Unsafe');
});

test('compact coverage preserves old failures and distinguishes missing work from unsupported configurations', () => {
  const manifest = fixture();
  manifest.attempts.at(-1)!.result.status = 'completed';
  manifest.attempts.at(-1)!.result.metadata.profile = { eligible: true };
  let coverage = compactCoverage(manifest).join('\n');
  expect(coverage).toContain('1 passed; 1 not run; 4 failed trials');
  const latest = manifest.attempts.at(-1)!.result;
  latest.status = 'unsupported'; latest.metadata.coverage = { status: 'not-implemented' };
  coverage = compactCoverage(manifest).join('\n');
  expect(coverage).toContain('1 not implemented; 1 not run');
  latest.metadata.coverage = { status: 'unsupported-tested-configuration' };
  expect(compactCoverage(manifest).join('\n')).toContain('1 unsupported; 1 not run');
});

test('finding tables separate incompatible guarantees and experimental lanes', () => {
  const manifest = fixture();
  manifest.config.stacks = ['electric', 'syncular', 'jazz-v2'];
  const original = manifest.attempts;
  manifest.attempts = manifest.config.stacks.flatMap(stackId => original.map(a => ({ ...a, stackId, result: { ...a.result, stackId,
    metadata: { profile: { comparisonKey: stackId === 'syncular' ? 'native-purge' : 'refresh', lane: stackId === 'jazz-v2' ? 'experimental' : 'stable' } } } })));
  const item = { ...annotation(manifest), table: { scenarioId: 'local-query', metrics: [] } };
  const groups = findingGroups(manifest, item);
  expect(groups).toHaveLength(3);
  expect(groups.map(g => g.attempts[0][0].stackId)).toEqual(['electric', 'syncular', 'jazz-v2']);
});

test('finding tables use independent trial summaries and suppress a failed latest estimate', async () => {
  const manifest = fixture(), data = canonicalData('local-query');
  const measured = await measureScreens('local-query', { readData: () => data, query: name => arrayScreenQuery(name, data), execution: 'application-processing' });
  // Synthetic trial values make the expected independent-trial summary exact.
  // These fixtures exercise reporting and are never benchmark publications.
  for (const attempt of manifest.attempts) {
    Object.assign(attempt.result, structuredClone(measured));
    attempt.result.status = 'completed';
    const value = attempt.trial * 10;
    (attempt.result.metadata.samples as Record<string, number[]>).list = Array(25).fill(value);
    attempt.result.metrics.list_query_p50_ms = value;
    attempt.result.metrics.list_query_p95_ms = value;
    attempt.result.metadata.serverStorage = serverStorageFixture(attempt.stackId);
    attempt.result.metadata.profile = resultProfile(attempt.result, { ...manifest, network: manifest.config.network });
  }
  const select = () => {
    selectFindings(manifest);
    (manifest.annotations[0] as Annotation).table!.metrics = [{ key: 'list_query_p50_ms', label: 'List p50' }];
  };
  select();
  const report = renderCampaign(manifest);
  expect(report).toContain('List p50 (ms)');
  expect(report).toContain('| electric / application-processing | 5 / 5 | completed | 30.00 [10.00, 50.00] † |');
  expect(report).toContain('† marks an interval wider than 25% of the median');
  manifest.attempts[0].result.status = 'failed';
  manifest.attempts[0].result.metadata.profile = resultProfile(manifest.attempts[0].result, { ...manifest, network: manifest.config.network });
  select();
  expect(renderCampaign(manifest)).toContain('| electric / application-processing | 4 / 5 | completed | 35.00 [20.00–50.00] |');
  manifest.attempts.at(-1)!.result.status = 'timed-out';
  manifest.attempts.at(-1)!.result.metadata.profile = resultProfile(manifest.attempts.at(-1)!.result, { ...manifest, network: manifest.config.network });
  select();
  const failed = renderCampaign(manifest);
  expect(failed).toContain('| electric / application-processing | 3 / 5 | timed-out | timed-out |');
  expect(failed).toContain('2 failed trials');
  expect(failed).not.toContain('35.00 [20.00–50.00]');
});

test('the complete roster stays compact without hiding unselected suite failures', () => {
  const manifest = fixture(), original = manifest.attempts[0].result;
  manifest.config.stacks = stacks.map(s => s.id);
  manifest.config.scenarios = suites.flatMap(s => [...s.cases]);
  manifest.plan = planCampaign(manifest.config);
  const cargoToml = 'synthetic Cargo.toml', cargoLock = 'synthetic Cargo.lock';
  const files = manifest.source.files as JsonObject;
  files['drivers/syncular-rust/Cargo.toml'] = { kind: 'file', mode: 420, sha256: sha256(cargoToml) };
  files['drivers/syncular-rust/Cargo.lock'] = { kind: 'file', mode: 420, sha256: sha256(cargoLock) };
  manifest.source.sourceHash = hash(files);
  manifest.configuration = configurationFixture(manifest.source).identity;
  (manifest.source.snapshot as JsonObject).sha256 = sha256(encodeSourceSnapshot(manifest.source, {
    'src/test.ts': Buffer.from('fixture source').toString('base64'),
    'drivers/syncular-rust/Cargo.toml': Buffer.from(cargoToml).toString('base64'),
    'drivers/syncular-rust/Cargo.lock': Buffer.from(cargoLock).toString('base64'),
  }));
  const binary = { path: '/synthetic/driver', sha256: 'a'.repeat(64), bytes: 1, mode: 0o755 };
  const inputs = rustBuildIdentityFixture(String(manifest.source.sourceHash), binary.sha256);
  manifest.executables = { rustDriver: { origin: 'source-build', executable: binary, build: {
    sourceHash: manifest.source.sourceHash, compiler: { ...binary, version: 'synthetic rustc' }, cargo: { ...binary, version: 'synthetic cargo' },
    inputs, command: rustBuildCommand(binary.path, inputs.target, inputs.targetDirectory),
    environment: { RUSTC: binary.path, RUSTC_WRAPPER: '', RUSTC_WORKSPACE_WRAPPER: '' }, configuration: cargoConfigurationFixture(), cargoTomlSha256: sha256(cargoToml), cargoLockSha256: sha256(cargoLock),
  } } };
  manifest.images = Object.fromEntries(manifest.config.stacks.map(stack => [stack, [{ imageId: 'sha256:test-image' }]]));
  manifest.attempts = manifest.plan.map(entry => {
    const result: BenchmarkResult = { ...structuredClone(original), stackId: entry.stackId, scenarioId: entry.scenarioId, resultId: `${entry.stackId}-${entry.scenarioId}-${entry.trial}` };
    result.metadata.serverStorage = serverStorageFixture(result.stackId);
    result.metadata.profile = resultProfile(result, { ...manifest, network: manifest.config.network });
    return { ...entry, result, resultFile: result.resultId + '.json' };
  });
  selectFindings(manifest);
  const report = renderCampaign(manifest), details = renderCampaignDetails(manifest);
  expect(report.split(/\s+/).length).toBeLessThan(1500);
  expect(report).toContain('| Offline recovery | 5 failed; 25 failed trials');
  expect(report).toContain('| Attachments | 1 failed; 5 failed trials');
  expect(report.match(/^### /gm)).toHaveLength(3);
  expect(details.split(/\s+/).length).toBeGreaterThan(report.split(/\s+/).length);
  expect(details.match(/^## Task screens/gm)).toHaveLength(2); // Stable and experimental tables.
});

test('startup companion tables show each declared extended scale without a hard-coded 100k label', () => {
  const manifest = fixture();
  manifest.config.scenarios = ['bootstrap']; manifest.config.parameters = { startupSizes: [500000, 1000000] };
  manifest.plan = planCampaign(manifest.config);
  manifest.attempts = manifest.plan.map((entry, i) => {
    const result = { ...manifest.attempts[i].result, scenarioId: 'bootstrap' as const };
    result.metadata.serverStorage = serverStorageFixture(result.stackId);
    result.metadata.profile = resultProfile(result, { ...manifest, network: manifest.config.network });
    return { ...entry, result, resultFile: `${result.resultId}.json` };
  });
  const report = renderCampaignDetails(manifest);
  expect(report).toContain('## Initial startup: 500,000 tasks');
  expect(report).toContain('## Initial startup: 1,000,000 tasks');
  expect(report).not.toContain('100,000-task startup');
  expect(report.match(/^## Initial startup:/gm)).toHaveLength(2);
});

test('publication requires physical observations and their declared preparation policy',()=>{
  let manifest=fixture();delete manifest.serverStoragePolicy;
  expect(()=>validateManifest(manifest)).toThrow('preparation policy');
  manifest=fixture();delete manifest.attempts[0].result.metadata.serverStorage;
  expect(()=>validateManifest(manifest)).toThrow('policy missing');
  manifest=fixture();(manifest.attempts[0].result.metadata.serverStorage as any).before.containers=[];
  expect(()=>validateManifest(manifest)).toThrow('inventory missing');
});

test('publication binds the storage exclusion window to the actual trial timestamps',()=>{
  const manifest=fixture();manifest.attempts[0].result.startedAt='2026-09-05T00:00:00Z';
  expect(()=>validateManifest(manifest)).toThrow('trial window differs');
});


test('the opening leads with the selected finding and charts require bound local evidence', () => {
  const manifest = fixture(); selectFindings(manifest);
  const first = manifest.annotations[0] as Annotation;
  first.chart = { path: 'results/figures/finding.svg', alt: 'Five trials [including failures]', caption: 'Synthetic chart fixture, never a benchmark observation.' };
  expect(() => validateAnnotations(manifest)).toThrow('chart needs');
  first.evidence.push({ path: first.chart.path, description: 'Synthetic figure', kind: 'trace' });
  const report = renderCampaign(manifest);
  expect(report.indexOf(first.observation)).toBeLessThan(report.indexOf('Campaign `'));
  expect(report.indexOf('Campaign `')).toBeLessThan(report.indexOf('## Coverage'));
  expect(report).toContain('![Five trials \\[including failures\\]](results/figures/finding.svg)');
  expect(report).toContain(first.chart.caption);
  const firstFinding = report.split('## Findings')[1]!.split('### ')[1]!;
  expect(firstFinding).not.toContain('| Stack / client path |');
  first.chart.path = '../outside.svg'; first.evidence.at(-1)!.path = first.chart.path;
  expect(() => validateAnnotations(manifest)).toThrow('chart needs');
});
