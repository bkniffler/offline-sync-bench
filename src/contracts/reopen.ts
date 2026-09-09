import { arrayScreenQuery, assertRows, ContractError, fixtureTasks, hash } from './screens.ts';
import { recoverySeed } from './recovery.ts';
import { validateOutage } from './outage.ts';
import type { BenchmarkResult, JsonObject } from '../types.ts';

export const REOPEN_CONTRACT = 'persisted-replica-reopen-v1';
export const reopenProfile = { client: 'fresh-process', storage: 'existing-product-file', network: 'blocked-before-reopen', osFileCache: 'not-cleared-after-bootstrap', pendingWrites: 'empty' };
export function validateReopenResult(result: Pick<BenchmarkResult, 'scenarioId' | 'metrics' | 'metadata'> & Partial<Pick<BenchmarkResult, 'stackId'>>): void {
  const { metadata, metrics } = result;
  if (result.scenarioId !== 'replica-reopen' || metadata.workloadContract !== REOPEN_CONTRACT || hash(metadata.fixture) !== hash(recoverySeed) || hash(metadata.reopenProfile) !== hash(reopenProfile)) throw new ContractError('Replica reopen contract mismatch');
  const rows = fixtureTasks(recoverySeed), digest = assertRows('expected', rows, rows);
  const screen = arrayScreenQuery('list', { tasks: rows });
  const validation = metadata.validation as JsonObject;
  if (validation?.initialDigest !== digest || validation.reopenedDigest !== digest || validation.screenDigest !== assertRows('screen', screen, screen) || validation.taskCount !== 2_000 || validation.pendingAfter !== 0) throw new ContractError('Replica reopen data proof missing');
  const process = metadata.process as JsonObject;
  if (!Number.isSafeInteger(process?.oldPid) || Number(process.oldPid) < 1 || !Number.isSafeInteger(process.newPid) || Number(process.newPid) < 1 || process.oldPid === process.newPid || process.sameProductStore !== true || process.productClosedBeforeReopen !== true) throw new ContractError('Replica reopen requires a new process and the persisted product store');
  if (result.stackId === 'electric-tanstack' || result.stackId === 'jazz-v2') {
    const proof = metadata.replicaPersistence as JsonObject, diagnostics = metadata.diagnostics as JsonObject;
    if (!proof || typeof proof.store !== 'string' || proof.existsBeforeReopen !== true || typeof proof.bytesBeforeReopen !== 'number' || proof.bytesBeforeReopen < 1) throw new ContractError('Reopen product file proof missing');
    const initial = proof.initialDiagnostics as JsonObject;
    if (result.stackId === 'electric-tanstack') {
      const before = initial?.initialCache as JsonObject, after = diagnostics?.initialCache as JsonObject;
      const native = ((proof.reopenedState as JsonObject)?.startupPersistence as JsonObject)?.snapshot as JsonObject;
      if (before?.activeRows !== 0 || before.persistedRows !== 0 || after?.activeRows !== 0 || after.persistedRows !== 2_000 || before.collectionId !== after.collectionId || typeof before.collectionId !== 'string' || before.store !== proof.store || after.store !== proof.store || proof.persistedInitialDigest !== digest || proof.persistedReopenedDigest !== digest || native?.method !== 'native-sqlite-adapter-scanRows' || native.activeRows !== 2_000 || native.persistedRows !== 2_000 || native.store !== proof.store || native.collectionId !== after.collectionId) throw new ContractError('TanStack native replica restoration proof missing');
    } else {
      const seed = proof.seeding as JsonObject, before = initial?.reader as JsonObject, after = diagnostics?.reader as JsonObject;
      const bootstrap = (proof.initialState as JsonObject)?.startupQuery as JsonObject, reopened = (proof.reopenedState as JsonObject)?.startupQuery as JsonObject;
      const screen = ((proof.reopenedState as JsonObject)?.screenSubscription as JsonObject), initialScreen = diagnostics?.screenObservation as JsonObject;
      if (screen?.method !== 'native-sdk-subscription-manager-v1' || screen.initialScreenRows !== 50 || screen.initialQueries !== 1 || screen.subscriptions !== 1 || screen.rows !== 50 || !Number.isSafeInteger(screen.screenReads) || Number(screen.screenReads) < 1 || initialScreen?.method !== screen.method || initialScreen.initialScreenRows !== 50 || initialScreen.initialQueries !== 1 || initialScreen.subscriptions !== 1) throw new ContractError('Jazz reopened native screen subscription proof missing');

      if (!Number.isSafeInteger(seed?.pid) || Number(seed.pid) < 1 || [process.oldPid, process.newPid].includes(seed.pid) || seed.taskCount !== 2_000 || seed.tasksDigest !== digest || seed.edgeDurable !== true || seed.exitCode !== 0 || seed.exitSignal !== null || seed.exitObservedBeforeReaderSpawn !== true || seed.store === proof.store || typeof seed.datasetId !== 'string' || !seed.datasetId.startsWith('startup-2000-') || before?.datasetId !== seed.datasetId || after?.datasetId !== seed.datasetId || before.pid !== process.oldPid || after.pid !== process.newPid || before.store !== proof.store || after.store !== proof.store || before.initialRows !== 0 || after.initialRows !== 2_000 || before.transportConnected !== false || after.transportConnected !== false || bootstrap?.edgeComplete !== true || bootstrap.edgeRows !== 2_000 || reopened?.edgeComplete !== false || reopened.edgeRows !== null) throw new ContractError('Jazz native replica restoration proof missing');
    }
  }
  const outage = metadata.outage as JsonObject, before = outage?.before as JsonObject, after = outage?.after as JsonObject;
  validateOutage(before, after);
  if (after.responseBytes !== before.responseBytes) throw new ContractError('Replica reopen received network data');
  let previous = 0;
  for (const name of ['reopen_process_ms', 'reopen_first_screen_ms', 'reopen_all_rows_ms']) {
    const value = metrics[name];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < previous) throw new ContractError('Missing or out-of-order replica reopen milestone');
    previous = value;
  }
  const resources = metadata.resources as JsonObject;
  if (resources?.method !== 'external-ps-process-tree-v1' || resources.includeRoot !== false || !Array.isArray(resources.samples) || resources.samples.length < 2) throw new ContractError('Replica reopen resource samples missing');
}
