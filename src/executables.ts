import { captureCargoConfiguration, assertCargoConfiguration, validateCargoConfiguration, type CargoConfiguration } from './cargo-configuration.ts';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { sourceIdentity } from './provenance.ts';
import { benchmarkRoot, rustDriverSourceRoot } from './paths.ts';
import { sha256 } from './source-snapshot.ts';
import type { BenchmarkResult, JsonObject, StackId } from './types.ts';
import { prepareRustBuild, assertPreparedRustBuildUnchanged, validateRustBuildIdentity, rustBuildCommand, type RustBuildIdentity } from './rust-build.ts';

export interface ExecutableIdentity { path: string; sha256: string; bytes: number; mode: number }
export const rustRoot = join(benchmarkRoot, 'drivers/syncular-rust');
const command = (program: string, args: string[], env = process.env) => execFileSync(program, args, { cwd: rustRoot, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
export function executableIdentity(path: string): ExecutableIdentity {
  const absolute = realpathSync(resolve(path)), info = statSync(absolute);
  if (!info.isFile() || !(info.mode & 0o111)) throw new Error(`Not an executable file: ${absolute}`);
  return { path: absolute, sha256: sha256(readFileSync(absolute)), bytes: info.size, mode: info.mode & 0o777 };
}
export function assertExecutable(expected: ExecutableIdentity): void {
  if (JSON.stringify(executableIdentity(expected.path)) !== JSON.stringify(expected)) throw new Error('Benchmark executable changed during campaign');
}
export function assertRustExecutable(path: string, full = false): void {
  const expectedStat = process.env.BENCH_EXPECTED_RUST_STAT;
  if (!full && expectedStat) {
    if (JSON.stringify(executableStat(path)) !== expectedStat) throw new Error('Rust executable file changed before launch');
    return;
  }
  const expected = process.env.BENCH_EXPECTED_RUST_SHA256;
  if (expected && executableIdentity(path).sha256 !== expected) throw new Error('Rust executable differs from campaign checksum');
}
function executableStat(path: string) {
  const info = statSync(path);
  return { path: realpathSync(path), bytes: info.size, mode: info.mode & 0o777, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs };
}
export function cargoExecutable(output: string): string {
  const paths = new Set<string>();
  for (const line of output.split('\n')) {
    let item; try { item = JSON.parse(line); } catch { continue; }
    if (item.reason === 'compiler-artifact' && item.target?.name === 'syncular-bench' && item.target?.kind?.includes('bin') && typeof item.executable === 'string') paths.add(item.executable);
  }
  if (paths.size !== 1) throw new Error('Cargo did not identify exactly one syncular-bench executable');
  return [...paths][0];
}
export function prepareExecutables(stackIds: StackId[], artifactDirectory?: string): JsonObject {
  if (!stackIds.includes('syncular-rust')) return {};
  const custom = process.env.SYNCULAR_RUST_BENCH_BIN;
  if (custom) return { rustDriver: { origin: 'custom', executable: { ...executableIdentity(custom) }, build: null } };
  if (!artifactDirectory) throw new Error('Source-built Rust campaigns require an artifact directory');
  const cargoProxy = Bun.which('cargo'), rustc = Bun.which(process.env.RUSTC || 'rustc');
  if (!cargoProxy || !rustc) throw new Error('Rust campaign requires cargo and rustc');
  const rustup = join(dirname(cargoProxy), 'rustup');
  // Rustup proxies can be symlinks, hard links or copies of the same binary.
  const cargo = realpathSync(existsSync(rustup) && sha256(readFileSync(cargoProxy)) === sha256(readFileSync(rustup)) ? command(rustup, ['which', 'cargo']) : cargoProxy);
  // Resolve rustup's selected compiler and pass that concrete compiler to Cargo.
  // Empty wrapper values override Cargo wrapper configuration for this recipe.
  const compiler = join(command(rustc, ['--print', 'sysroot']), 'bin', 'rustc');
  const compilerBefore = executableIdentity(compiler), compilerVersion = command(compiler, ['--version', '--verbose']);
  const cargoBefore = executableIdentity(cargo), cargoVersion = command(cargo, ['--version', '--verbose']);
  const { record, identity } = prepareRustBuild(artifactDirectory, cargo, compiler, rustRoot);
  assertExecutable(compilerBefore); assertExecutable(cargoBefore);
  return { rustDriver: { origin: 'source-build', executable: { ...record.executable }, build: {
    sourceHash: record.sourceHash, command: record.command, compiler: { ...compilerBefore, version: compilerVersion }, cargo: { ...cargoBefore, version: cargoVersion },
    environment: record.environment, configuration: record.configuration as unknown as JsonObject, inputs: identity as unknown as JsonObject,
    cargoTomlSha256: record.cargoSources.cargoTomlSha256, cargoLockSha256: record.cargoSources.cargoLockSha256,
    configurationScope: 'Fresh host-target build with explicit compiler/native tools/SDK, locked offline dependency graph, source/tool/library inventories and complete artifact receipts. OS runtime is identified by macOS build; no bit-for-bit reproducibility claim.',
  } } };
}
export function assertExecutablesUnchanged(executables: JsonObject): void {
  const driver = executables.rustDriver as JsonObject | undefined;
  if (driver) {
    assertExecutable(driver.executable as unknown as ExecutableIdentity);
    const build = driver.build as JsonObject | null;
    if (build?.inputs) assertPreparedRustBuildUnchanged(build.inputs as unknown as RustBuildIdentity);
    else if (build) assertCargoConfiguration(build.configuration as unknown as CargoConfiguration, { ...process.env, ...build.environment as Record<string, string> });
    if (build) for (const key of ['compiler', 'cargo']) {
      const { path, sha256, bytes, mode } = build[key] as unknown as ExecutableIdentity;
      assertExecutable({ path, sha256, bytes, mode });
    }
  }
}
export function executableEnvironment(executables: JsonObject): Record<string, string> {
  const driver = executables.rustDriver as JsonObject | undefined;
  const binary = driver?.executable as unknown as ExecutableIdentity | undefined;
  return { BENCH_EXPECTED_RUST_SHA256: binary?.sha256 ?? '', BENCH_EXPECTED_RUST_STAT: binary ? JSON.stringify(executableStat(binary.path)) : '', ...(binary ? { SYNCULAR_RUST_BENCH_BIN: binary.path } : {}) };
}
export function validateExecutableProvenance(executables: JsonObject | undefined, stacks: StackId[], publication = false, source?: JsonObject): void {
  if (!stacks.includes('syncular-rust')) return;
  const driver = executables?.rustDriver as JsonObject | undefined;
  const binary = driver?.executable as unknown as ExecutableIdentity | undefined;
  const valid = (entry: any) => typeof entry?.path === 'string' && entry.path.startsWith('/') && /^[a-f0-9]{64}$/.test(entry.sha256) && Number.isSafeInteger(entry.bytes) && entry.bytes > 0 && Number.isSafeInteger(entry.mode) && entry.mode >= 0 && entry.mode <= 0o777 && (entry.mode & 0o111) !== 0;
  if (!valid(binary) || !['source-build', 'custom'].includes(String(driver?.origin))) throw new Error('Rust executable provenance missing or invalid');
  if (driver!.origin === 'custom') {
    if (driver!.build !== null) throw new Error('Custom Rust executable must not claim a known compiler');
    if (publication) throw new Error('Custom Rust executable lacks verified build provenance for publication');
    return;
  }
  const build = driver!.build as JsonObject;
  if (!build || !valid(build.compiler) || !valid(build.cargo) || typeof (build.compiler as JsonObject).version !== 'string' || typeof (build.cargo as JsonObject).version !== 'string' || !Array.isArray(build.command) || !/^[a-f0-9]{64}$/.test(String(build.cargoLockSha256)) || !/^[a-f0-9]{64}$/.test(String(build.cargoTomlSha256))) throw new Error('Rust build provenance missing or invalid');
  if (build.inputs) {
    const inputs = build.inputs as unknown as RustBuildIdentity;
    validateRustBuildIdentity(inputs, build.sourceHash, binary!.sha256);
    if (JSON.stringify(build.command) !== JSON.stringify(rustBuildCommand(String((build.cargo as JsonObject).path), inputs.target, inputs.targetDirectory))) throw new Error('Rust clean-build command differs from captured input recipe');
  } else {
    if (publication) throw new Error('Rust publication requires fresh-build dependency and native input provenance');
    if (JSON.stringify(build.command.slice(1)) !== JSON.stringify(['build', '--release', '--locked', '--message-format=json'])) throw new Error('Legacy Rust build command differs');
  }
  validateCargoConfiguration(build.configuration as unknown as CargoConfiguration);
  const environment = build.environment as JsonObject;
  if (build.command[0] !== (build.cargo as JsonObject).path || environment?.RUSTC !== (build.compiler as JsonObject).path || environment.RUSTC_WRAPPER !== '' || environment.RUSTC_WORKSPACE_WRAPPER !== '' || !(build.compiler as JsonObject).version || !(build.cargo as JsonObject).version) throw new Error('Rust compiler recipe differs from recorded toolchain');
  if (source) {
    if (build.sourceHash !== source.sourceHash) throw new Error('Rust build differs from archived benchmark source');
    const files = source.files as JsonObject;
    const driverRoot = rustDriverSourceRoot(files);
    if (build.cargoTomlSha256 !== (files?.[`${driverRoot}/Cargo.toml`] as JsonObject)?.sha256 || build.cargoLockSha256 !== (files?.[`${driverRoot}/Cargo.lock`] as JsonObject)?.sha256) throw new Error('Rust build inputs differ from archived source');
  } else if (publication) throw new Error('Rust build requires archived source provenance');
}

export function validateTrialExecutable(result: Pick<BenchmarkResult, 'stackId' | 'status' | 'metadata'>, executables?: JsonObject): void {
  if (result.stackId !== 'syncular-rust' || result.status !== 'completed') return;
  const expected = (executables?.rustDriver as JsonObject)?.executable;
  if (!expected || JSON.stringify(result.metadata.executable) !== JSON.stringify(expected)) throw new Error('Trial Rust executable differs from campaign provenance');
}
