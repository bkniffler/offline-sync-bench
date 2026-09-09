/** Narrow recovery rule for Docker's null -> [] serialization of absent DNS overrides.
 * The rest of each HostConfig and of the complete configuration must match exactly.
 * Docker Engine daa0cb7f applies each DNS override only when len(...) > 0:
 * https://github.com/moby/moby/blob/daa0cb7f/daemon/container_operations.go#L60-L74
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { captureConfiguration, configurationHash, type ConfigurationIdentity, type ConfigurationRecord } from '../src/configuration.ts';
import { sha256 } from '../src/source-snapshot.ts';
import type { JsonObject, StackId } from '../src/types.ts';

const names = ['/offline-sync-bench-turso-admin-1', '/offline-sync-bench-turso-turso-1'];
const fields = ['Dns', 'DnsOptions', 'DnsSearch'];
export function verifyEmptyDnsRecovery(observed: ConfigurationRecord, original: ConfigurationRecord, hosts: Record<string, any>) {
  const normalized = structuredClone(observed);
  const changes = [];
  for (const name of names) {
    const current = (normalized.services.turso.containers as any[]).find(c => c.name === name);
    const baseline = (original.services.turso.containers as any[]).find(c => c.name === name);
    assert(current && baseline && hosts[name], 'Missing declared Turso container');
    const raw = hosts[name];
    assert.equal(configurationHash(raw), current.hostConfigurationSha256, 'Docker configuration changed during inspection');
    const restored = structuredClone(raw);
    for (const field of fields) { assert.deepEqual(restored[field], [], `Unexpected ${name} ${field}`); restored[field] = null; }
    const restoredHash = configurationHash(restored);
    assert.equal(restoredHash, baseline.hostConfigurationSha256, 'Other HostConfig fields changed');
    changes.push({ container: name, fields, from: [], to: null, observedHostSha256: current.hostConfigurationSha256, originalHostSha256: restoredHash });
    current.hostConfigurationSha256 = restoredHash;
  }
  const { fingerprint: _, ...body } = normalized;
  assert.equal(configurationHash(body), original.fingerprint, 'Other runtime or service configuration changed');
  return { observedFingerprint: observed.fingerprint, equivalentFingerprint: original.fingerprint, changes };
}

export function assertRecoveryConfiguration(stackIds: StackId[], source: JsonObject, expected: ConfigurationIdentity, environment: NodeJS.ProcessEnv, originalPath: string) {
  const bytes = readFileSync(originalPath);
  assert.equal(sha256(bytes), expected.sha256);
  const original = JSON.parse(bytes.toString()) as ConfigurationRecord;
  assert.equal(original.fingerprint, expected.fingerprint);
  const observed = captureConfiguration(stackIds, source, environment);
  if (observed.fingerprint === expected.fingerprint) return { observed, equivalence: null };
  const containers = JSON.parse(execFileSync('docker', ['inspect', ...names], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  const hosts = Object.fromEntries(containers.map((c: any) => [c.Name, c.HostConfig]));
  return { observed, equivalence: verifyEmptyDnsRecovery(observed, original, hosts) };
}
