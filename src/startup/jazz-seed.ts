import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { benchmarkRoot } from '../paths.ts';
import type { JsonObject } from '../types.ts';

export function seedJazzStartup(count: number, directory: string): JsonObject {
  const datasetId = `startup-${count}-${randomUUID()}`;
  const run = spawnSync('node', ['src/adapters/jazz-v2-runner.ts', 'seed-startup', datasetId, directory, String(count)], {
    cwd: benchmarkRoot, encoding: 'utf8', timeout: 1_800_000, maxBuffer: 20 * 1024 * 1024,
  });
  if (run.status !== 0) throw new Error(`Jazz startup seeder failed: ${run.status}/${run.signal}\n${run.stdout}\n${run.stderr}`);
  const output = JSON.parse(run.stdout.trim().split('\n').at(-1)!);
  const receipt = output.metadata?.seedReceipt;
  if (output.status !== 'completed' || receipt?.pid !== run.pid || receipt.parentPid !== process.pid || receipt.datasetId !== datasetId || receipt.taskCount !== count) throw new Error('Jazz startup seeder receipt mismatch');
  return { ...receipt, exitCode: run.status, exitSignal: run.signal, exitedAt: new Date().toISOString(), exitObservedBeforeReaderSpawn: true };
}
