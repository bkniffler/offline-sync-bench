import { expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertCargoConfiguration, captureCargoConfiguration, validateCargoConfiguration } from './cargo-configuration.ts';
import { configurationHash, environmentSummary } from './configuration.ts';

test('Cargo configuration respects ancestor, home, legacy-file and recursive include precedence', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'cargo-config-'))), cwd = join(dir, 'project', 'crate'), cargoHome = join(dir, 'cargo-home');
  try {
    for (const path of [cwd, cargoHome, join(dir, 'project', '.cargo'), join(cwd, '.cargo')]) await mkdir(path, { recursive: true });
    await writeFile(join(cargoHome, 'config.toml'), '[build]\njobs=1\nrustflags=["home"]\n');
    await writeFile(join(dir, 'project', '.cargo', 'config.toml'), '[build]\njobs=2\nrustflags=["parent"]\n');
    await writeFile(join(cwd, '.cargo', 'first.toml'), '[build]\njobs=3\nrustflags=["first"]\n');
    await writeFile(join(cwd, '.cargo', 'second.toml'), 'include=["first.toml"]\n[build]\nrustflags=["second"]\n');
    await writeFile(join(cwd, '.cargo', 'config'), 'include=["second.toml", {path="optional.toml",optional=true}]\n[build]\njobs=4\nrustflags=["local"]\n[registry]\ntoken="private-cargo-token"\n');
    await writeFile(join(cwd, '.cargo', 'config.toml'), '[build]\njobs=99\n');
    const env = { HOME: dir, CARGO_HOME: cargoHome, CARGO_BUILD_JOBS: '7', EXTERNAL_BUILD_SETTING: 'opaque-private-value' };
    const captured = captureCargoConfiguration(cwd, env);
    validateCargoConfiguration(captured);
    expect(captured.mergedFileSha256).toBe(configurationHash({ build: { jobs: 4, rustflags: ['home', 'parent', 'first', 'second', 'local'] }, registry: { token: 'private-cargo-token' } }));
    expect(captured.environment).toEqual(environmentSummary(env));
    expect(captured.mergeOrder.at(-1)).toBe(join(cwd, '.cargo', 'config'));
    expect(JSON.stringify(captured)).not.toContain('private-cargo-token');
    expect(JSON.stringify(captured)).not.toContain('opaque-private-value');
    expect(captured.probes[join(cwd, '.cargo', 'optional.toml')]).toEqual({ present: false });
    await writeFile(join(cwd, '.cargo', 'optional.toml'), '[build]\njobs=5\n');
    expect(() => assertCargoConfiguration(captured, env)).toThrow('changed');
    await rm(join(cwd, '.cargo', 'optional.toml'));
    expect(() => assertCargoConfiguration(captured, env)).not.toThrow();
    expect(() => assertCargoConfiguration(captured, { ...env, EXTERNAL_BUILD_SETTING: 'changed' })).toThrow('changed');
    await chmod(join(cwd, '.cargo', 'first.toml'), 0o600);
    expect(() => assertCargoConfiguration(captured, env)).toThrow('changed');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('new ancestor config, symlink target changes, cycles and missing includes cannot bypass Cargo input guards', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'cargo-input-'))), cwd = join(dir, 'crate'), cargoHome = join(dir, 'cargo-home');
  try {
    await mkdir(cwd); await mkdir(cargoHome); const env = { HOME: dir, CARGO_HOME: cargoHome };
    const empty = captureCargoConfiguration(cwd, env); expect(empty.mergeOrder).toHaveLength(0);
    await mkdir(join(dir, '.cargo')); const path = join(dir, '.cargo', 'config.toml');
    await writeFile(path, '[build]\njobs=1\n'); expect(() => assertCargoConfiguration(empty, env)).toThrow('changed');
    await rm(path); await writeFile(join(dir, 'external.toml'), '[build]\njobs=1\n'); await symlink('../external.toml', path);
    const linked = captureCargoConfiguration(cwd, env); expect(linked.probes[path].resolvedPath).toBe(join(dir, 'external.toml'));
    await writeFile(join(dir, 'external.toml'), '[build]\njobs=2\n'); expect(() => assertCargoConfiguration(linked, env)).toThrow('changed');
    await writeFile(join(dir, 'external.toml'), 'include=["missing.toml"]\n'); expect(() => captureCargoConfiguration(cwd, env)).toThrow('include is missing');
    await writeFile(join(dir, 'external.toml'), 'include=["config.toml"]\n'); expect(() => captureCargoConfiguration(cwd, env)).toThrow('cycle');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Cargo configuration provenance rejects altered or absent evidence', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'cargo-validate-')));
  try {
    const config = captureCargoConfiguration(dir, { HOME: dir });
    expect(() => validateCargoConfiguration(config)).not.toThrow();
    expect(() => validateCargoConfiguration(undefined)).toThrow('missing');
    config.environment.sha256 = configurationHash('different');
    expect(() => validateCargoConfiguration(config)).toThrow('fingerprint');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
