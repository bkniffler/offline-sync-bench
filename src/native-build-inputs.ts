import { execFileSync } from 'node:child_process';
import { dirname, join, basename } from 'node:path';
import { readFileSync, realpathSync } from 'node:fs';
import { captureBuildInputs, validateBuildInputs, assertBuildInputsUnchanged, resolvedBuildInputPath, type BuildInputInventory } from './build-inputs.ts';
import { configurationHash } from './configuration.ts';

export interface NativeBuildInputs {
  version: 1; platform: 'darwin'; target: string;
  tools: Record<string, { path: string; version: string | null }>;
  sdk: { path: string; version: string; settingsPath: string };
  os: { version: string; build: string };
  roots: { rustBin: string; rustLib: string; appleToolchain: string };
  inputs: BuildInputInventory; fingerprint: string;
}
const command = (program: string, args: string[]) => execFileSync(program, args, { encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** Identifies the selected build tools before constructing the controlled
 * recipe. Inventory alone does not prove an existing cached executable used
 * them. Artifact admission requires a fresh build with explicit tool/SDK paths.
 * OS runtime libraries are identified by the macOS build, not a copied image.
 */
export function captureNativeBuildInputs(cargo: string, compiler: string): NativeBuildInputs {
  if (process.platform !== 'darwin') throw new Error('Native build input capture currently supports macOS; other build profiles need explicit toolchain/SDK roots');
  const rustc = realpathSync(compiler), rustVersion = command(rustc, ['--version', '--verbose']);
  const target = rustVersion.match(/^host: (.+)$/m)?.[1];
  if (!target?.endsWith('-apple-darwin')) throw new Error('Expected a native macOS Rust toolchain');
  const clang = command('/usr/bin/xcrun', ['--find', 'clang']), clangxx = command('/usr/bin/xcrun', ['--find', 'clang++']);
  const ar = command('/usr/bin/xcrun', ['--find', 'ar']), ranlib = command('/usr/bin/xcrun', ['--find', 'ranlib']), ld = command('/usr/bin/xcrun', ['--find', 'ld']);
  const sdkPath = command('/usr/bin/xcrun', ['--show-sdk-path']);
  const settingsPath = join(realpathSync(sdkPath), 'SDKSettings.json');
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  if (typeof settings.Version !== 'string' || !settings.Version) throw new Error('Selected SDK version metadata missing');
  const sdk = { path: sdkPath, version: settings.Version, settingsPath };
  const appleToolchain = dirname(dirname(realpathSync(clang)));
  if (!appleToolchain.endsWith('.xctoolchain/usr') && !appleToolchain.endsWith('/CommandLineTools/usr')) throw new Error('Apple compiler requires an explicit supported toolchain root');
  if (basename(dirname(rustc)) !== 'bin') throw new Error('Rust compiler requires a toolchain bin/lib layout');
  const roots = { rustBin: dirname(rustc), rustLib: join(dirname(dirname(rustc)), 'lib'), appleToolchain };
  const tools = {
    cargo: { path: realpathSync(cargo), version: command(cargo, ['--version', '--verbose']) },
    rustc: { path: rustc, version: rustVersion },
    clang: { path: clang, version: command(clang, ['--version']) }, clangxx: { path: clangxx, version: command(clangxx, ['--version']) },
    // Apple's ar/ranlib do not expose --version. Exact executable bytes and the
    // containing toolchain inventory remain mandatory; version stays unknown.
    ar: { path: ar, version: null }, ranlib: { path: ranlib, version: null },
    ld: { path: ld, version: command(ld, ['-version_details']) },
    xcrun: { path: '/usr/bin/xcrun', version: command('/usr/bin/xcrun', ['--version']) },
  };
  const os = { version: command('/usr/bin/sw_vers', ['-productVersion']), build: command('/usr/bin/sw_vers', ['-buildVersion']) };
  const inputs = captureBuildInputs([...Object.values(roots), sdk.path, ...Object.values(tools).map(tool => tool.path), '/bin/sh', '/usr/bin/env', '/usr/bin/uname', '/usr/bin/sw_vers', '/usr/bin/xcode-select']);
  const body = { version: 1 as const, platform: 'darwin' as const, target, tools, sdk, os, roots, inputs };
  const result = { ...body, fingerprint: configurationHash(body) }; validateNativeBuildInputs(result); return result;
}
export function validateNativeBuildInputs(record: NativeBuildInputs): void {
  if (!record || record.version !== 1 || record.platform !== 'darwin' || !record.target?.endsWith('-apple-darwin') || !record.os?.version || !record.os.build || !record.sdk?.version) throw new Error('Native toolchain/SDK provenance missing');
  const { fingerprint, ...body } = record;
  if (configurationHash(body) !== fingerprint) throw new Error('Native build input fingerprint differs');
  validateBuildInputs(record.inputs);
  for (const name of ['cargo', 'rustc', 'clang', 'clangxx', 'ar', 'ranlib', 'ld', 'xcrun']) {
    const tool = record.tools[name];
    if (!tool?.path || !tool.version && !(['ar', 'ranlib'].includes(name) && tool.version === null)) throw new Error(`Native tool identity missing: ${name}`);
    const entry = record.inputs.entries[resolvedBuildInputPath(record.inputs, tool.path)];
    if (entry?.kind !== 'file' || !(entry.mode & 0o111)) throw new Error(`Native tool bytes missing: ${name}`);
  }
  for (const path of [record.sdk.path, ...Object.values(record.roots)]) if (record.inputs.entries[resolvedBuildInputPath(record.inputs, path)]?.kind !== 'directory') throw new Error('Native SDK/library root missing');
}
export function assertNativeBuildInputsUnchanged(record: NativeBuildInputs): void {
  validateNativeBuildInputs(record); assertBuildInputsUnchanged(record.inputs);
  if (command('/usr/bin/sw_vers', ['-productVersion']) !== record.os.version || command('/usr/bin/sw_vers', ['-buildVersion']) !== record.os.build) throw new Error('Build host OS changed');
}
