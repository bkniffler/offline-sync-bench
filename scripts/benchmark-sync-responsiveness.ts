/** Page responsiveness while a browser client bootstraps and catches up. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { cpus, platform, release, totalmem } from 'node:os';
import { median, shuffled } from '../src/statistics.ts';
import { buildStack, conditions, plan, prepareStack, responsivenessStacks, runTrial, RESPONSIVENESS_CONTRACT, type ResponsivenessStack } from '../src/responsiveness/run.ts';
import { renderResponsiveness } from '../src/responsiveness/report.ts';

const args = process.argv.slice(2);
const arg = (key: string) => args.includes(key) ? args[args.indexOf(key) + 1] : undefined;
const stacks = (arg('--stack')?.split(',') ?? [...responsivenessStacks]) as ResponsivenessStack[];
if (stacks.some(stack => !responsivenessStacks.includes(stack))) throw new Error(`Choose from ${responsivenessStacks.join(', ')}`);
const trials = Number(arg('--trials') ?? 3), selectedConditions = (arg('--conditions')?.split(',') ?? Object.keys(conditions)) as Array<keyof typeof conditions>, seed = Number(arg('--seed') ?? 20260925);
if (selectedConditions.some(id => !(id in conditions))) throw new Error(`Choose conditions from ${Object.keys(conditions).join(', ')}`);
if (arg('--rows') || arg('--catchup')) {
  if (!arg('--output')) throw new Error('Development sizes require a separate --output directory');
  plan.bootstrapRows = Number(arg('--rows') ?? plan.bootstrapRows); plan.catchUpRows = Number(arg('--catchup') ?? plan.catchUpRows);
}
const output = resolve(arg('--output') ?? `.results/sync-responsiveness-${new Date().toISOString().replaceAll(':', '-')}`);
const executable = process.env.BENCH_CHROMIUM ?? JSON.parse(await readFile('campaigns/browser-smoke.json', 'utf8')).runtime.executable;
await mkdir(output, { recursive: true });
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const sourceFiles = execFileSync('git', ['ls-files', '-co', '--exclude-standard', 'src/responsiveness', 'src/browser/process.ts', 'scripts/benchmark-sync-responsiveness.ts', 'stacks/syncular/syncular-app/src/admin.ts', 'package.json', 'bun.lock'], { encoding: 'utf8' }).trim().split('\n');
const source = await Promise.all(sourceFiles.map(async path => ({ path, sha256: sha(await readFile(path)) })));
const version = async (name: string) => JSON.parse(await readFile(`node_modules/${name}/package.json`, 'utf8')).version as string;
const report: any = {
  version: 1, kind: 'sync-responsiveness', contract: RESPONSIVENESS_CONTRACT, measuredAt: new Date().toISOString(), plan: { ...plan, trials, conditions: Object.fromEntries(selectedConditions.map(id => [id, conditions[id]])), seed, stacks,
    stoppingRule: 'Per stack: one discarded warm-up trial (default condition), then the declared trials per CPU condition in seeded random order. Preserve every failure; no retries.' },
  machine: { platform: platform(), release: release(), cpu: cpus()[0]?.model, cores: cpus().length, memoryBytes: totalmem(), bun: Bun.version, chromium: executable },
  versions: Object.fromEntries(await Promise.all(['@syncular/client', '@powersync/web', '@rocicorp/zero', '@electric-sql/client', '@tanstack/db', '@tanstack/electric-db-collection', '@tanstack/browser-db-sqlite-persistence'].map(async name => [name, await version(name)]))),
  source, trials: [],
};
const save = () => writeFile(join(output, 'RESULTS.json'), JSON.stringify(report, null, 2) + '\n');
await save();
let generation = Date.now() % 1_000_000;
for (const stack of stacks) {
  const folder = resolve('.tmp/sync-responsiveness', stack), workDir = resolve('.tmp/sync-responsiveness/profiles');
  await mkdir(workDir, { recursive: true });
  console.log(`[${stack}] build`); const bundle = await buildStack(stack, folder);
  console.log(`[${stack}] start and seed ${plan.bootstrapRows.toLocaleString()} tasks`);
  try { await prepareStack(stack); }
  catch (error) { report.trials.push({ stack, label: 'prepare', status: 'failed', error: String(error) }); await save(); console.log(`[${stack}] prepare failed: ${error}`); continue; }
  const schedule = [{ label: 'warmup', condition: 'default' as const }, ...shuffled(selectedConditions.flatMap(condition => Array.from({ length: trials }, (_, i) => ({ label: `trial-${i + 1}`, condition }))), seed + stacks.indexOf(stack))];
  for (const item of schedule) {
    console.log(`[${stack}] ${item.label} (${item.condition})`);
    const trial = await runTrial({ stack, condition: item.condition, executable, folder, workDir, generation: generation++, label: item.label });
    trial.bundle = bundle; report.trials.push(trial); await save();
    const w = trial.windows;
    console.log(trial.status === 'completed'
      ? `[${stack}] bootstrap ${Math.round(trial.milestones.bootstrapCompleteMs)} ms, input p95 ${w.bootstrap.input_latency_p95_ms} ms, blocking ${w.bootstrap.blocking_ms} ms; catch-up ${Math.round(trial.milestones.catchUpCompleteMs)} ms, input p95 ${w.catchup.input_latency_p95_ms} ms; idle input p95 ${w.idle.input_latency_p95_ms} ms`
      : `[${stack}] failed at ${trial.stage}: ${trial.error?.split('\n')[0]}`);
  }
}
for (const input of source) if (sha(await readFile(input.path)) !== input.sha256) throw new Error(`Source changed during collection: ${input.path}; do not publish this run`);
report.sourceUnchanged = true; report.finishedAt = new Date().toISOString();
await save();
await writeFile(join(output, 'SUMMARY.md'), renderResponsiveness(report, { median }));
console.log(`Saved ${join(output, 'RESULTS.json')}`);
