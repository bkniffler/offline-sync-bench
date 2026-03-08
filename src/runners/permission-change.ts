import { randomUUID } from 'node:crypto';
import type { BenchmarkAdapter, BenchmarkResult, BenchmarkRunContext } from '../types';

export async function runPermissionChangeScenario(
  context: BenchmarkRunContext,
  adapter: BenchmarkAdapter
): Promise<BenchmarkResult> {
  const startedAt = new Date();
  const result = await adapter.runPermissionChange();
  const finishedAt = new Date();

  return {
    runId: context.runId,
    resultId: randomUUID(),
    stackId: adapter.stack.id,
    scenarioId: 'permission-change',
    status: result.status,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    metrics: result.metrics,
    notes: result.notes,
    metadata: result.metadata,
  };
}
