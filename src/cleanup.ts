import { Database } from 'bun:sqlite';
import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { catalogPath, resultsRoot, tempRoot } from './paths';

const DEFAULT_FAILED_RUN_RETENTION_HOURS = 12;
const DEFAULT_TMP_RETENTION_HOURS = 24;

interface CleanupCandidate {
  runId: string;
  runDir: string;
  statuses: string[];
  newestMtimeMs: number;
}

export interface CleanupSummary {
  removedRunIds: string[];
  removedTmpEntries: string[];
}

function parseBooleanFlag(flag: string): boolean {
  return Bun.argv.includes(flag);
}

function parseNumericFlag(flag: string, fallback: number): number {
  const index = Bun.argv.indexOf(flag);
  if (index === -1) return fallback;
  const raw = Bun.argv[index + 1];
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function collectRunCandidates(): Promise<CleanupCandidate[]> {
  const entries = await readdir(resultsRoot, { withFileTypes: true });
  const candidates: CleanupCandidate[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const runId = entry.name;
    const runDir = join(resultsRoot, runId);
    const stackEntries = await readdir(runDir, { withFileTypes: true });
    const statuses: string[] = [];
    let newestMtimeMs = 0;

    for (const stackEntry of stackEntries) {
      if (!stackEntry.isDirectory()) continue;
      const stackDir = join(runDir, stackEntry.name);
      const scenarioEntries = await readdir(stackDir, { withFileTypes: true });

      for (const scenarioEntry of scenarioEntries) {
        if (!scenarioEntry.isFile() || !scenarioEntry.name.endsWith('.json')) {
          continue;
        }

        const filePath = join(stackDir, scenarioEntry.name);
        const fileStats = await stat(filePath);
        newestMtimeMs = Math.max(newestMtimeMs, fileStats.mtimeMs);

        try {
          const parsed = JSON.parse(await readFile(filePath, 'utf8')) as {
            status?: string;
          };
          if (typeof parsed.status === 'string') {
            statuses.push(parsed.status);
          }
        } catch {
          statuses.push('unreadable');
        }
      }
    }

    candidates.push({
      runId,
      runDir,
      statuses,
      newestMtimeMs,
    });
  }

  return candidates;
}

async function collectTmpEntries(args: {
  olderThanMs: number;
}): Promise<string[]> {
  const entries = await readdir(tempRoot, { withFileTypes: true }).catch(
    () => []
  );
  const removable: string[] = [];

  for (const entry of entries) {
    const fullPath = join(tempRoot, entry.name);
    const entryStats = await stat(fullPath).catch(() => null);
    if (!entryStats) continue;
    if (entryStats.mtimeMs >= args.olderThanMs) continue;
    removable.push(fullPath);
  }

  return removable;
}

function removeRunsFromCatalog(runIds: readonly string[]): void {
  if (runIds.length === 0) return;
  const db = new Database(catalogPath, { create: true });
  try {
    for (const runId of runIds) {
      db.run('delete from results where run_id = ?', [runId]);
      db.run('delete from runs where run_id = ?', [runId]);
    }
  } finally {
    db.close();
  }
}

export async function cleanupBenchmarkArtifacts(): Promise<CleanupSummary> {
  const dryRun = parseBooleanFlag('--dry-run');
  const failedRunRetentionHours = parseNumericFlag(
    '--failed-run-hours',
    DEFAULT_FAILED_RUN_RETENTION_HOURS
  );
  const tmpRetentionHours = parseNumericFlag(
    '--tmp-hours',
    DEFAULT_TMP_RETENTION_HOURS
  );
  const now = Date.now();
  const failedRunCutoffMs = now - failedRunRetentionHours * 60 * 60 * 1000;
  const tmpCutoffMs = now - tmpRetentionHours * 60 * 60 * 1000;

  const runCandidates = await collectRunCandidates();
  const staleFailedRuns = runCandidates.filter((candidate) => {
    if (candidate.statuses.length === 0) return candidate.newestMtimeMs < failedRunCutoffMs;
    if (candidate.statuses.some((status) => status === 'completed')) {
      return false;
    }
    return candidate.newestMtimeMs < failedRunCutoffMs;
  });
  const tmpEntries = await collectTmpEntries({ olderThanMs: tmpCutoffMs });

  if (!dryRun) {
    for (const candidate of staleFailedRuns) {
      await rm(candidate.runDir, { recursive: true, force: true });
    }
    removeRunsFromCatalog(staleFailedRuns.map((candidate) => candidate.runId));
    for (const entry of tmpEntries) {
      await rm(entry, { recursive: true, force: true });
    }
  }

  return {
    removedRunIds: staleFailedRuns.map((candidate) => candidate.runId),
    removedTmpEntries: tmpEntries,
  };
}
