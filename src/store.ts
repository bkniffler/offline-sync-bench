import { Database } from 'bun:sqlite';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getMethodologyManifest } from './methodology';
import { catalogPath, resultsRoot, toBenchmarkRelativePath } from './paths';
import { getStack } from './stacks';
import type { BenchmarkResult, BenchmarkRunContext, JsonObject } from './types';

interface SummaryRow {
  runId: string;
  stackId: string;
  scenarioId: string;
  status: string;
  supportLevel: string;
  framework: string;
  frameworkVersion: string;
  implementation: string;
  durationMs: number;
  startedAt: string;
  finishedAt: string;
  filePath: string;
  metrics: Record<string, number | null>;
}

function createCatalog(): Database {
  const db = new Database(catalogPath, { create: true });
  db.exec('pragma busy_timeout = 5000');
  const journalModeRow = db
    .query<{
      journal_mode: string;
    }, []>('pragma journal_mode')
    .get();
  if (journalModeRow?.journal_mode?.toLowerCase() !== 'wal') {
    db.query('pragma journal_mode = wal').get();
  }
  db.run(`
    create table if not exists runs (
      run_id text primary key,
      run_dir text not null,
      created_at text not null
    )
  `);
  db.run(`
    create table if not exists results (
      result_id text primary key,
      run_id text not null references runs(run_id) on delete cascade,
      stack_id text not null,
      scenario_id text not null,
      status text not null,
      duration_ms real not null,
      started_at text not null,
      finished_at text not null,
      file_path text not null,
      metrics_json text not null,
      notes_json text not null,
      metadata_json text not null
    )
  `);
  return db;
}

export async function createRunContext(): Promise<BenchmarkRunContext> {
  const baseTimestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const db = createCatalog();

  try {
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      const runId =
        attempt === 0 ? baseTimestamp : `${baseTimestamp}-${attempt}`;
      const runDir = join(resultsRoot, runId);
      await mkdir(runDir, { recursive: true });

      try {
        db.run(
          `
            insert into runs (run_id, run_dir, created_at)
            values (?, ?, ?)
          `,
          [runId, toBenchmarkRelativePath(runDir), new Date().toISOString()]
        );

        return {
          runId,
          runDir,
        };
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes('UNIQUE constraint failed: runs.run_id')
        ) {
          continue;
        }
        throw error;
      }
    }
  } finally {
    db.close();
  }

  throw new Error('Unable to allocate a unique benchmark run id');
}

