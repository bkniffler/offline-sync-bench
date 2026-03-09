import { gzipSync } from 'node:zlib';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import {
  benchmarkRoot,
  resultsRoot,
  tempRoot as sharedTempRoot,
} from './paths';

export interface BundleTarget {
  id: string;
  label: string;
  importPath: string;
  versionPackageName: string;
  versionOverride?: string;
  displayImportPath?: string;
  profile: 'retained-entry' | 'named-import';
  namedImports?: string[];
  entrySource?: string;
}

export interface BundleSizeRow {
  id: string;
  label: string;
  importPath: string;
  versionPackageName: string;
  profile: 'retained-entry' | 'named-import';
  version: string | null;
  rawBytes: number | null;
  gzipBytes: number | null;
  rawKb: number | null;
  gzipKb: number | null;
  artifactCount: number;
  status: 'completed' | 'failed';
  error: string | null;
}

export const cwd = benchmarkRoot;
export const tempRoot = join(sharedTempRoot, 'bundle-size');
export { resultsRoot };
const require = createRequire(import.meta.url);

export const targets: BundleTarget[] = [
  {
    id: 'syncular-client-retained',
    label: 'Syncular Client',
    importPath: '@syncular/client',
    versionPackageName: '@syncular/client',
    profile: 'retained-entry',
  },
  {
    id: 'syncular-client-root-named',
    label: 'Syncular Client Root',
    importPath: '@syncular/client',
    versionPackageName: '@syncular/client',
    profile: 'named-import',
    namedImports: ['createClient', 'createClientHandler'],
  },
  {
    id: 'syncular-umbrella-retained',
    label: 'Syncular Umbrella',
    importPath: 'syncular',
    versionPackageName: 'syncular',
    profile: 'retained-entry',
  },
  {
    id: 'syncular-subpath-root-named',
    label: 'Syncular Umbrella Root',
    importPath: 'syncular/client',
    versionPackageName: 'syncular',
    profile: 'named-import',
    namedImports: ['createClient', 'createClientHandler'],
  },
  {
    id: 'electric-retained',
    label: 'Electric Client',
    importPath: '@electric-sql/client',
    versionPackageName: '@electric-sql/client',
    profile: 'retained-entry',
  },
  {
    id: 'electric-minimal',
    label: 'Electric Client',
    importPath: '@electric-sql/client',
    versionPackageName: '@electric-sql/client',
    profile: 'named-import',
    namedImports: ['ShapeStream'],
  },
  {
    id: 'zero-retained',
    label: 'Zero',
    importPath: '@rocicorp/zero',
    versionPackageName: '@rocicorp/zero',
    profile: 'retained-entry',
  },
  {
    id: 'zero-minimal',
    label: 'Zero',
    importPath: '@rocicorp/zero',
    versionPackageName: '@rocicorp/zero',
    profile: 'named-import',
    namedImports: ['Zero'],
  },
  {
    id: 'powersync-retained',
    label: 'PowerSync Web',
    importPath: '@powersync/web',
    versionPackageName: '@powersync/web',
    profile: 'retained-entry',
  },
  {
    id: 'powersync-minimal',
    label: 'PowerSync Web',
    importPath: '@powersync/web',
    versionPackageName: '@powersync/web',
    profile: 'named-import',
    namedImports: ['PowerSyncDatabase'],
  },
  {
    id: 'replicache-retained',
    label: 'Replicache',
    importPath: 'replicache',
    versionPackageName: 'replicache',
    profile: 'retained-entry',
  },
  {
    id: 'replicache-minimal',
    label: 'Replicache',
    importPath: 'replicache',
    versionPackageName: 'replicache',
    profile: 'named-import',
    namedImports: ['Replicache'],
  },
  {
    id: 'livestore-retained',
    label: 'LiveStore',
    importPath: '@livestore/livestore',
    versionPackageName: '@livestore/livestore',
    profile: 'retained-entry',
  },
  {
    id: 'livestore-minimal',
    label: 'LiveStore',
    importPath: '@livestore/livestore',
    versionPackageName: '@livestore/livestore',
    profile: 'named-import',
    namedImports: ['createStore'],
  },
];

export async function fileExists(path: string): Promise<boolean> {
  try {
    await Bun.file(path).arrayBuffer();
    return true;
  } catch {
    return false;
  }
}

export async function resolveInstalledVersion(
  packageName: string
): Promise<string | null> {
  try {
    const resolvedPath = require.resolve(packageName, {
      paths: [cwd],
    });

    let currentDir = dirname(resolvedPath);
    while (currentDir !== dirname(currentDir)) {
      const packageJsonPath = join(currentDir, 'package.json');
      if (await fileExists(packageJsonPath)) {
        const packageJson = JSON.parse(
          await readFile(packageJsonPath, 'utf8')
        ) as { name?: string; version?: string };
        if (packageJson.name === packageName) {
          return packageJson.version ?? null;
        }
      }
      currentDir = dirname(currentDir);
    }
  } catch {
    return null;
  }

  return null;
}

