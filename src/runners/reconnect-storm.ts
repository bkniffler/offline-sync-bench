import { randomUUID } from 'node:crypto';
import type { BenchmarkAdapter, BenchmarkResult, BenchmarkRunContext } from '../types';

export async function runReconnectStormScenario(
  context: BenchmarkRunContext,
  adapter: BenchmarkAdapter
): Promise<BenchmarkResult> {
  const startedAt = new Date();
  const result = await adapter.runReconnectStorm();
  const finishedAt = new Date();

  return {
    runId: context.runId,
    resultId: randomUUID(),
    stackId: adapter.stack.id,
    scenarioId: 'reconnect-storm',
    status: result.status,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    metrics: result.metrics,
    notes: result.notes,
    metadata: result.metadata,
  };
}
