import { readFileSync } from 'node:fs';
import { cpus, hostname, totalmem } from 'node:os';
import { join } from 'node:path';
import { benchmarkRoot } from './paths';
import type { JsonObject, StackId, StackSpec } from './types';

const packageJsonPath = join(benchmarkRoot, 'package.json');
const syncularStackPackageJsonPath = join(
  benchmarkRoot,
  'stacks',
  'syncular',
  'syncular-app',
  'package.json'
);
const syncularStackLockPath = join(benchmarkRoot, 'bun.lock');
const syncularRustCargoLockPath = join(
  benchmarkRoot,
  'syncular-rust-driver',
  'Cargo.lock'
);

interface PackageJsonFile {
  name?: string;
  version?: string;
  packageManager?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface BunLockFile {
  packages?: Record<string, unknown>;
}

const rootPackageJson = readJsonFile<PackageJsonFile>(packageJsonPath) ?? {};
const syncularStackPackageJson =
  readJsonFile<PackageJsonFile>(syncularStackPackageJsonPath) ?? {};
const stackVersionCache = new Map<StackId, JsonObject>();
let environmentCache: JsonObject | null = null;

export function getBenchmarkEnvironmentMetadata(): JsonObject {
  if (environmentCache) {
    return environmentCache;
  }

  const cpuList = cpus();
  const firstCpu = cpuList[0];

  environmentCache = {
    benchmarkRoot: '.',
    bunVersion: Bun.version,
    packageManager: rootPackageJson.packageManager ?? 'unknown',
    platform: process.platform,
    arch: process.arch,
    hostname: hostname(),
    cpuModel: firstCpu?.model ?? 'unknown',
    cpuCount: cpuList.length,
    totalMemoryMb: Math.round(totalmem() / (1024 * 1024)),
  };

  return environmentCache;
}

export function getStackVersionMetadata(stack: StackSpec): JsonObject {
  const cached = stackVersionCache.get(stack.id);
  if (cached) {
    return cached;
  }

  const imageRef =
    stack.id === 'electric' || stack.id === 'electric-tanstack'
      ? inspectServiceImageReference(stack, stack.services.sync)
      : stack.id === 'powersync'
        ? inspectServiceImageReference(stack, stack.services.sync)
        : stack.id === 'zero'
          ? inspectServiceImageReference(stack, stack.services.sync)
          : null;

  const versionMetadata = buildVersionMetadata(stack.id, imageRef);

  const metadata: JsonObject = {
    framework: stack.title,
    frameworkVersion: versionMetadata.frameworkVersion,
    versionSource: versionMetadata.versionSource,
    versionComponents: versionMetadata.versionComponents,
  };

  stackVersionCache.set(stack.id, metadata);
  return metadata;
}

function buildVersionMetadata(
  stackId: StackId,
  imageRef: string | null
): {
  frameworkVersion: string;
  versionSource: string;
  versionComponents: JsonObject;
} {
  switch (stackId) {
    case 'syncular':
      return buildPublishedSyncularVersionMetadata();
    case 'syncular-rust':
      return buildRustSyncularVersionMetadata();
    case 'electric':
      return {
        frameworkVersion: imageRef ?? 'electricsql/electric:canary',
        versionSource: imageRef
          ? 'docker image digest for electric service'
          : 'compose image reference',
        versionComponents: {
          electricImage: imageRef ?? 'electricsql/electric:canary',
        },
      };
    case 'electric-tanstack':
      return {
        frameworkVersion:
          readInstalledPackageVersion('@tanstack/db') ??
          readDependencyRange('@tanstack/db') ??
          'unknown',
        versionSource: 'node_modules/@tanstack/db/package.json',
        versionComponents: {
          tanstackDb: readInstalledPackageVersion('@tanstack/db'),
          electricCollection: readInstalledPackageVersion(
            '@tanstack/electric-db-collection'
          ),
          offlineTransactions: readInstalledPackageVersion(
            '@tanstack/offline-transactions'
          ),
          sqlitePersistence: readInstalledPackageVersion(
            '@tanstack/node-db-sqlite-persistence'
          ),
          electricClient: readInstalledPackageVersion('@electric-sql/client'),
          electricImage: imageRef ?? 'electricsql/electric:canary',
        },
      };
    case 'zero':
      return {
        frameworkVersion:
          readInstalledPackageVersion('@rocicorp/zero') ??
          readDependencyRange('@rocicorp/zero') ??
          'unknown',
        versionSource: 'node_modules/@rocicorp/zero/package.json',
        versionComponents: {
          zeroClient: readInstalledPackageVersion('@rocicorp/zero'),
          zeroCacheImage: imageRef ?? 'offline-sync-bench-zero-zero-cache:local-build',
        },
      };
    case 'powersync':
      return {
        frameworkVersion:
          imageRef ??
          readInstalledPackageVersion('@powersync/node') ??
          readDependencyRange('@powersync/node') ??
          'unknown',
        versionSource: imageRef
          ? 'docker image digest for powersync service'
          : 'node_modules/@powersync/node/package.json',
        versionComponents: {
          serviceImage: imageRef ?? 'journeyapps/powersync-service:latest',
          nodeSdk: readInstalledPackageVersion('@powersync/node'),
        },
      };
    case 'turso':
      return {
        frameworkVersion:
          readInstalledPackageVersion('@tursodatabase/sync') ??
          readDependencyRange('@tursodatabase/sync') ??
          'unknown',
        versionSource: 'node_modules/@tursodatabase/sync/package.json',
        versionComponents: {
          syncClient: readInstalledPackageVersion('@tursodatabase/sync'),
          syncServer: 'tursodb:0.7.0',
        },
      };
    case 'jazz-v2':
      return {
        frameworkVersion:
          readInstalledPackageVersion('jazz-tools') ??
          readDependencyRange('jazz-tools') ??
          'unknown',
        versionSource: 'node_modules/jazz-tools/package.json',
        versionComponents: {
          jazzTools: readInstalledPackageVersion('jazz-tools'),
          jazzNapi: readInstalledPackageVersion('jazz-napi'),
          server: 'jazz-tools server 2.0.0-alpha.53',
          releaseChannel: 'v2 alpha',
        },
      };
    case 'triplit':
      return {
        frameworkVersion:
          readInstalledPackageVersion('@triplit/client') ??
          readDependencyRange('@triplit/client') ??
          'unknown',
        versionSource: 'node_modules/@triplit/client/package.json',
        versionComponents: {
          client: readInstalledPackageVersion('@triplit/client'),
          cli: readInstalledPackageVersion('@triplit/cli'),
          serverImage: 'aspencloud/triplit-server-bun:1.0.61',
          serverPackage: '1.1.8',
        },
      };
  }
}

function buildRustSyncularVersionMetadata(): {
  frameworkVersion: string;
  versionSource: string;
  versionComponents: JsonObject;
} {
  const server = buildPublishedSyncularVersionMetadata().versionComponents;
  const rustClientVersion =
    readCargoLockPackageVersion(
      syncularRustCargoLockPath,
      'syncular-client'
    ) ?? 'unknown';

  return {
    frameworkVersion: rustClientVersion,
    versionSource: 'syncular-rust-driver/Cargo.lock',
    versionComponents: {
      clientRust: rustClientVersion,
      clientRustPackage: 'syncular-client',
      server: server.server,
      serverHono: server.serverHono,
      serverDependencyRange: server.serverDependencyRange,
      serverHonoDependencyRange: server.serverHonoDependencyRange,
    },
  };
}

function buildPublishedSyncularVersionMetadata(): {
  frameworkVersion: string;
  versionSource: string;
  versionComponents: JsonObject;
} {
  const installedClientVersion =
    readInstalledPackageVersion('@syncular/client');
  const frameworkVersion =
    installedClientVersion ??
    readDependencyRange('@syncular/client') ??
    'unknown';
  const installedVersionSource = installedClientVersion
    ? 'node_modules/@syncular/client/package.json'
    : 'package.json @syncular/client dependency range';

  return {
    frameworkVersion,
    versionSource: installedVersionSource,
    versionComponents: {
      client: readInstalledPackageVersion('@syncular/client'),
      core: readInstalledPackageVersion('@syncular/core'),
      server: readLockedPackageVersion(syncularStackLockPath, '@syncular/server'),
      serverHono: readLockedPackageVersion(
        syncularStackLockPath,
        '@syncular/server-hono'
      ),
      serverDependencyRange:
        syncularStackPackageJson.dependencies?.['@syncular/server'] ?? null,
      serverHonoDependencyRange:
        syncularStackPackageJson.dependencies?.['@syncular/server-hono'] ?? null,
    },
  };
}

function readInstalledPackageVersion(packageName: string): string | null {
  const packageJson = readJsonFile<{ version?: string }>(
    join(benchmarkRoot, 'node_modules', packageName, 'package.json')
  );
  return packageJson?.version ?? null;
}

function readDependencyRange(packageName: string): string | null {
  return (
    rootPackageJson.dependencies?.[packageName] ??
    rootPackageJson.devDependencies?.[packageName] ??
    null
  );
}

function readJsonFile<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

function readLockedPackageVersion(
  lockPath: string,
  packageName: string
): string | null {
  const lockfile = readJsonFile<BunLockFile>(lockPath);
  const entry = lockfile?.packages?.[packageName];
  if (Array.isArray(entry)) {
    const descriptor = entry[0];
    if (typeof descriptor === 'string') {
      const prefix = `${packageName}@`;
      return descriptor.startsWith(prefix)
        ? descriptor.slice(prefix.length)
        : null;
    }
  }

  // Bun's text lockfile is JSONC, so JSON.parse cannot read versions that
  // include comments or trailing commas. Fall back to its package descriptor.
  try {
    const lockText = readFileSync(lockPath, 'utf8');
    const escapedName = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return (
      lockText.match(
        new RegExp(
          `"${escapedName}"\\s*:\\s*\\["${escapedName}@([^"\\s]+)"`
        )
      )?.[1] ?? null
    );
  } catch {
    return null;
  }
}

function readCargoLockPackageVersion(
  lockPath: string,
  packageName: string
): string | null {
  let text: string;
  try {
    text = readFileSync(lockPath, 'utf8');
  } catch {
    return null;
  }

  for (const block of text.split('[[package]]')) {
    const name = block.match(/^name = "([^"]+)"$/m)?.[1];
    if (name !== packageName) continue;
    return block.match(/^version = "([^"]+)"$/m)?.[1] ?? null;
  }
  return null;
}

