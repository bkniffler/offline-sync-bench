import { expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertDependenciesUnchanged, captureDependencies, readCampaignDependencies, validateDependencyIdentity, validateDependencyInventory, writeDependencies } from './dependencies.ts';
import { sha256 } from './source-snapshot.ts';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'bench-dependencies-'));
  await mkdir(join(root, 'node_modules/pkg'), { recursive: true }); await mkdir(join(root, 'campaign'));
  const manifest = JSON.stringify({ dependencies: { pkg: '1.0.0' } });
  await writeFile(join(root, 'package.json'), manifest);
  await writeFile(join(root, 'node_modules/pkg/package.json'), JSON.stringify({ name: 'pkg', version: '1.0.0' }));
  await writeFile(join(root, 'node_modules/pkg/addon.node'), new Uint8Array([0, 255, 1, 254]));
  await symlink('pkg/addon.node', join(root, 'node_modules/native-link'));
  await symlink('pkg/missing-cli', join(root, 'node_modules/missing-link'));
  const source = { files: { 'package.json': { sha256: sha256(manifest) } } };
  return { root, source };
}
test('installed package identity includes native bytes, modes, symlinks and missing targets', async () => {
  const { root, source } = await fixture();
  try {
    const identity = await writeDependencies(root, join(root, 'campaign'), ['package.json']);
    const bytes = await readCampaignDependencies(join(root, 'campaign'), identity, source);
    const inventory = JSON.parse(bytes.toString());
    expect(inventory.entries['node_modules/native-link'].resolvedTarget).toBe('node_modules/pkg/addon.node');
    expect(inventory.entries['node_modules/missing-link'].resolvedTarget).toBeNull();
    expect(inventory.packages.pkg.version).toBe('1.0.0');
    expect(() => assertDependenciesUnchanged(root, identity, ['package.json'])).not.toThrow();
    // Keep the package version and file size unchanged while changing loaded code.
    await writeFile(join(root, 'node_modules/pkg/addon.node'), new Uint8Array([0, 254, 1, 255]));
    expect(() => assertDependenciesUnchanged(root, identity, ['package.json'])).toThrow('changed');
    await writeFile(join(root, 'node_modules/pkg/addon.node'), new Uint8Array([0, 255, 1, 254]));
    await chmod(join(root, 'node_modules/pkg/addon.node'), 0o755);
    expect(() => assertDependenciesUnchanged(root, identity, ['package.json'])).toThrow('changed');
    const restored = captureDependencies(root);
    await writeFile(join(root, 'node_modules/pkg/missing-cli'), 'newly resolved');
    expect(captureDependencies(root).fingerprint).not.toBe(restored.fingerprint);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('dependency evidence rejects mismatched pins, missing provenance, corrupt artifacts and uncaptured links', async () => {
  const { root, source } = await fixture();
  try {
    const identity = await writeDependencies(root, join(root, 'campaign'), ['package.json']);
    const bytes = await readFile(join(root, 'campaign/DEPENDENCIES.json'));
    expect(() => validateDependencyIdentity(undefined, source)).toThrow('provenance');
    expect(() => validateDependencyIdentity(identity, { files: {} })).toThrow('archived package');
    expect(() => validateDependencyInventory(Buffer.from('corrupt'), identity, source)).toThrow('artifact hash');
    const corrupted = JSON.parse(bytes.toString()); corrupted.entries['node_modules/pkg/addon.node'].sha256 = 'a'.repeat(64);
    const altered = Buffer.from(JSON.stringify(corrupted));
    expect(() => validateDependencyInventory(altered, { ...identity, sha256: sha256(altered) }, source)).toThrow('fingerprint');
    await writeFile(join(root, 'node_modules/pkg/package.json'), JSON.stringify({ name: 'pkg', version: '2.0.0' }));
    expect(() => captureDependencies(root)).toThrow('exact manifest pin');
    await symlink('../package.json', join(root, 'node_modules/external'));
    expect(() => captureDependencies(root)).toThrow('leaves the captured installation');
  } finally { await rm(root, { recursive: true, force: true }); }
});
