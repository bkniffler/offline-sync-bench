import { randomUUID } from 'node:crypto';
import { ExternalResources } from '../resources.ts';
import { percentile } from '../metrics.ts';
import { ContractError, assertRows, taskRecord, fixtureTasks, type Row } from './screens.ts';
import type { JsonObject, SeedOptions } from '../types.ts';
export const COLLABORATION_CONTRACT = 'collaboration-v2';
export const collaborationWarmup = 5;
export const collaborationIterations = 50;
export const collaborationSeed: Required<SeedOptions> = { resetFirst: true, orgCount: 1, projectsPerOrg: 1, usersPerOrg: 2, tasksPerProject: 200, membershipsPerProject: 2 };
export interface WriteMilestones { localCommitted(): void; serverAccepted(): void }
export interface CollaborationDriver {
  write(title: string, milestones: WriteMilestones, signal: AbortSignal): Promise<void>;
  observe(title: string, signal: AbortSignal): Promise<void>;
  readData(): Promise<Row[]> | Row[];
  localCommit: boolean;
  diagnostics: JsonObject;
}
export async function pollUntil(predicate: () => Promise<boolean> | boolean, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  throw signal.reason ?? new Error('Observation aborted');
}
export async function measureCollaboration(driver: CollaborationDriver) {
  const initialRows = (await driver.readData()).map(taskRecord).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const initialDigest = assertRows('collaboration reader tasks', initialRows, fixtureTasks(collaborationSeed));
  initialRows.length = 0;
  const resources = new ExternalResources();
  await resources.start();
  const samples: Array<{ iteration: number; title: string; localCommitMs: number | null; serverAcceptedMs: number; mirrorVisibleMs: number }> = [];
  try {
    for (let iteration = -collaborationWarmup; iteration < collaborationIterations; iteration++) {
      const title = `collaboration-${randomUUID()}`;
      const controller = new AbortController();
      let rejectDeadline!: (error: Error) => void;
      const deadline = new Promise<never>((_, reject) => { rejectDeadline = reject; });
      const timer = setTimeout(() => { const error = new Error('Collaboration observation timed out after 30s'); controller.abort(error); rejectDeadline(error); }, 30_000);
      let local: number | null = null, accepted: number | null = null, visible: number | null = null;
      const started = performance.now();
      // Capture visibility in its own completion handler; writer acknowledgment may arrive later.
      const observation = driver.observe(title, controller.signal).then(() => { visible = performance.now() - started; });
      const write = driver.write(title, { localCommitted: () => { local ??= performance.now() - started; }, serverAccepted: () => { accepted ??= performance.now() - started; } }, controller.signal);
      try {
        await Promise.race([Promise.all([observation, write]), deadline]);
        if (accepted === null || visible === null || (driver.localCommit && local === null)) throw new ContractError('Collaboration milestone missing');
        if (iteration >= 0) samples.push({ iteration, title, localCommitMs: local, serverAcceptedMs: accepted, mirrorVisibleMs: visible });
      } finally { clearTimeout(timer); controller.abort(new Error('Sample complete')); }
    }
    const usage = await resources.stop();
    const metrics: Record<string, number | null> = { ...usage.metrics, iterations: collaborationIterations, warmup_iterations: collaborationWarmup };
    for (const [name, values] of [
      ['local_commit', samples.map(s => s.localCommitMs)],
      ['server_accepted', samples.map(s => s.serverAcceptedMs)],
      ['mirror_visible', samples.map(s => s.mirrorVisibleMs)],
    ] as const) {
      metrics[`${name}_p50_ms`] = values.every(v => v !== null) ? percentile(values as number[], 50) : null;
      metrics[`${name}_p95_ms`] = values.every(v => v !== null) ? percentile(values as number[], 95) : null;
    }
    return { metrics, metadata: { workloadContract: COLLABORATION_CONTRACT, validation: { taskCount: 200, tasksDigest: initialDigest }, fixture: collaborationSeed, samples, resources: usage.metadata, diagnostics: driver.diagnostics, localCommitAvailable: driver.localCommit }, notes: ['Five warmups and 50 measured writes. Local commit, client-observed server acceptance, and independent reader visibility are separate milestones; no p99 is reported.', 'Visibility is observed independently of writer completion. Local-query polling uses a 1ms scheduling interval; transport and runtime work can increase observation delay.'] };
  } finally { resources.abort(); }
}
