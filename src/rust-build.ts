import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { captureCargoSources, validateCargoSources, assertCargoSourcesUnchanged, type CargoSources } from './cargo-sources.ts';
import { captureNativeBuildInputs, validateNativeBuildInputs, assertNativeBuildInputsUnchanged, type NativeBuildInputs } from './native-build-inputs.ts';
import { captureCargoConfiguration, assertCargoConfiguration, validateCargoConfiguration, type CargoConfiguration } from './cargo-configuration.ts';
import { configurationHash, environmentSummary } from './configuration.ts';
import { sourceIdentity } from './provenance.ts';
import { sha256 } from './source-snapshot.ts';
import { tempRoot } from './paths.ts';
import { resolvedBuildInputPath } from './build-inputs.ts';
import type { ExecutableIdentity } from './executables.ts';
import type { JsonObject } from './types.ts';

export interface RustBuildIdentity {
  version: 1; method: 'clean-native-rust-build-v1'; path: string; sha256: string; fingerprint: string;
  sourceHash: string; target: string; targetDirectory: string; cargoSourcesFingerprint: string; nativeInputsFingerprint: string; executableSha256: string;
}
export interface RustBuildRecord {
  version: 1; method: 'clean-native-rust-build-v1'; sourceHash: string; workingDirectory: string;
  targetDirectory: string; emptyBeforeBuild: true; environment: Record<string, string>; configuration: CargoConfiguration;
  cargoSources: CargoSources; nativeInputs: NativeBuildInputs; command: string[]; dependencyTree: { command: string[]; stdout: string };
  startedAt: string; finishedAt: string; durationMs: number; messages: any[]; stderr: string;
  executable: ExecutableIdentity; fingerprint: string;
}
const method = 'clean-native-rust-build-v1' as const;
const inside = (root: string, path: string) => { const name = relative(root, path); return name === '' || name !== '..' && !name.startsWith('../') && !isAbsolute(name); };
const safePath = (path: string) => typeof path === 'string' && !!path && !isAbsolute(path) && path.split('/').every(part => part && part !== '.' && part !== '..');
const validHash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const preparedBuilds = new Map<string, { path: string; record: RustBuildRecord }>();

/** An explicit build environment. Runtime credentials, compiler wrappers and
 * ambient flag/library-search overrides do not enter this recipe. Cargo files
 * still apply; [env] configuration is rejected rather than silently overriding
 * the recorded native tool paths. The user's shell environment is unchanged. */
export function rustBuildEnvironment(native: NativeBuildInputs, base: NodeJS.ProcessEnv): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const key of ['HOME', 'CARGO_HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TZ', 'DEVELOPER_DIR']) if (base[key] !== undefined) environment[key] = base[key]!;
  Object.assign(environment, { PATH: `${join(native.roots.appleToolchain, 'bin')}:${native.roots.rustBin}:/usr/bin:/bin:/usr/sbin:/sbin`,
    RUSTC: native.tools.rustc.path, RUSTC_WRAPPER: '', RUSTC_WORKSPACE_WRAPPER: '', RUSTFLAGS: '', CARGO_ENCODED_RUSTFLAGS: `-Clinker=${native.tools.clang.path}`,
    CARGO_INCREMENTAL: '0', SDKROOT: native.sdk.path, LIBSQLITE3_SYS_USE_PKG_CONFIG: '0', ZERO_AR_DATE: '1', SOURCE_DATE_EPOCH: '0' });
  const variables = { CC: native.tools.clang.path, CXX: native.tools.clangxx.path, AR: native.tools.ar.path, RANLIB: native.tools.ranlib.path,
    CFLAGS: '', CXXFLAGS: '', CPPFLAGS: '', LDFLAGS: '', ARFLAGS: '', RANLIBFLAGS: '' };
  for (const [name, value] of Object.entries(variables)) for (const key of [name, `HOST_${name}`, `TARGET_${name}`, `${name}_${native.target}`, `${name}_${native.target.replaceAll('-', '_')}`]) environment[key] = value;
  environment[`CARGO_TARGET_${native.target.toUpperCase().replaceAll('-', '_')}_LINKER`] = native.tools.clang.path;
  return environment;
}
export function rustBuildCommand(cargo: string, target: string, directory: string): string[] {
  return [cargo, 'build', '--release', '--locked', '--offline', '--target', target, '--target-dir', directory, '--message-format=json'];
}
export function rustDependencyTreeCommand(cargo: string, target: string): string[] {
  return [cargo, 'tree', '--locked', '--offline', '--target', target, '--edges', 'normal,build', '--prefix', 'none', '--format', '{p}|{f}', '--color', 'never'];
}
/** Metadata is a source-inventory superset, not a compilation plan. Cargo tree
 * resolves build-oriented features but also does not promise exact build-unit
 * equivalence. Require agreement with actual receipts for this supported recipe;
 * retain both representations and fail closed if they disagree. */
