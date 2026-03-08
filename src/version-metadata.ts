import { readFileSync } from 'node:fs';
import { cpus, hostname, totalmem } from 'node:os';
import { join } from 'node:path';
import {
  benchmarkRoot,
  syncularCheckoutLabel,
  syncularRoot,
} from './paths';
import type { JsonObject, StackId, StackSpec } from './types';

const packageJsonPath = join(benchmarkRoot, 'package.json');

interface PackageJsonFile {
  version?: string;
  packageManager?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const rootPackageJson = readJsonFile<PackageJsonFile>(packageJsonPath) ?? {};
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
    stack.id === 'electric'
      ? inspectServiceImageReference(stack, stack.services.sync)
      : stack.id === 'powersync'
        ? inspectServiceImageReference(stack, stack.services.sync)
        : stack.id === 'livestore'
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
      return buildLocalSyncularVersionMetadata();
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
    case 'replicache':
      return {
        frameworkVersion:
          readInstalledPackageVersion('replicache') ??
          readDependencyRange('replicache') ??
          'unknown',
        versionSource: 'node_modules/replicache/package.json',
        versionComponents: {
          replicache: readInstalledPackageVersion('replicache'),
        },
      };
    case 'livestore':
      return {
        frameworkVersion:
          readInstalledPackageVersion('@livestore/livestore') ??
          readDependencyRange('@livestore/livestore') ??
          'unknown',
        versionSource: 'node_modules/@livestore/livestore/package.json',
        versionComponents: {
          livestore: readInstalledPackageVersion('@livestore/livestore'),
          adapterNode: readInstalledPackageVersion('@livestore/adapter-node'),
          syncElectric: readInstalledPackageVersion('@livestore/sync-electric'),
          electricImage: imageRef ?? 'electricsql/electric:canary',
        },
      };
  }
}

function buildLocalSyncularVersionMetadata(): {
  frameworkVersion: string;
  versionSource: string;
  versionComponents: JsonObject;
} {
  const syncularPackageJson = readJsonFile<PackageJsonFile>(
    join(syncularRoot, 'package.json')
  );
  const rootVersion = syncularPackageJson?.version ?? 'unknown';
  const gitHead = readGitOutput(['rev-parse', 'HEAD']);
  const gitShortHead = readGitOutput(['rev-parse', '--short', 'HEAD']);
  const gitDirty = hasGitChanges(syncularRoot);

  const frameworkVersion =
    gitShortHead && gitDirty
      ? `${rootVersion}+local.${gitShortHead}.dirty`
      : gitShortHead
        ? `${rootVersion}+local.${gitShortHead}`
        : gitDirty
          ? `${rootVersion}+local.dirty`
          : `${rootVersion}+local`;

  return {
    frameworkVersion,
    versionSource: `local syncular checkout at ${syncularCheckoutLabel}`,
    versionComponents: {
      rootVersion,
      gitHead,
      gitShortHead,
      gitDirty,
      client: readInstalledPackageVersion('@syncular/client'),
      core: readInstalledPackageVersion('@syncular/core'),
      bunSqliteDialect: readInstalledPackageVersion('@syncular/dialect-bun-sqlite'),
      transportHttp: readInstalledPackageVersion('@syncular/transport-http'),
      transportWs: readInstalledPackageVersion('@syncular/transport-ws'),
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

function readGitOutput(args: string[]): string | null {
  const result = Bun.spawnSync(['git', '-C', syncularRoot, ...args], {
    cwd: benchmarkRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  if (result.exitCode !== 0) {
    return null;
  }

  const value = new TextDecoder().decode(result.stdout).trim();
  return value || null;
}

function hasGitChanges(repoRoot: string): boolean | null {
  const result = Bun.spawnSync(['git', '-C', repoRoot, 'status', '--porcelain'], {
    cwd: benchmarkRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  if (result.exitCode !== 0) {
    return null;
  }

  return new TextDecoder().decode(result.stdout).trim().length > 0;
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
