import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { sha256 } from '../source-snapshot.ts';
import { runLoadedBrowserCondition } from './loaded-run.ts';

// Invoked only by the diagnostic parent, in a fresh owned process group.
if (import.meta.main) {
  const [inputPath, outputPath] = process.argv.slice(2);
  if (!inputPath || !outputPath) throw new Error('Use loaded-trial.ts INPUT.json OUTPUT.json');
  const bytes = await readFile(inputPath), input = JSON.parse(bytes.toString());
  const startedAt = new Date().toISOString(), started = performance.now();
  const result: any = { version: 1, runId: input.runId, resultId: randomUUID(), entry: input.entry,
    inputSha256: sha256(bytes), startedAt, status: 'failed' };
  try {
    result.evidence = await runLoadedBrowserCondition(input.entry.stackId, input.entry.mode, input.runtime, input.browser, input.bundlePath);
    result.status = 'completed';
  } catch (error) {
    result.error = String(error); result.evidence = (error as any)?.evidence ?? null;
  }
  result.finishedAt = new Date().toISOString(); result.durationMs = performance.now() - started;
  await writeFile(outputPath, JSON.stringify(result, null, 2) + '\n');
  process.exit(result.status === 'completed' ? 0 : 1);
}
