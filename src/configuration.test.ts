import { expect, test } from 'bun:test';
import { mkdtemp, writeFile, rm, chmod, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { configurationHash, configurationIdentity, containerConfiguration, environmentSummary, mountedInput, runtimeEnvironment, validateConfigurationIdentity, validateConfigurationRecord, type ConfigurationRecord } from './configuration.ts';
import { resultProfile } from './profiles.ts';
import type { BenchmarkResult } from './types.ts';

const container = () => ({ Name: '/test', Image: 'sha256:test-image', Config: { Env: ['PASSWORD=private-credential', 'URL=https://user:pass@example.test'], Cmd: ['server', '--token=command-credential'], Entrypoint: ['/entrypoint', 'entry-credential'] }, HostConfig: { NanoCpus: 0, Memory: 0 }, State: { Running: true, StartedAt: 'first' } });
const source = { sourceHash: configurationHash('source'), files: { 'compose.yaml': { sha256: configurationHash('compose') } } };
function record(): ConfigurationRecord {
  const body = { version: 1 as const, sourceHash: source.sourceHash, runtime: { environment: runtimeEnvironment({}), dotenv: {}, dockerContextEndpointSha256: configurationHash('endpoint') }, services: { syncular: { composeFile: 'compose.yaml', composeSha256: source.files['compose.yaml'].sha256, resolvedComposeSha256: configurationHash('resolved'), containers: [containerConfiguration(container())] } } };
  return { ...body, fingerprint: configurationHash(body) };
}
function encode(value: ConfigurationRecord) { const bytes = Buffer.from(JSON.stringify(value)); return { bytes, identity: configurationIdentity(value, bytes) }; }

test('configuration fingerprints preserve redacted values, unset overrides and generated-ID exclusions', () => {
  const env = { BENCH_QUEUE: '100,500', NODE_ENV: 'production', SYNCULAR_URL: 'https://user:password@example.test', SYNCULAR_TOKEN: '123', BENCH_RECOVERY_PARENT_PID: '1234' };
  const summary = runtimeEnvironment(env), readable = JSON.stringify(summary);
  expect(readable).not.toContain(env.SYNCULAR_URL);
  expect((summary.values as any).SYNCULAR_TOKEN).toEqual({ present: true, redacted: true });
  expect((summary.values as any).BENCH_QUEUE.value).toBe('100,500');
  expect(runtimeEnvironment({ ...env, BENCH_RECOVERY_PARENT_PID: '5678', BENCH_EXPECTED_RUST_SHA256: 'different' })).toEqual(summary);
  expect(runtimeEnvironment({ ...env, SYNCULAR_URL: 'https://different.test' }).sha256).not.toBe(summary.sha256);
  expect(runtimeEnvironment({ ...env, NODE_OPTIONS: '--max-old-space-size=512' }).sha256).not.toBe(summary.sha256);
  expect(environmentSummary({ A: undefined }).sha256).not.toBe(environmentSummary({ A: '' }).sha256);
  expect(configurationHash({ a: 1, b: 2 })).toBe(configurationHash({ b: 2, a: 1 }));
});

test('container configuration detects changes with the same image and excludes process state', () => {
  const original = container(), baseline = containerConfiguration(original), readable = JSON.stringify(baseline);
  for (const secret of ['private-credential', 'https://user:pass@example.test', 'command-credential', 'entry-credential']) expect(readable).not.toContain(secret);
  expect(containerConfiguration({ ...original, State: { Running: false, StartedAt: 'later' } })).toEqual(baseline);
  for (const changed of [
    { ...original, HostConfig: { ...original.HostConfig, NanoCpus: 1e9 } },
    { ...original, Config: { ...original.Config, Cmd: ['server', '--new-flag'] } },
    { ...original, Config: { ...original.Config, Env: ['PASSWORD=changed'] } },
  ]) expect(configurationHash(containerConfiguration(changed))).not.toBe(configurationHash(baseline));
  const volume = [{ type: 'volume', name: 'database', input: { scope: 'mutable contents excluded' } }];
  expect(containerConfiguration({ ...original, SizeRw: 500 }, volume)).toEqual(containerConfiguration({ ...original, SizeRw: 2000 }, volume));
});

test('mounted configuration includes bytes and modes without publishing contents and rejects untracked link targets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'configuration-input-'));
  try {
    const path = join(dir, 'settings'); await writeFile(path, 'password=private-value');
    const baseline = mountedInput(dir); expect(JSON.stringify(baseline)).not.toContain('private-value');
    await writeFile(path, 'password=changed-value'); expect(mountedInput(dir).sha256).not.toBe(baseline.sha256);
    await writeFile(path, 'password=private-value'); expect(mountedInput(dir)).toEqual(baseline);
    await chmod(path, 0o600); expect(mountedInput(dir).sha256).not.toBe(baseline.sha256);
    await symlink(path, join(dir, 'link')); expect(() => mountedInput(dir)).toThrow('symlink');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('publication requires source-bound configuration, verified artifact bytes and service coverage', () => {
  const original = record(), { bytes, identity } = encode(original);
  expect(() => validateConfigurationRecord(bytes, identity, source, ['syncular'])).not.toThrow();
  expect(() => validateConfigurationIdentity(undefined, source, ['syncular'])).toThrow('missing');
  expect(() => validateConfigurationIdentity(identity, { ...source, sourceHash: configurationHash('different') }, ['syncular'])).toThrow('provenance');
  expect(() => validateConfigurationIdentity(identity, source, ['zero'])).toThrow('provenance');
  expect(() => validateConfigurationRecord(Buffer.from('{}'), identity, source, ['syncular'])).toThrow('artifact hash');
  const changed = structuredClone(original); changed.services.syncular.resolvedComposeSha256 = configurationHash('changed');
  const tampered = encode(changed); expect(() => validateConfigurationRecord(tampered.bytes, tampered.identity, source, ['syncular'])).toThrow('fingerprint');
  const incomplete = record(); delete incomplete.services.syncular.composeSha256; incomplete.services.syncular.composeFile = 'missing.yaml';
  const { fingerprint: _, ...body } = incomplete; incomplete.fingerprint = configurationHash(body);
  const missing = encode(incomplete); expect(() => validateConfigurationRecord(missing.bytes, missing.identity, source, ['syncular'])).toThrow('service evidence');
  const campaign = { source, machine: {}, images: {}, network: {}, configuration: identity };
  const result = { stackId: 'syncular', scenarioId: 'local-query', metrics: {}, metadata: {} } as BenchmarkResult;
  expect(resultProfile(result, campaign).comparisonKey).not.toBe(resultProfile(result, { ...campaign, configuration: { ...identity, fingerprint: configurationHash('different') } }).comparisonKey);
});

test('resolved mount enumeration is unordered while mount contents and declared argument order remain significant', () => {
  const mounts: Array<{ destination: string; source: string; type: string; readWrite: boolean; input: Record<string, string> }> = [{ destination: '/data', source: '/volume', type: 'volume', readWrite: true, input: { scope: 'mutable' } },
    { destination: '/init', source: '/fixture', type: 'bind', readWrite: false, input: { sha256: 'first' } }];
  const before = structuredClone(mounts), identity = configurationHash(containerConfiguration(container(), mounts));
  expect(configurationHash(containerConfiguration(container(), [...mounts].reverse()))).toBe(identity);
  expect(mounts).toEqual(before);
  for (const mutate of [
    (m: typeof mounts) => { m[0].readWrite = false; },
    (m: typeof mounts) => { m[1].input.sha256 = 'changed'; },
    (m: typeof mounts) => { m[0].destination = '/different'; },
    (m: typeof mounts) => { m[1].source = '/different'; },
  ]) { const changed = structuredClone(mounts); mutate(changed); expect(configurationHash(containerConfiguration(container(), changed))).not.toBe(identity); }
  const changedCommand = container(); changedCommand.Config.Cmd.reverse();
  expect(configurationHash(containerConfiguration(changedCommand, mounts))).not.toBe(identity);
});
