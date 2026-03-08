import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { build, type Plugin } from 'esbuild';
import {
  cleanupBundleTemp,
  cwd,
  getBundleTargetsByIds,
  resolveEntrySource,
  resultsRoot,
  targets,
  tempRoot,
  type BundleTarget,
} from './bundle-size';

const nodeBuiltinStubPlugin: Plugin = {
  name: 'node-builtin-stub',
  setup(buildApi) {
    buildApi.onResolve({ filter: /^node:/ }, (args) => ({
      path: args.path,
      namespace: 'node-builtin-stub',
    }));
    buildApi.onLoad(
      { filter: /.*/, namespace: 'node-builtin-stub' },
      () => ({
        contents: 'export default {}; export const gzipSync = undefined; export const gunzipSync = undefined;',
        loader: 'js',
      })
    );
  },
};

export interface ContributionRow {
  key: string;
  bytes: number;
  kb: number;
}

export interface BundleAnalysisRow {
  targetId: string;
  label: string;
  importPath: string;
  rawBytes: number;
  rawKb: number;
  gzipBytes: number;
  gzipKb: number;
  topPackages: ContributionRow[];
  topModules: ContributionRow[];
}

function resolveCliTargets(): BundleTarget[] {
  const ids = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
  if (ids.length === 0) {
    return getBundleTargetsByIds(['syncular-client-local-root']);
  }
  return getBundleTargetsByIds(ids);
}

function toKb(bytes: number): number {
  return Math.round((bytes / 1024) * 100) / 100;
}

function gzipSizeForText(text: string): number {
  return Buffer.byteLength(Bun.gzipSync(text));
}

function classifyPackage(inputPath: string): string {
  if (inputPath.includes('/syncular/packages/client/')) return '@syncular/client';
  if (inputPath.includes('/syncular/packages/core/')) return '@syncular/core';
  if (inputPath.includes('/syncular/packages/transport-http/')) {
    return '@syncular/transport-http';
  }
  if (inputPath.includes('/syncular/packages/transport-ws/')) {
    return '@syncular/transport-ws';
  }
  const marker = '/node_modules/';
  const markerIndex = inputPath.lastIndexOf(marker);
  if (markerIndex >= 0) {
    const remainder = inputPath.slice(markerIndex + marker.length);
    const segments = remainder.split('/');
    if (segments[0]?.startsWith('@')) {
      return `${segments[0]}/${segments[1] ?? ''}`;
    }
    return segments[0] ?? '(node_modules)';
  }
  if (basename(inputPath).startsWith('entry-')) {
    return '(entrypoint)';
  }
  return '(other)';
}

function sortContributions(
  contributions: Map<string, number>,
  limit: number
): ContributionRow[] {
  return [...contributions.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .map(([key, bytes]) => ({
      key,
      bytes,
      kb: toKb(bytes),
    }));
}

export async function analyzeTarget(
  target: BundleTarget
): Promise<BundleAnalysisRow> {
  await mkdir(tempRoot, { recursive: true });
  await mkdir(resultsRoot, { recursive: true });

  const entryPath = join(tempRoot, `entry-${target.id}.ts`);
  const outdir = join(tempRoot, `analyze-${target.id}`);
  await writeFile(entryPath, resolveEntrySource(target), 'utf8');

  const result = await build({
    absWorkingDir: cwd,
    entryPoints: [entryPath],
    bundle: true,
    splitting: true,
    metafile: true,
    write: true,
    outdir,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    sourcemap: false,
    plugins: [nodeBuiltinStubPlugin],
  });

  const packageBytes = new Map<string, number>();
  const moduleBytes = new Map<string, number>();
  let rawBytes = 0;
  let gzipBytes = 0;

  for (const [outputPath, outputMeta] of Object.entries(result.metafile.outputs)) {
    if (!outputPath.endsWith('.js')) continue;
    rawBytes += outputMeta.bytes;
    const outputText = await readFile(outputPath, 'utf8');
    gzipBytes += gzipSizeForText(outputText);

    for (const [inputPath, inputMeta] of Object.entries(outputMeta.inputs)) {
      const bytesInOutput = inputMeta.bytesInOutput ?? 0;
      if (bytesInOutput <= 0) continue;
      packageBytes.set(
        classifyPackage(inputPath),
        (packageBytes.get(classifyPackage(inputPath)) ?? 0) + bytesInOutput
      );
      moduleBytes.set(
        inputPath,
        (moduleBytes.get(inputPath) ?? 0) + bytesInOutput
      );
    }
  }

  return {
    targetId: target.id,
    label: target.label,
    importPath: target.displayImportPath ?? target.importPath,
    rawBytes,
    rawKb: toKb(rawBytes),
    gzipBytes,
    gzipKb: toKb(gzipBytes),
    topPackages: sortContributions(packageBytes, 15),
    topModules: sortContributions(moduleBytes, 25),
  };
}

export function buildAnalysisMarkdown(rows: BundleAnalysisRow[]): string {
  const lines: string[] = [
    '# Bundle Analysis',
    '',
    'Module-level attribution for selected browser bundle targets. Byte counts are minified output contribution bytes from the esbuild metafile.',
    '',
  ];

  for (const row of rows) {
    lines.push(`## ${row.label} (\`${row.targetId}\`)`);
    lines.push('');
    lines.push(`- Import path: \`${row.importPath}\``);
    lines.push(`- Raw size: \`${row.rawKb} KB\``);
    lines.push(`- Gzip size: \`${row.gzipKb} KB\``);
    lines.push('');
    lines.push('### Top Packages');
    lines.push('');
    lines.push('| Package | KB | Bytes |');
    lines.push('| --- | ---: | ---: |');
    for (const item of row.topPackages) {
      lines.push(`| \`${item.key}\` | ${item.kb} | ${item.bytes} |`);
    }
    lines.push('');
    lines.push('### Top Modules');
    lines.push('');
    lines.push('| Module | KB | Bytes |');
    lines.push('| --- | ---: | ---: |');
    for (const item of row.topModules) {
      lines.push(`| \`${item.key}\` | ${item.kb} | ${item.bytes} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

async function main(): Promise<void> {
  const selectedTargets = resolveCliTargets();
  const rows: BundleAnalysisRow[] = [];
  for (const target of selectedTargets) {
    rows.push(await analyzeTarget(target));
  }

  const jsonPath = join(resultsRoot, 'BUNDLE_ANALYSIS.json');
  const markdownPath = join(resultsRoot, 'BUNDLE_ANALYSIS.md');
  await writeFile(jsonPath, `${JSON.stringify(rows, null, 2)}\n`, 'utf8');
  await writeFile(markdownPath, `${buildAnalysisMarkdown(rows)}\n`, 'utf8');
  console.log(buildAnalysisMarkdown(rows));
  await cleanupBundleTemp();
}

if (import.meta.main) {
  await main();
}