function inspectServiceImageReference(
  stack: StackSpec,
  serviceName: string
): string | null {
  const containerIdResult = Bun.spawnSync(
    [
      'docker',
      'compose',
      '-f',
      stack.composeFile,
      '-p',
      stack.composeProjectName,
      'ps',
      '-q',
      serviceName,
    ],
    {
      cwd: benchmarkRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );

  if (containerIdResult.exitCode !== 0) {
    return null;
  }

  const containerId = new TextDecoder().decode(containerIdResult.stdout).trim();
  if (!containerId) {
    return null;
  }

  const imageIdResult = Bun.spawnSync(
    ['docker', 'inspect', '--format', '{{.Image}}', containerId],
    {
      cwd: benchmarkRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );

  if (imageIdResult.exitCode !== 0) {
    return null;
  }

  const imageId = new TextDecoder().decode(imageIdResult.stdout).trim();
  if (!imageId) {
    return null;
  }

  const repoDigestResult = Bun.spawnSync(
    ['docker', 'image', 'inspect', '--format', '{{json .RepoDigests}}', imageId],
    {
      cwd: benchmarkRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );

  if (repoDigestResult.exitCode === 0) {
    const repoDigests = parseStringArray(
      new TextDecoder().decode(repoDigestResult.stdout).trim()
    );
    const firstDigest = repoDigests[0];
    if (firstDigest) {
      return firstDigest;
    }
  }

  const repoTagsResult = Bun.spawnSync(
    ['docker', 'image', 'inspect', '--format', '{{json .RepoTags}}', imageId],
    {
      cwd: benchmarkRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );

  if (repoTagsResult.exitCode === 0) {
    const repoTags = parseStringArray(
      new TextDecoder().decode(repoTagsResult.stdout).trim()
    );
    const firstTag = repoTags[0];
    if (firstTag) {
      return firstTag;
    }
  }

  return imageId;
}
function parseStringArray(value: string): string[] {
  if (!value || value === 'null') {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as string[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