export function rustDependencyTreePackages(stdout: string, sources: CargoSources): Map<string, Set<string>> {
  const selected = new Map<string, Set<string>>();
  for (const line of stdout.trim().split('\n')) {
    const match = line.replace(/ \(\*\)$/, '').match(/^([^ ]+) v([^ |]+)(?: \([^\n]*\))?\|([^|]*)$/);
    if (!match) throw new Error('Unrecognized Cargo dependency-tree entry');
    const candidates = sources.metadata.packages.filter((pkg: any) => pkg.name === match[1] && pkg.version === match[2]);
    if (candidates.length !== 1) throw new Error('Cargo dependency-tree package is missing or ambiguous');
    const id = candidates[0].id, node = sources.metadata.resolve.nodes.find((node: any) => node.id === id);
    const features = selected.get(id) ?? new Set<string>();
    for (const feature of match[3].split(',').filter(Boolean)) {
      if (!node?.features.includes(feature)) throw new Error('Cargo dependency-tree feature is absent from metadata');
      features.add(feature);
    }
    selected.set(id, features);
  }
  if (!selected.has(sources.metadata.resolve.root)) throw new Error('Cargo dependency tree omits the driver');
  return selected;
}
export function validateRustArtifacts(messages: any[], sources: CargoSources, directory: string, dependencyTree: string): string {
  if (!Array.isArray(messages) || messages.filter(m => m.reason === 'build-finished').length !== 1 || messages.at(-1)?.reason !== 'build-finished' || messages.at(-1).success !== true) throw new Error('Rust build did not finish successfully');
  const packages = new Map<string, any>(sources.metadata.packages.map((pkg: any) => [pkg.id, pkg]));
  const selected = rustDependencyTreePackages(dependencyTree, sources);
  const seen = new Set<string>(), executables = new Set<string>();
  const actualFeatures = new Map<string, Set<string>>();
  for (const item of messages) {
    if (item.reason === 'compiler-artifact') {
      if (!selected.has(item.package_id) || item.fresh !== false || !Array.isArray(item.filenames) || !item.filenames.length || item.filenames.some((path: string) => !isAbsolute(path) || !inside(directory, path)) || !Array.isArray(item.features)) throw new Error('Rust artifact is cached, external or absent from the declared build tree');
      seen.add(item.package_id);
      const features = actualFeatures.get(item.package_id) ?? new Set<string>(); for (const feature of item.features) features.add(feature); actualFeatures.set(item.package_id, features);
      if (item.package_id === sources.metadata.resolve.root && item.target?.name === 'syncular-bench' && item.target.kind?.includes('bin')) {
        if (typeof item.executable !== 'string' || !inside(directory, item.executable)) throw new Error('Rust driver artifact missing from fresh target directory');
        executables.add(item.executable);
      }
    } else if (item.reason === 'build-script-executed') {
      if (!packages.has(item.package_id) || !isAbsolute(item.out_dir ?? '') || !inside(directory, item.out_dir)) throw new Error('Rust build-script output leaves the fresh build');
      for (const path of item.linked_paths ?? []) {
        const value = String(path).replace(/^(?:native|framework|dependency|crate|all)=/, '');
        if (!isAbsolute(value) || !inside(directory, value)) throw new Error('Rust build script adds an external native library search path');
      }
    }
  }
  if (executables.size !== 1 || seen.size !== selected.size) throw new Error('Rust artifacts do not cover the complete declared build tree');
  for (const [id, features] of selected) if (JSON.stringify([...actualFeatures.get(id)!].sort()) !== JSON.stringify([...features].sort())) throw new Error('Rust artifact features differ from the build tree');
  return [...executables][0];
}
export function prepareRustBuild(directory: string, cargo: string, compiler: string, workingDirectory: string) {
  mkdirSync(directory, { recursive: true }); mkdirSync(tempRoot, { recursive: true });
  const sourceHash = String(sourceIdentity().sourceHash);
  const nativeInputs = captureNativeBuildInputs(cargo, compiler);
  const environment = rustBuildEnvironment(nativeInputs, process.env);
  const configuration = captureCargoConfiguration(workingDirectory, environment);
  if (Object.keys(configuration.mergedFileSettings.values as JsonObject).some(key => key === 'env' || key.startsWith('env.'))) throw new Error('Verified Rust build does not support Cargo [env] overrides; their effective native inputs need a separate recipe');
  const cargoSources = captureCargoSources(cargo, workingDirectory, nativeInputs.target, environment);
  const treeCommand = rustDependencyTreeCommand(cargo, nativeInputs.target);
  const dependencyTree = { command: treeCommand, stdout: execFileSync(cargo, treeCommand.slice(1), { cwd: workingDirectory, env: environment, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }) };
  rustDependencyTreePackages(dependencyTree.stdout, cargoSources);
  const targetDirectory = realpathSync(mkdtempSync(join(tempRoot, 'rust-build-')));
  if (readdirSync(targetDirectory).length) throw new Error('Rust build output directory is not fresh');
  const command = rustBuildCommand(cargo, nativeInputs.target, targetDirectory), startedAt = new Date().toISOString(), started = performance.now();
  const prepared = { version: 1 as const, method, sourceHash, workingDirectory, targetDirectory, emptyBeforeBuild: true as const, environment, configuration, cargoSources, nativeInputs, command, dependencyTree, startedAt };
  writeFileSync(join(directory, 'RUST-BUILD-PREPARED.json'), JSON.stringify(prepared, null, 2) + '\n');
  console.log(`rust-build-target=${targetDirectory}`);
  let stdout = '', stderr = '';
  try {
    // Use spawnSync to retain both message receipts and compiler diagnostics.
    const result = Bun.spawnSync(command, { cwd: workingDirectory, env: environment, stdout: 'pipe', stderr: 'pipe' });
    stdout = result.stdout.toString(); stderr = result.stderr.toString();
    if (result.exitCode !== 0) throw new Error(`Fresh Rust build exited ${result.exitCode}`);
    const messages = stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    const path = realpathSync(validateRustArtifacts(messages, cargoSources, targetDirectory, dependencyTree.stdout)), stat = statSync(path);
    if (!inside(targetDirectory, path) || !stat.isFile() || !(stat.mode & 0o111)) throw new Error('Built Rust driver is not an owned executable');
    const executable = { path, sha256: sha256(readFileSync(path)), bytes: stat.size, mode: stat.mode & 0o777 };
    assertCargoConfiguration(configuration, environment); assertCargoSourcesUnchanged(cargoSources); assertNativeBuildInputsUnchanged(nativeInputs);
    if (sourceIdentity().sourceHash !== sourceHash) throw new Error('Benchmark source changed during fresh Rust build');
    const body = { ...prepared, finishedAt: new Date().toISOString(), durationMs: performance.now() - started, messages, stderr, executable };
    const record: RustBuildRecord = { ...body, fingerprint: configurationHash(body) };
    validateRustBuildRecord(record);
    const bytes = Buffer.from(JSON.stringify(record, null, 2) + '\n'); writeFileSync(join(directory, 'RUST-BUILD.json'), bytes);
    const identity: RustBuildIdentity = { version: 1, method, path: 'RUST-BUILD.json', sha256: sha256(bytes), fingerprint: record.fingerprint, sourceHash,
      target: nativeInputs.target, targetDirectory, cargoSourcesFingerprint: cargoSources.fingerprint, nativeInputsFingerprint: nativeInputs.fingerprint, executableSha256: executable.sha256 };
    preparedBuilds.set(identity.fingerprint, { path: join(directory, identity.path), record });
    return { record, identity };
  } catch (error) {
    writeFileSync(join(directory, 'RUST-BUILD-FAILED.json'), JSON.stringify({ ...prepared, finishedAt: new Date().toISOString(), durationMs: performance.now() - started, stdout, stderr, error: String(error) }, null, 2) + '\n');
    throw error;
  }
}
export function validateRustBuildIdentity(identity: RustBuildIdentity | undefined, sourceHash: unknown, executableSha256: unknown): void {
  if (!identity || identity.version !== 1 || identity.method !== method || !safePath(identity.path) || ![identity.sha256, identity.fingerprint, identity.cargoSourcesFingerprint, identity.nativeInputsFingerprint].every(validHash)
    || identity.sourceHash !== sourceHash || identity.executableSha256 !== executableSha256 || !identity.target?.endsWith('-apple-darwin') || !isAbsolute(identity.targetDirectory ?? '')) throw new Error('Rust build input identity missing or mismatched');
}
export function validateRustBuildRecord(record: RustBuildRecord): void {
  if (!record || record.version !== 1 || record.method !== method || record.emptyBeforeBuild !== true || !isAbsolute(record.targetDirectory ?? '') || !validHash(record.sourceHash)) throw new Error('Fresh Rust build evidence missing');
  const { fingerprint, ...body } = record;
  if (configurationHash(body) !== fingerprint) throw new Error('Rust build record fingerprint differs');
  validateCargoSources(record.cargoSources); validateNativeBuildInputs(record.nativeInputs);
  validateCargoConfiguration(record.configuration);
  if (record.configuration.workingDirectory !== record.workingDirectory || record.configuration.environment.sha256 !== environmentSummary(record.environment).sha256
    || Object.keys(record.configuration.mergedFileSettings.values as JsonObject).some(key => key === 'env' || key.startsWith('env.'))) throw new Error('Rust configuration does not describe the controlled build environment');
  if (record.cargoSources.target !== record.nativeInputs.target || JSON.stringify(record.command) !== JSON.stringify(rustBuildCommand(record.nativeInputs.tools.cargo.path, record.nativeInputs.target, record.targetDirectory))
    || record.cargoSources.workingDirectory !== record.workingDirectory || record.cargoSources.metadataCommand[0] !== record.nativeInputs.tools.cargo.path
    || configurationHash(record.environment) !== configurationHash(rustBuildEnvironment(record.nativeInputs, record.environment))) throw new Error('Rust build command, target or tool environment differs');
  if (JSON.stringify(record.dependencyTree?.command) !== JSON.stringify(rustDependencyTreeCommand(record.nativeInputs.tools.cargo.path, record.nativeInputs.target))) throw new Error('Rust dependency-tree command differs');
  if (validateRustArtifacts(record.messages, record.cargoSources, record.targetDirectory, record.dependencyTree.stdout) !== record.executable.path) throw new Error('Rust executable is not the artifact emitted by Cargo');
  if (!validHash(record.executable.sha256) || !Number.isSafeInteger(record.executable.bytes) || record.executable.bytes <= 0 || !Number.isSafeInteger(record.executable.mode) || !(record.executable.mode & 0o111)) throw new Error('Rust executable checksum missing');
}
export async function readCampaignRustBuild(directory: string, identity: RustBuildIdentity, source: JsonObject, binding?: { build: JsonObject; executable: JsonObject }) {
  validateRustBuildIdentity(identity, source.sourceHash, identity.executableSha256);
  const bytes = await readFile(join(directory, identity.path));
  if (sha256(bytes) !== identity.sha256) throw new Error('Rust build artifact checksum differs');
  const record = JSON.parse(bytes.toString()) as RustBuildRecord; validateRustBuildRecord(record);
  if (record.fingerprint !== identity.fingerprint || record.sourceHash !== identity.sourceHash || record.executable.sha256 !== identity.executableSha256 || record.targetDirectory !== identity.targetDirectory || record.nativeInputs.target !== identity.target || record.cargoSources.fingerprint !== identity.cargoSourcesFingerprint || record.nativeInputs.fingerprint !== identity.nativeInputsFingerprint) throw new Error('Rust build record differs from campaign identity');
  if (binding) {
    if (configurationHash(binding.executable) !== configurationHash(record.executable)) throw new Error('Manifest Rust executable differs from build artifact');
    for (const key of ['sourceHash', 'command', 'environment', 'configuration'] as const) if (configurationHash(binding.build[key]) !== configurationHash(record[key])) throw new Error(`Manifest Rust ${key} differs from build record`);
    for (const [key, name] of [['compiler', 'rustc'], ['cargo', 'cargo']] as const) {
      const tool = record.nativeInputs.tools[name], path = resolvedBuildInputPath(record.nativeInputs.inputs, tool.path), entry = record.nativeInputs.inputs.entries[path];
      if (entry.kind !== 'file' || configurationHash(binding.build[key]) !== configurationHash({ path, sha256: entry.sha256, bytes: entry.bytes, mode: entry.mode, version: tool.version })) throw new Error('Manifest Rust toolchain differs from inventoried bytes');
    }
  }
  const sourceFiles = source.files as JsonObject;
  for (const [name, expected] of [['Cargo.toml', record.cargoSources.cargoTomlSha256], ['Cargo.lock', record.cargoSources.cargoLockSha256]]) if ((sourceFiles[`syncular-rust-driver/${name}`] as JsonObject)?.sha256 !== expected) throw new Error('Rust build Cargo manifests differ from archived source');
  for (const [path, entry] of Object.entries(record.cargoSources.inputs.entries)) if (inside(join(record.workingDirectory, 'src'), path) && entry.kind === 'file') {
    const name = `syncular-rust-driver/${relative(record.workingDirectory, path)}`;
    if ((sourceFiles[name] as JsonObject)?.sha256 !== entry.sha256) throw new Error('Rust driver source differs from archived benchmark');
  }
  return { bytes, record };
}
export function assertRustBuildInputsUnchanged(record: RustBuildRecord): void {
  assertCargoConfiguration(record.configuration, record.environment);
  assertCargoSourcesUnchanged(record.cargoSources); assertNativeBuildInputsUnchanged(record.nativeInputs);
}
export function assertPreparedRustBuildUnchanged(identity: RustBuildIdentity): void {
  const prepared = preparedBuilds.get(identity.fingerprint);
  if (!prepared || sha256(readFileSync(prepared.path)) !== identity.sha256) throw new Error('Prepared Rust build artifact missing or changed');
  assertRustBuildInputsUnchanged(prepared.record);
}
