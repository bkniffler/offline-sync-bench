import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { captureBuildInputs, validateBuildInputs, assertBuildInputsUnchanged, resolvedBuildInputPath, type BuildInputInventory } from './build-inputs.ts';
import { configurationHash } from './configuration.ts';
import { sha256 } from './source-snapshot.ts';

export interface CargoSources {
  version: 1; workingDirectory: string; target: string; metadataCommand: string[];
  cargoTomlSha256: string; cargoLockSha256: string;
  metadata: any; inputs: BuildInputInventory; fingerprint: string;
}
export function validateCargoGraph(metadata: any, workingDirectory: string): void {
  if (metadata?.version !== 1 || metadata.workspace_root !== workingDirectory || !Array.isArray(metadata.packages) || !metadata.packages.length || !Array.isArray(metadata.resolve?.nodes)) throw new Error('Cargo resolved graph missing');
  const packages = new Map<string, any>(metadata.packages.map((pkg: any) => [pkg.id, pkg]));
  const nodes = new Map<string, any>(metadata.resolve.nodes.map((node: any) => [node.id, node]));
  if (packages.size !== metadata.packages.length || nodes.size !== metadata.resolve.nodes.length || packages.size !== nodes.size || !packages.has(metadata.resolve.root)) throw new Error('Cargo package/node identities differ');
  for (const [id, pkg] of packages) {
    const node = nodes.get(id);
    if (!node || typeof pkg.name !== 'string' || !pkg.name || typeof pkg.version !== 'string' || typeof pkg.manifest_path !== 'string' || !pkg.manifest_path.startsWith('/') || pkg.source !== null && typeof pkg.source !== 'string'
      || !Array.isArray(node.features) || !node.features.every((f: any) => typeof f === 'string') || !Array.isArray(node.dependencies) || node.dependencies.some((id: string) => !packages.has(id))) throw new Error('Cargo dependency graph contains an invalid package or edge');
  }
}
/** Resolves the exact locked host-target graph without changing the lockfile.
 * Capture is separate from artifact admission: the build must use this target,
 * start from a clean output directory, and pass the before/after input guard.
 */
export function captureCargoSources(cargo: string, workingDirectory: string, target: string, environment: NodeJS.ProcessEnv): CargoSources {
  const cwd = realpathSync(workingDirectory);
  if (!/^[a-zA-Z0-9_-]+$/.test(target)) throw new Error('Invalid Cargo metadata target');
  const metadataCommand = [cargo, 'metadata', '--locked', '--offline', '--filter-platform', target, '--format-version', '1'];
  const before = { cargoTomlSha256: sha256(readFileSync(join(cwd, 'Cargo.toml'))), cargoLockSha256: sha256(readFileSync(join(cwd, 'Cargo.lock'))) };
  const metadata = JSON.parse(execFileSync(cargo, metadataCommand.slice(1), { cwd, env: environment, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }));
  validateCargoGraph(metadata, cwd);
  const paths = metadata.packages.flatMap((pkg: any) => {
    if (dirname(pkg.manifest_path) !== cwd) return [dirname(pkg.manifest_path)];
    return [join(cwd, 'Cargo.toml'), join(cwd, 'Cargo.lock'), join(cwd, 'src'), ...pkg.targets.map((target: any) => target.src_path)];
  });
  const inputs = captureBuildInputs(paths);
  if (sha256(readFileSync(join(cwd, 'Cargo.toml'))) !== before.cargoTomlSha256 || sha256(readFileSync(join(cwd, 'Cargo.lock'))) !== before.cargoLockSha256) throw new Error('Cargo manifests changed during source capture');
  const body = { version: 1 as const, workingDirectory: cwd, target, metadataCommand, ...before, metadata, inputs };
  return { ...body, fingerprint: configurationHash(body) };
}
export function validateCargoSources(record: CargoSources): void {
  if (!record || record.version !== 1 || !/^[a-zA-Z0-9_-]+$/.test(record.target)) throw new Error('Cargo source provenance missing');
  const { fingerprint, ...body } = record;
  if (configurationHash(body) !== fingerprint || JSON.stringify(record.metadataCommand.slice(1)) !== JSON.stringify(['metadata', '--locked', '--offline', '--filter-platform', record.target, '--format-version', '1'])) throw new Error('Cargo source fingerprint or recipe differs');
  validateCargoGraph(record.metadata, record.workingDirectory); validateBuildInputs(record.inputs);
  for (const pkg of record.metadata.packages) for (const path of [pkg.manifest_path, ...pkg.targets.map((target: any) => target.src_path)]) {
    if (record.inputs.entries[resolvedBuildInputPath(record.inputs, path)]?.kind !== 'file') throw new Error('Cargo manifest or target source missing from inventory');
  }
  for (const [name, expected] of [['Cargo.toml', record.cargoTomlSha256], ['Cargo.lock', record.cargoLockSha256]]) {
    const entry = record.inputs.entries[join(record.workingDirectory, name)];
    if (entry?.kind !== 'file' || entry.sha256 !== expected) throw new Error('Cargo source manifest digest differs');
  }
}
export function assertCargoSourcesUnchanged(record: CargoSources): void {
  validateCargoSources(record); assertBuildInputsUnchanged(record.inputs);
}