export function resolveEntrySource(target: BundleTarget): string {
  return (
    target.entrySource ??
    (target.profile === 'retained-entry'
      ? [
          `import * as library from '${target.importPath}';`,
          `globalThis.__offlineSyncBench = Object.keys(library).length;`,
          `export default library;`,
          '',
        ].join('\n')
      : [
          `import { ${(target.namedImports ?? []).join(', ')} } from '${target.importPath}';`,
          `globalThis.__offlineSyncBench = [${(target.namedImports ?? []).join(', ')}].length;`,
          `export default globalThis.__offlineSyncBench;`,
          '',
        ].join('\n'))
  );
}

export async function measureBundle(
  target: BundleTarget
): Promise<BundleSizeRow> {
  const entryPath = join(tempRoot, `${target.id}.ts`);
  const outdir = join(tempRoot, `out-${target.id}`);
  const entrySource = resolveEntrySource(target);
  await writeFile(
    entryPath,
    entrySource,
    'utf8'
  );

  const buildResult = await Bun.build({
    entrypoints: [entryPath],
    target: 'browser',
    format: 'esm',
    minify: true,
    sourcemap: 'none',
    splitting: true,
    outdir,
  });

  if (!buildResult.success) {
    return {
      id: target.id,
      label: target.label,
      importPath: target.displayImportPath ?? target.importPath,
      versionPackageName: target.versionPackageName,
      profile: target.profile,
      version:
        target.versionOverride ??
        (await resolveInstalledVersion(target.versionPackageName)),
      rawBytes: null,
      gzipBytes: null,
      rawKb: null,
      gzipKb: null,
      artifactCount: 0,
      status: 'failed',
      error: buildResult.logs.map((log) => log.message).join('; ') || 'Build failed',
    };
  }

  let rawBytes = 0;
  let gzipBytes = 0;

  for (const output of buildResult.outputs) {
    if (!output.path.endsWith('.js')) {
      continue;
    }
    const buffer = Buffer.from(await readFile(output.path));
    rawBytes += buffer.byteLength;
    gzipBytes += gzipSync(buffer, { level: 9 }).byteLength;
  }

  return {
    id: target.id,
    label: target.label,
    importPath: target.displayImportPath ?? target.importPath,
    versionPackageName: target.versionPackageName,
    profile: target.profile,
    version:
      target.versionOverride ?? (await resolveInstalledVersion(target.versionPackageName)),
    rawBytes,
    gzipBytes,
    rawKb: rawBytes === 0 ? 0 : Math.round((rawBytes / 1024) * 100) / 100,
    gzipKb: gzipBytes === 0 ? 0 : Math.round((gzipBytes / 1024) * 100) / 100,
    artifactCount: buildResult.outputs.filter((output) => output.path.endsWith('.js'))
      .length,
    status: 'completed',
    error: null,
  };
}

export function buildMarkdown(rows: BundleSizeRow[]): string {
  return [
    '# Client Library Bundle Sizes',
    '',
    'Browser-targeted minified bundles built from benchmark entrypoints. `retained-entry` keeps the whole public namespace live; `named-import` is a more realistic tree-shaken import profile.',
    '',
    '| Library | Import path | Profile | Version | Status | Raw KB | Gzip KB | Artifacts | Notes |',
    '| --- | --- | --- | --- | --- | ---: | ---: | ---: | --- |',
    ...rows.map((row) =>
      `| ${row.label} | \`${row.importPath}\` | ${row.profile} | ${row.version ?? 'unknown'} | ${row.status} | ${row.rawKb ?? 'n/a'} | ${row.gzipKb ?? 'n/a'} | ${row.artifactCount} | ${row.error ?? ''} |`
    ),
    '',
  ].join('\n');
}

export function getBundleTargetsByIds(ids: string[]): BundleTarget[] {
  const selected = targets.filter((target) => ids.includes(target.id));
  if (selected.length !== ids.length) {
    const missing = ids.filter(
      (id) => !selected.some((target) => target.id === id)
    );
    throw new Error(`Unknown bundle target(s): ${missing.join(', ')}`);
  }
  return selected;
}

export async function measureAllBundles(
  selectedTargets: BundleTarget[] = targets
): Promise<BundleSizeRow[]> {
  await mkdir(tempRoot, { recursive: true });
  await mkdir(resultsRoot, { recursive: true });

  const rows: BundleSizeRow[] = [];
  for (const target of selectedTargets) {
    rows.push(await measureBundle(target));
  }

  return rows;
}

export async function writeBundleSizeResults(
  rows: BundleSizeRow[],
  options?: {
    jsonPath?: string;
    markdownPath?: string;
  }
): Promise<void> {
  const jsonPath = options?.jsonPath ?? join(resultsRoot, 'BUNDLE_SIZES.json');
  const markdownPath =
    options?.markdownPath ?? join(resultsRoot, 'BUNDLE_SIZES.md');

  await writeFile(jsonPath, `${JSON.stringify(rows, null, 2)}\n`, 'utf8');
  await writeFile(markdownPath, `${buildMarkdown(rows)}\n`, 'utf8');
}

export async function cleanupBundleTemp(): Promise<void> {
  await rm(tempRoot, {
    recursive: true,
    force: true,
  });
}

async function main(): Promise<void> {
  const rows = await measureAllBundles();
  await writeBundleSizeResults(rows);
  console.log(buildMarkdown(rows));
  await cleanupBundleTemp();
}

if (import.meta.main) {
  await main();
}