export async function saveResult(
  context: BenchmarkRunContext,
  result: BenchmarkResult
): Promise<string> {
  const scenarioDir = join(context.runDir, result.stackId);
  await mkdir(scenarioDir, { recursive: true });
  const absoluteFilePath = join(scenarioDir, `${result.scenarioId}.json`);

  await writeFile(absoluteFilePath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');

  const db = createCatalog();
  db.run(
    `
      insert into results (
        result_id,
        run_id,
        stack_id,
        scenario_id,
        status,
        duration_ms,
        started_at,
        finished_at,
        file_path,
        metrics_json,
        notes_json,
        metadata_json
      )
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      result.resultId,
      result.runId,
      result.stackId,
      result.scenarioId,
      result.status,
      result.durationMs,
      result.startedAt,
      result.finishedAt,
      toBenchmarkRelativePath(absoluteFilePath),
      JSON.stringify(result.metrics),
      JSON.stringify(result.notes),
      JSON.stringify(result.metadata),
    ]
  );
  db.close();

  return toBenchmarkRelativePath(absoluteFilePath);
}

export async function writeSummary(
  context: BenchmarkRunContext,
  results: BenchmarkResult[]
): Promise<string> {
  const filePath = join(context.runDir, 'SUMMARY.md');
  const summaryRows = results.map((result) => createSummaryRow(context, result));
  const markdownLines = [
    '# Benchmark Summary',
    '',
    `Run ID: \`${context.runId}\``,
    '',
    '| Stack | Scenario | Status | Support | Duration (ms) | Framework version | Key metrics |',
    '| --- | --- | --- | --- | ---: | --- | --- |',
    ...summaryRows.map((row) => {
      const metricSummary = Object.entries(row.metrics)
        .map(([key, value]) => `${key}=${value ?? 'n/a'}`)
        .join(', ');
      return `| ${row.stackId} | ${row.scenarioId} | ${row.status} | ${row.supportLevel} | ${row.durationMs} | ${row.frameworkVersion} | ${metricSummary} |`;
    }),
    '',
  ];

  const jsonSummary = {
    runId: context.runId,
    generatedAt: new Date().toISOString(),
    benchmarkEnvironment: summaryRows[0]
      ? extractJsonObject(results[0]?.metadata.benchmarkEnvironment)
      : null,
    methodology: getMethodologyManifest(),
    results: summaryRows,
  };
  const runManifest = {
    runId: context.runId,
    generatedAt: new Date().toISOString(),
    benchmarkEnvironment: summaryRows[0]
      ? extractJsonObject(results[0]?.metadata.benchmarkEnvironment)
      : null,
    methodology: getMethodologyManifest(),
  };
  const csvSummary = buildCsvSummary(summaryRows);

  await writeFile(filePath, `${markdownLines.join('\n')}\n`, 'utf8');
  await writeFile(
    join(context.runDir, 'SUMMARY.json'),
    `${JSON.stringify(jsonSummary, null, 2)}\n`,
    'utf8'
  );
  await writeFile(
    join(context.runDir, 'RUN_MANIFEST.json'),
    `${JSON.stringify(runManifest, null, 2)}\n`,
    'utf8'
  );
  await writeFile(join(context.runDir, 'SUMMARY.csv'), csvSummary, 'utf8');
  await writeFile(join(resultsRoot, 'LATEST.md'), `${markdownLines.join('\n')}\n`, 'utf8');
  await writeFile(
    join(resultsRoot, 'LATEST.json'),
    `${JSON.stringify(jsonSummary, null, 2)}\n`,
    'utf8'
  );
  await writeFile(
    join(resultsRoot, 'LATEST_MANIFEST.json'),
    `${JSON.stringify(runManifest, null, 2)}\n`,
    'utf8'
  );
  await writeFile(join(resultsRoot, 'LATEST.csv'), csvSummary, 'utf8');

  return toBenchmarkRelativePath(filePath);
}

function createSummaryRow(
  context: BenchmarkRunContext,
  result: BenchmarkResult
): SummaryRow {
  const filePath = toBenchmarkRelativePath(
    join(context.runDir, result.stackId, `${result.scenarioId}.json`)
  );
  const stack = getStack(result.stackId);
  return {
    runId: result.runId,
    stackId: result.stackId,
    scenarioId: result.scenarioId,
    status: result.status,
    supportLevel:
      getMetadataString(result.metadata, 'supportLevel') ??
      getSupportLevel(result),
    framework: getMetadataString(result.metadata, 'framework') ?? stack.title,
    frameworkVersion:
      getMetadataString(result.metadata, 'frameworkVersion') ??
      getMetadataString(result.metadata, 'productVersion') ??
      'unknown',
    implementation: getMetadataString(result.metadata, 'implementation') ?? 'unknown',
    durationMs: result.durationMs,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    filePath,
    metrics: result.metrics,
  };
}

function getSupportLevel(result: BenchmarkResult): string {
  const capabilities = getStack(result.stackId).capabilities;

  switch (result.scenarioId) {
    case 'bootstrap':
      return capabilities.bootstrap;
    case 'online-propagation':
      return capabilities.onlinePropagation;
    case 'offline-replay':
      return capabilities.offlineReplay;
    case 'reconnect-storm':
      return capabilities.reconnectStorm;
    case 'large-offline-queue':
      return capabilities.largeOfflineQueue;
    case 'local-query':
      return capabilities.localQuery;
    case 'deep-relationship-query':
      return capabilities.deepRelationshipQuery;
    case 'permission-change':
      return capabilities.permissionChange;
    case 'blob-flow':
      return capabilities.blobFlow;
  }
}

function getMetadataString(metadata: JsonObject, key: string): string | null {
  const value = metadata[key];
  return typeof value === 'string' ? value : null;
}

function extractJsonObject(value: JsonObject[keyof JsonObject] | undefined): JsonObject | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value;
  }
  return null;
}

function buildCsvSummary(rows: SummaryRow[]): string {
  const metricKeys = Array.from(
    new Set(rows.flatMap((row) => Object.keys(row.metrics)))
  ).sort();
  const lines = [
    [
      'run_id',
      'stack_id',
      'scenario_id',
      'status',
      'support_level',
      'framework',
      'framework_version',
      'implementation',
      'duration_ms',
      'started_at',
      'finished_at',
      'file_path',
      ...metricKeys,
    ].join(','),
  ];

  for (const row of rows) {
    lines.push(
      [
        row.runId,
        row.stackId,
        row.scenarioId,
        row.status,
        row.supportLevel,
        row.framework,
        row.frameworkVersion,
        row.implementation,
        String(row.durationMs),
        row.startedAt,
        row.finishedAt,
        row.filePath,
        ...metricKeys.map((metricKey) => {
          const value = row.metrics[metricKey];
          return value === null || value === undefined ? '' : String(value);
        }),
      ]
        .map(escapeCsvValue)
        .join(',')
    );
  }

  return `${lines.join('\n')}\n`;
}

function escapeCsvValue(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}
