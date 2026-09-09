import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync, chmodSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { captureBuildInputs, assertBuildInputsUnchanged, validateBuildInputs, resolvedBuildInputPath } from './build-inputs.ts';
import { configurationHash } from './configuration.ts';
import { validateCargoGraph } from './cargo-sources.ts';

test('build input closure captures file bytes, modes, added files and deletions', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'build-inputs-')));
  try {
    const packageRoot = join(root, 'package'); mkdirSync(packageRoot); const file = join(packageRoot, 'build.rs'); writeFileSync(file, 'original'); chmodSync(file, 0o644);
    const original = captureBuildInputs([packageRoot]); expect(() => assertBuildInputsUnchanged(original)).not.toThrow();
    writeFileSync(file, 'changed'); expect(() => assertBuildInputsUnchanged(original)).toThrow('changed'); writeFileSync(file, 'original');
    chmodSync(file, 0o755); expect(() => assertBuildInputsUnchanged(original)).toThrow('changed'); chmodSync(file, 0o644);
    writeFileSync(join(packageRoot, 'extra-header.h'), 'new'); expect(() => assertBuildInputsUnchanged(original)).toThrow('changed'); rmSync(join(packageRoot, 'extra-header.h'));
    rmSync(file); expect(() => assertBuildInputsUnchanged(original)).toThrow('changed'); writeFileSync(file, 'original'); chmodSync(file, 0o644);
    expect(() => assertBuildInputsUnchanged(original)).not.toThrow();
  } finally { rmSync(root, { recursive: true }); }
});
test('input links resolve through recorded aliases and require captured external targets', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'build-input-links-')));
  try {
    const first = join(root, 'first'), second = join(root, 'second'), alias = join(root, 'alias'); mkdirSync(first); mkdirSync(second);
    writeFileSync(join(first, 'source.c'), 'one'); writeFileSync(join(second, 'source.c'), 'two'); symlinkSync(first, alias);
    const original = captureBuildInputs([alias]); expect(resolvedBuildInputPath(original, join(alias, 'source.c'))).toBe(join(first, 'source.c'));
    symlinkSync(join(second, 'source.c'), join(first, 'header.h'));
    expect(() => captureBuildInputs([alias])).toThrow('leaves');
    const complete = captureBuildInputs([alias, second]); expect(() => validateBuildInputs(complete)).not.toThrow();
    expect(resolvedBuildInputPath(complete, join(alias, 'header.h'))).toBe(join(second, 'source.c'));
    rmSync(alias); symlinkSync(second, alias); expect(() => assertBuildInputsUnchanged(complete)).toThrow('changed');
  } finally { rmSync(root, { recursive: true }); }
});
test('archived input validation rejects malformed entries even after a fingerprint is recomputed', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'build-input-invalid-')));
  try {
    const file = join(root, 'tool'); writeFileSync(file, 'tool');
    const good = captureBuildInputs([root]);
    for (const mutate of [
      (r: any) => r.entries[file].sha256 = 'invalid',
      (r: any) => r.entries[file].mode = 0o1000,
      (r: any) => r.entries[file].bytes = -1,
      (r: any) => r.entries['/uncaptured/tool'] = r.entries[file],
      (r: any) => r.roots.push(r.roots[0]),
      (r: any) => delete r.entries[root],
    ]) { const r = structuredClone(good); mutate(r); const { fingerprint, ...body } = r; r.fingerprint = configurationHash(body); expect(() => validateBuildInputs(r)).toThrow(); }
  } finally { rmSync(root, { recursive: true }); }
});
test('Cargo graph validation rejects absent nodes, missing dependency packages and duplicated identities', () => {
  const graph = { version: 1, workspace_root: '/workspace', packages: [{ id: 'root', name: 'root', version: '1', manifest_path: '/workspace/Cargo.toml', source: null }, { id: 'dependency', name: 'dependency', version: '2', manifest_path: '/registry/dependency/Cargo.toml', source: 'opaque-source-id' }], resolve: { root: 'root', nodes: [{ id: 'root', features: [], dependencies: ['dependency'] }, { id: 'dependency', features: ['native'], dependencies: [] }] } };
  expect(() => validateCargoGraph(graph, '/workspace')).not.toThrow();
  for (const mutate of [
    (r: any) => r.resolve.nodes.pop(),
    (r: any) => r.resolve.nodes[0].dependencies.push('missing'),
    (r: any) => r.packages[1].id = 'root',
    (r: any) => r.resolve.nodes[1].id = 'root',
    (r: any) => r.resolve.nodes[1].features = [42],
    (r: any) => r.resolve.root = 'missing',
  ]) { const r = structuredClone(graph); mutate(r); expect(() => validateCargoGraph(r, '/workspace')).toThrow(); }
});
