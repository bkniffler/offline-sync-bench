import { configurationHash, environmentSummary } from '../configuration.ts';
/** Synthetic publication-validation evidence, never a real build receipt. */
export function cargoConfigurationFixture() {
  const body = { version: 1 as const, workingDirectory: '/synthetic', cargoHome: '/synthetic/.cargo',
    probes: { '/synthetic/.cargo/config': { present: false } }, mergeOrder: [] as string[],
    mergedFileSha256: configurationHash({}), mergedFileSettings: environmentSummary({}), environment: environmentSummary({}) };
  return { ...body, fingerprint: configurationHash(body) };
}
export function rustBuildIdentityFixture(sourceHash: string, executableSha256: string) {
  return { version: 1, method: 'clean-native-rust-build-v1', path: 'RUST-BUILD.json', sha256: '1'.repeat(64), fingerprint: '2'.repeat(64),
    sourceHash, executableSha256, target: 'aarch64-apple-darwin', targetDirectory: '/synthetic/target', cargoSourcesFingerprint: '3'.repeat(64), nativeInputsFingerprint: '4'.repeat(64) };
}
