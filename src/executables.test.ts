import { cargoConfigurationFixture, rustBuildIdentityFixture } from './test-fixtures/cargo.ts';
import { rustBuildCommand } from './rust-build.ts';
import { expect, test } from 'bun:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertExecutable, assertRustExecutable, cargoExecutable, executableEnvironment, executableIdentity, validateExecutableProvenance, validateTrialExecutable } from './executables.ts';

test('executable guards detect changed bytes and permissions at an unchanged path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bench-executable-'));
  const previous = process.env.BENCH_EXPECTED_RUST_SHA256, previousStat = process.env.BENCH_EXPECTED_RUST_STAT;
  delete process.env.BENCH_EXPECTED_RUST_STAT;
  try {
    const path = join(dir, 'driver'); await writeFile(path, 'first build', { mode: 0o755 });
    const original = executableIdentity(path);
    assertExecutable(original);
    process.env.BENCH_EXPECTED_RUST_SHA256 = original.sha256;
    expect(() => assertRustExecutable(path)).not.toThrow();
    await writeFile(path, 'other build');
    expect(() => assertExecutable(original)).toThrow('changed');
    expect(() => assertRustExecutable(path)).toThrow('checksum');
    await writeFile(path, 'first build'); await chmod(path, 0o644);
    expect(() => assertExecutable(original)).toThrow('Not an executable');
    await chmod(path, 0o755);
    const inventory = { rustDriver: { origin: 'custom', executable: { ...original }, build: null } };
    expect(executableEnvironment(inventory)).toMatchObject({ SYNCULAR_RUST_BENCH_BIN: original.path, BENCH_EXPECTED_RUST_SHA256: original.sha256 });
    expect(() => validateExecutableProvenance(inventory, ['syncular-rust'])).not.toThrow();
    expect(() => validateExecutableProvenance(inventory, ['syncular-rust'], true)).toThrow('lacks verified build');
    process.env.BENCH_EXPECTED_RUST_STAT = executableEnvironment(inventory).BENCH_EXPECTED_RUST_STAT;
    expect(() => assertRustExecutable(path)).not.toThrow();
    await writeFile(path, 'changed after trial started');
    expect(() => assertRustExecutable(path)).toThrow('before launch');
  } finally {
    previousStat === undefined ? delete process.env.BENCH_EXPECTED_RUST_STAT : process.env.BENCH_EXPECTED_RUST_STAT = previousStat;
    previous === undefined ? delete process.env.BENCH_EXPECTED_RUST_SHA256 : process.env.BENCH_EXPECTED_RUST_SHA256 = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
test('Cargo output selects the actual driver executable and rejects missing or ambiguous artifacts', () => {
  const artifact = (path: string) => JSON.stringify({ reason: 'compiler-artifact', target: { name: 'syncular-bench', kind: ['bin'] }, executable: path });
  expect(cargoExecutable(`diagnostics\n${artifact('/target/custom/release/driver')}\n${JSON.stringify({ reason: 'build-finished', success: true })}`)).toBe('/target/custom/release/driver');
  expect(() => cargoExecutable('{}')).toThrow('exactly one');
  expect(() => cargoExecutable(`${artifact('/first')}\n${artifact('/second')}`)).toThrow('exactly one');
});
test('publication requires build provenance bound to the archived Cargo inputs', () => {
  expect(() => validateExecutableProvenance({}, ['syncular-rust'], true)).toThrow('provenance');
  const binary = { path: '/driver', sha256: 'a'.repeat(64), bytes: 1, mode: 0o755 };
  const inputs = rustBuildIdentityFixture('e'.repeat(64), binary.sha256);
  const build = { sourceHash: 'e'.repeat(64), compiler: { ...binary, version: 'rustc 1' }, cargo: { ...binary, version: 'cargo 1' },
    inputs, command: rustBuildCommand(binary.path, inputs.target, inputs.targetDirectory),
    environment: { RUSTC: binary.path, RUSTC_WRAPPER: '', RUSTC_WORKSPACE_WRAPPER: '' }, configuration: cargoConfigurationFixture(), cargoTomlSha256: 'b'.repeat(64), cargoLockSha256: 'c'.repeat(64) };
  const inventory = { rustDriver: { origin: 'source-build', executable: binary, build } };
  const oldFiles = { 'syncular-rust-driver/Cargo.toml': { sha256: build.cargoTomlSha256 }, 'syncular-rust-driver/Cargo.lock': { sha256: build.cargoLockSha256 } };
  const newFiles = { 'drivers/syncular-rust/Cargo.toml': { sha256: build.cargoTomlSha256 }, 'drivers/syncular-rust/Cargo.lock': { sha256: build.cargoLockSha256 } };
  for (const files of [oldFiles, newFiles]) expect(() => validateExecutableProvenance(inventory, ['syncular-rust'], true, { sourceHash: build.sourceHash, files })).not.toThrow();
  expect(() => validateExecutableProvenance(inventory, ['syncular-rust'], true, { sourceHash: build.sourceHash, files: { ...oldFiles, ...newFiles } })).toThrow('ambiguous');
  const source = { sourceHash: build.sourceHash, files: newFiles };
  expect(() => validateExecutableProvenance(inventory, ['syncular-rust'], true, source)).not.toThrow();
  const legacy = structuredClone(inventory) as any; delete legacy.rustDriver.build.inputs; legacy.rustDriver.build.command = [binary.path, 'build', '--release', '--locked', '--message-format=json'];
  expect(() => validateExecutableProvenance(legacy, ['syncular-rust'], false, source)).not.toThrow();
  expect(() => validateExecutableProvenance(legacy, ['syncular-rust'], true, source)).toThrow('fresh-build');
  build.cargoLockSha256 = 'd'.repeat(64);
  expect(() => validateExecutableProvenance(inventory, ['syncular-rust'], true, source)).toThrow('archived source');
});

test('completed Rust trials must report the exact executable selected by the campaign', () => {
  const binary = { path: '/driver', sha256: 'a'.repeat(64), bytes: 1, mode: 0o755 };
  const inventory = { rustDriver: { executable: binary } };
  const result = { stackId: 'syncular-rust' as const, status: 'completed' as const, metadata: { executable: { ...binary } } };
  expect(() => validateTrialExecutable(result, inventory)).not.toThrow();
  result.metadata.executable.sha256 = 'b'.repeat(64);
  expect(() => validateTrialExecutable(result, inventory)).toThrow('differs');
  expect(() => validateTrialExecutable({ ...result, metadata: {} }, inventory)).toThrow('differs');
  expect(() => validateTrialExecutable(result, {})).toThrow('differs');
});
