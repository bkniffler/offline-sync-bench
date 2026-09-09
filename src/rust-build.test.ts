import { test, expect } from 'bun:test';
import { rustBuildEnvironment, validateRustArtifacts, validateRustBuildIdentity, rustDependencyTreePackages } from './rust-build.ts';
import type { NativeBuildInputs } from './native-build-inputs.ts';
import type { CargoSources } from './cargo-sources.ts';
import { rustBuildIdentityFixture } from './test-fixtures/cargo.ts';

test('controlled Rust environment excludes ambient wrappers, flags and library paths', () => {
  const native = { target: 'aarch64-apple-darwin', roots: { appleToolchain: '/apple/usr', rustBin: '/rust/bin' }, sdk: { path: '/sdk' },
    tools: { rustc: { path: '/rust/bin/rustc' }, clang: { path: '/apple/usr/bin/clang' }, clangxx: { path: '/apple/usr/bin/clang++' }, ar: { path: '/apple/usr/bin/ar' }, ranlib: { path: '/apple/usr/bin/ranlib' } } } as unknown as NativeBuildInputs;
  const env = rustBuildEnvironment(native, { HOME: '/home', RUSTC_WRAPPER: '/cache', CFLAGS: '-I/untracked', LIBRARY_PATH: '/untracked', SECRET_TOKEN: 'secret', CC_aarch64_apple_darwin: '/other/clang', CARGO_HOME: '/cargo' });
  expect(env.HOME).toBe('/home'); expect(env.CARGO_HOME).toBe('/cargo'); expect(env.RUSTC_WRAPPER).toBe(''); expect(env.CFLAGS).toBe('');
  expect(env.LIBRARY_PATH).toBeUndefined(); expect(env.SECRET_TOKEN).toBeUndefined(); expect(env.CC_aarch64_apple_darwin).toBe('/apple/usr/bin/clang');
  expect(env.CARGO_ENCODED_RUSTFLAGS).toBe('-Clinker=/apple/usr/bin/clang'); expect(env.SDKROOT).toBe('/sdk');
});
const sources = { metadata: { packages: [{ id: 'driver', name: 'driver', version: '1.0.0' }, { id: 'native', name: 'native', version: '1.0.0' }, { id: 'optional', name: 'optional', version: '1.0.0' }], resolve: { root: 'driver', nodes: [{ id: 'driver', features: [] }, { id: 'native', features: ['bundled', 'unused'] }, { id: 'optional', features: [] }] } } } as CargoSources;
const tree = 'driver v1.0.0 (/driver)|\nnative v1.0.0|bundled\nnative v1.0.0|bundled (*)\n';
const artifact = (id: string, features: string[], executable: string | null = null) => ({ reason: 'compiler-artifact', package_id: id, fresh: false, filenames: [executable ?? `/fresh/${id}.rlib`], features, target: { name: id === 'driver' ? 'syncular-bench' : id, kind: [id === 'driver' ? 'bin' : 'lib'] }, executable });
const messages = () => [artifact('native', ['bundled']), { reason: 'build-script-executed', package_id: 'native', out_dir: '/fresh/build/native/out', linked_paths: ['native=/fresh/build/native/out'] }, artifact('driver', [], '/fresh/driver'), { reason: 'build-finished', success: true }];
test('fresh artifact admission rejects cached units, external outputs and graph/feature drift', () => {
  expect(validateRustArtifacts(messages(), sources, '/fresh', tree)).toBe('/fresh/driver');
  for (const mutate of [
    (m: any[]) => m[0].fresh = true,
    (m: any[]) => m[0].filenames = ['/cached/native.rlib'],
    (m: any[]) => m[1].out_dir = '/cached/build/out',
    (m: any[]) => m[1].linked_paths = ['native=/untracked/lib'],
    (m: any[]) => m[0].features = ['different'],
    (m: any[]) => m[0].package_id = 'missing',
    (m: any[]) => m[2].executable = '/cached/driver',
    (m: any[]) => m.pop(),
    (m: any[]) => m[3].success = false,
    (m: any[]) => m.splice(0, 1),
  ]) { const m = messages(); mutate(m); expect(() => validateRustArtifacts(m, sources, '/fresh', tree)).toThrow(); }
});
test('Rust build identity binds source, executable and archive path', () => {
  const fixture = rustBuildIdentityFixture('a'.repeat(64), 'b'.repeat(64)) as any;
  expect(() => validateRustBuildIdentity(fixture, fixture.sourceHash, fixture.executableSha256)).not.toThrow();
  expect(() => validateRustBuildIdentity(undefined, fixture.sourceHash, fixture.executableSha256)).toThrow();
  expect(() => validateRustBuildIdentity(fixture, 'c'.repeat(64), fixture.executableSha256)).toThrow();
  expect(() => validateRustBuildIdentity(fixture, fixture.sourceHash, 'c'.repeat(64))).toThrow();
  expect(() => validateRustBuildIdentity({ ...fixture, path: '../RUST-BUILD.json' }, fixture.sourceHash, fixture.executableSha256)).toThrow();
});

test('build tree allows unused metadata packages/features but rejects missing and ambiguous identities', () => {
  expect([...rustDependencyTreePackages(tree, sources).keys()]).toEqual(['driver', 'native']);
  expect(validateRustArtifacts(messages(), sources, '/fresh', tree)).toBe('/fresh/driver');
  for (const invalid of [tree + 'unknown v1.0.0|\n', tree + 'native v1.0.0|unknown\n', 'native v1.0.0|bundled', 'malformed']) {
    expect(() => rustDependencyTreePackages(invalid, sources)).toThrow();
  }
  expect(() => validateRustArtifacts(messages(), sources, '/fresh', tree + 'optional v1.0.0|\n')).toThrow();
  expect(() => validateRustArtifacts(messages(), sources, '/fresh', tree + 'native v1.0.0|unused\n')).toThrow();
  const duplicate = structuredClone(sources);
  duplicate.metadata.packages.push({ id: 'other-native', name: 'native', version: '1.0.0' });
  expect(() => rustDependencyTreePackages(tree, duplicate)).toThrow();
});
