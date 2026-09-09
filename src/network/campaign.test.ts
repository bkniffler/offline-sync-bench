import { expect, test } from 'bun:test';
import { getStack } from '../stacks.ts';
import { applyClientRouting, clientEndpoints, parseClientRouting } from './routing.ts';
import { networkTrialEnvironment, validateNetworkProfile } from './campaign.ts';

const profile = { id: 'private-veth-netem-v1', imageId: `sha256:${'a'.repeat(64)}`, oneWayDelayMs: 50, lossPct: 1, seed: 42, packetLimit: 10000 };
test('packet campaigns reject imaginary or incompletely integrated network profiles', () => {
  expect(() => validateNetworkProfile(profile, ['online-propagation'])).not.toThrow();
  expect(() => validateNetworkProfile({ id: 'wan' }, ['online-propagation'])).toThrow('implemented');
  expect(() => validateNetworkProfile({ id: 'local-loopback', injectedLatencyMs: 0, injectedLossPct: 0, oneWayDelayMs: 50 }, ['online-propagation'])).toThrow('implemented');
  for (const scenario of ['bootstrap', 'offline-replay', 'blob-flow'] as const) expect(() => validateNetworkProfile(profile, [scenario])).toThrow('integration');
  for (const changed of [{ lossPct: '1' }, { lossPct: null }, { imageId: 'alpine:latest' }, { seed: 0 }, { oneWayDelayMs: -5 }]) expect(() => validateNetworkProfile({ ...profile, ...changed }, ['online-propagation'])).toThrow();
});

test('client endpoint remapping preserves administration, protocol and path', () => {
  const stack = getStack('electric');
  const endpoints = Object.fromEntries(Object.entries(clientEndpoints(stack)).map(([key, original], i) => { const url = new URL(original); url.hostname = '127.0.0.1'; url.port = String(40000 + i); return [key, url.href.replace(/\/$/, '')]; }));
  const routing = { version: 1, stackId: stack.id, networkId: '12345678-1234-1234-1234-123456789abc', endpoints };
  const applied = applyClientRouting(stack, JSON.stringify(routing));
  expect(applied.adminBaseUrl).toBe(stack.adminBaseUrl); expect(applied.mutationBaseUrl).not.toBe(stack.adminBaseUrl);
  expect(applied.syncBaseUrl).toBe(endpoints.syncBaseUrl); expect(getStack('electric').syncBaseUrl).toBe('http://localhost:3213');
  for (const changed of [{ ...endpoints, adminBaseUrl: 'http://127.0.0.1:1' }, { ...endpoints, syncBaseUrl: 'http://127.0.0.1:1/wrong-path' }, { ...endpoints, syncBaseUrl: 'ws://127.0.0.1:1' }, { syncBaseUrl: endpoints.syncBaseUrl }]) expect(() => applyClientRouting(stack, JSON.stringify({ ...routing, endpoints: changed }))).toThrow();
  expect(() => parseClientRouting(JSON.stringify({ ...routing, endpoints: { syncBaseUrl: 'http://user:secret@127.0.0.1:1' } }))).toThrow();
  expect(networkTrialEnvironment({ BENCH_CLIENT_ENDPOINTS: 'unexpected-inherited-override', PATH: '/bin' }, '')).toEqual({ BENCH_CLIENT_ENDPOINTS: '', PATH: '/bin' });
});
