import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync, symlinkSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureBrowserInstallation, assertBrowserUnchanged, validateClientRuntime, validateBrowserIdentity, validateTrialBrowser, browserBinding, type BrowserIdentity, type ChromiumRuntime } from './provenance.ts';
import { validateBrowserResult } from './validation.ts';
import { validateCampaign, type CampaignConfig } from '../campaign.ts';
import { resultProfile } from '../profiles.ts';
import { createBrowserAdapter } from './adapter.ts';
import type { BenchmarkResult } from '../types.ts';

const runtime: ChromiumRuntime = { kind: 'chromium', executable: '/tmp/owned-chromium/Chrome', installationRoot: '/tmp/owned-chromium' };
const identity: BrowserIdentity = { version: 1, fingerprint: 'a'.repeat(64), sourceHash: 'b'.repeat(64), dependenciesFingerprint: 'c'.repeat(64), installationFingerprint: 'd'.repeat(64), bundleSha256: 'e'.repeat(64), browserVersion: '151.0.7922.34', path: 'BROWSER.json', sha256: 'f'.repeat(64), bundlePath: 'BROWSER.bundle.js' };
test('runtime selection rejects implicit roots, extra settings and unsupported browser networks', () => {
  expect(() => validateClientRuntime()).not.toThrow();
  expect(() => validateClientRuntime({ kind: 'native-host' })).not.toThrow();
  for (const bad of [null, {}, { kind: 'webkit' }, { kind: 'native-host', executable: 'x' }, { ...runtime, installationRoot: '/' }, { ...runtime, executable: '/elsewhere/Chrome' }, { ...runtime, installationRoot: 'relative' }]) expect(() => validateClientRuntime(bad as any)).toThrow();
  const config: CampaignConfig = { version: 1, purpose: 'smoke', seed: 1, trials: 1, trialTimeoutMs: 60000, stacks: ['electric'], scenarios: ['online-propagation'], stoppingRule: 'One attempt', network: { id: 'local-loopback', injectedLatencyMs: 0, injectedLossPct: 0 }, runtime };
  expect(() => validateCampaign(config)).not.toThrow();
  expect(() => validateCampaign({ ...config, network: { id: 'private-veth-netem-v1', imageId: `sha256:${'a'.repeat(64)}`, oneWayDelayMs: 50, lossPct: 0, packetLimit: 1000, seed: 1 } })).toThrow('Browser packet-network');
});
test('browser inventory catches changed resources, permissions, additions and missing helpers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'browser-inventory-'));
  try {
    const exe = join(dir, 'Chrome'), helper = join(dir, 'Framework/Helper'); mkdirSync(join(dir, 'Framework'));
    writeFileSync(exe, 'browser'); chmodSync(exe, 0o755); writeFileSync(helper, 'native helper');
    symlinkSync('Framework', join(dir, 'Current'));
    const config: ChromiumRuntime = { kind: 'chromium', executable: exe, installationRoot: dir };
    const original = captureBrowserInstallation(config), expected = { ...identity, installationFingerprint: original.fingerprint };
    expect(() => assertBrowserUnchanged(config, expected)).not.toThrow();
    writeFileSync(helper, 'changed helper'); expect(() => assertBrowserUnchanged(config, expected)).toThrow('changed'); writeFileSync(helper, 'native helper');
    chmodSync(exe, 0o700); expect(() => assertBrowserUnchanged(config, expected)).toThrow('changed'); chmodSync(exe, 0o755);
    writeFileSync(join(dir, 'new-resource'), 'extra'); expect(() => assertBrowserUnchanged(config, expected)).toThrow('changed'); rmSync(join(dir, 'new-resource'));
    rmSync(helper); expect(() => assertBrowserUnchanged(config, expected)).toThrow('changed'); writeFileSync(helper, 'native helper');
    expect(() => assertBrowserUnchanged(config, expected)).not.toThrow();
    symlinkSync('/tmp', join(dir, 'external')); expect(() => captureBrowserInstallation(config)).toThrow('leaves');
  } finally { rmSync(dir, { recursive: true }); }
});
function result(): BenchmarkResult {
  const evidence = JSON.parse(readFileSync(new URL('../../results/diagnostics/browser-collaboration-development/electric-verified/RESULT.json', import.meta.url), 'utf8'));
  evidence.binding = browserBinding(identity);
  return { stackId: 'electric', scenarioId: 'online-propagation', status: 'completed', metrics: evidence.result.metrics,
    metadata: { ...evidence.result.metadata, implementation: 'browser-collaboration-v1', clientRuntime: 'chromium', browserBinding: evidence.binding, browserEvidence: evidence } } as BenchmarkResult;
}
test('browser admission binds outer measurements, actual runtime and campaign artifacts', () => {
  const good = result(); expect(() => validateBrowserResult(good)).not.toThrow(); expect(() => validateTrialBrowser(good, runtime, identity)).not.toThrow();
  for (const change of [
    (r: any) => r.metadata.implementation = 'electric-collaboration-v3',
    (r: any) => r.metrics = { ...r.metrics, mirror_visible_p50_ms: 0 },
    (r: any) => r.metadata.samples = [],
    (r: any) => r.metadata.browserBinding = { ...r.metadata.browserBinding, fingerprint: 'wrong' },
    (r: any) => r.stackId = 'zero',
  ]) { const changed = structuredClone(good); change(changed); expect(() => validateBrowserResult(changed)).toThrow(); }
  expect(() => validateTrialBrowser(good)).toThrow('native campaign');
  expect(() => validateTrialBrowser(good, runtime, { ...identity, bundleSha256: '0'.repeat(64) })).toThrow('provenance');
  const wrongVersion = structuredClone(good); (wrongVersion.metadata.browserEvidence as any).clients[0].connection.version.product = 'Chrome/150.0.0.0';
  expect(() => validateTrialBrowser(wrongVersion, runtime, identity)).toThrow('version');
  const source = { sourceHash: identity.sourceHash }, dependencies = { fingerprint: identity.dependenciesFingerprint } as any;
  expect(() => validateBrowserIdentity(identity, runtime, source, dependencies)).not.toThrow();
  expect(() => validateBrowserIdentity(undefined, runtime, source, dependencies)).toThrow('missing');
  expect(() => validateBrowserIdentity(identity, undefined, source, dependencies)).toThrow('Native');
  expect(() => validateBrowserIdentity({ ...identity, sourceHash: 'x' }, runtime, source, dependencies)).toThrow('inconsistent');
});
test('profiles separate native/browser measurements and reject missing browser identity', () => {
  const browser = result(), native = structuredClone(browser); delete native.metadata.clientRuntime;
  const campaign = { source: { sourceHash: identity.sourceHash }, machine: {}, network: {}, images: {}, browser: identity };
  const browserProfile = resultProfile(browser, campaign), nativeProfile = resultProfile(native, campaign);
  expect(browserProfile.eligible).toBe(true); expect(browserProfile.lane).toBe('stable-browser-chromium');
  expect(nativeProfile.lane).toBe('stable-native-host'); expect(nativeProfile.comparisonKey).not.toBe(browserProfile.comparisonKey);
  expect(resultProfile(browser, { ...campaign, browser: undefined }).eligible).toBe(false);
});
test('browser coverage never falls through to a native adapter', async () => {
  for (const stack of ['syncular', 'syncular-rust', 'electric', 'electric-tanstack', 'zero', 'powersync', 'turso', 'jazz-v2'] as const) {
    const adapter = createBrowserAdapter(stack, runtime, identity, '/unused');
    const unsupported = await adapter.runLocalQuery();
    expect(unsupported.metadata.coverage).toMatchObject({ status: 'not-implemented' }); expect(unsupported.metadata.clientRuntime).toBe('chromium');
    if (stack !== 'electric' && stack !== 'zero') expect((await adapter.runOnlinePropagation()).metadata.coverage).toMatchObject({ status: 'not-implemented' });
  }
});
