import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { benchmarkRoot } from './paths.ts';
import { getStack } from './stacks.ts';
import type { JsonObject } from './types.ts';

export const powerSyncPreparationPolicy = 'replication-checkpoint-then-native-compaction-v1';
const records: JsonObject[] = [];
export function takePowerSyncPreparations(): JsonObject[] { return records.splice(0); }

/** Fixture maintenance, before any measured client is opened. Retains server volumes. */
export async function preparePowerSyncFixture(): Promise<void> {
  const { default: postgres } = await import('postgres');
  const record: JsonObject = { policy: powerSyncPreparationPolicy, startedAt: new Date().toISOString(), status: 'running' };
  records.push(record);
  const source = postgres(getStack('powersync').databaseUrl!, { max: 1, connect_timeout: 10 });
  const storage = postgres('postgres://bench:bench@localhost:55436/powersync_storage', { max: 1, connect_timeout: 10 });
  try {
    const [watermark] = await source`select pg_current_wal_lsn()::text as lsn`;
    record.sourceLsn = watermark!.lsn;
    // Trigger a commit beyond the watermark without changing fixture values.
    // Otherwise an idle stream may wait for its periodic keepalive checkpoint.
    const marker = await source`update organizations set name = name
      where id = (select id from organizations order by id limit 1) returning id`;
    if (marker.length !== 1) throw new Error('PowerSync fixture has no organization for its replication barrier');
    record.checkpointTrigger = { operation: 'no-op organization update', id: marker[0]!.id };
    const deadline = Date.now() + 120_000;
    for (;;) {
      // Storage schema belongs to the pinned self-hosted service (1.25.0).
      const rows = await storage`select id, snapshot_done, last_checkpoint_lsn,
        last_checkpoint_lsn::pg_lsn >= ${watermark!.lsn}::pg_lsn as caught_up,
        last_fatal_error from powersync.sync_rules where state = 'ACTIVE'`;
      if (rows.length !== 1) throw new Error(`Expected one active PowerSync sync rule set, found ${rows.length}`);
      const state = rows[0]!;
      if (state.last_fatal_error) throw new Error(`PowerSync replication failed: ${state.last_fatal_error}`);
      if (state.snapshot_done && state.caught_up) {
        record.ruleSetId = state.id; record.checkpointLsn = state.last_checkpoint_lsn;
        record.replicationReadyAt = new Date().toISOString(); break;
      }
      if (Date.now() >= deadline) throw new Error(`PowerSync fixture replication timed out at ${state.last_checkpoint_lsn}; expected ${watermark!.lsn}`);
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    // PowerSync documents compaction after large maintenance jobs. Fixture
    // TRUNCATE/reseed is such a job: otherwise every new client replays old runs.
    await promisify(execFile)('docker', ['compose', '-f', getStack('powersync').composeFile,
      'exec', '-T', 'powersync', 'node', 'service/lib/entry.js', 'compact'],
    { cwd: benchmarkRoot, timeout: 30 * 60_000, maxBuffer: 1024 * 1024 });
    record.status = 'completed';
  } catch (error) {
    record.status = 'failed'; record.error = String(error); throw error;
  } finally {
    record.finishedAt = new Date().toISOString();
    await Promise.all([source.end({ timeout: 2 }), storage.end({ timeout: 2 })]);
  }
}
