import { createZeroSQLiteStore } from './zero-sqlite-store.ts';
import { matchingDeliveryRows, pollDelivery } from '../fanout/observe.ts';
import { SignJWT } from 'jose';
import { Zero, type MutatorResult } from '@rocicorp/zero';
import { schema, queries } from '../../services/zero-bench-app/src/schema.ts';
import { mutators } from '../../services/zero-bench-app/src/mutators.ts';
import { screenOwnerId, screenProjectId, taskRecord } from '../contracts/screens.ts';
import type { JsonObject } from '../types.ts';
import type { RecoveryClientConfig, RecoveryDriver } from './protocol.ts';

type Status = 'pending' | 'success' | 'error';
type Receipt = { taskId: string; client: Status; server: Status };
export async function createZeroRecoveryDriver(config: RecoveryClientConfig): Promise<RecoveryDriver> {
  if (config.reopen && !config.persistentZero) throw new Error('The Zero memory profile cannot reopen a process-persistent replica or queue');
  const auth = await new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setIssuedAt()
    .setSubject(config.actorId).setExpirationTime('10m').sign(new TextEncoder().encode('benchsecret'));
  const zero = new Zero({ userID: config.actorId, auth, cacheURL: config.syncBaseUrl,
    kvStore: config.persistentZero ? createZeroSQLiteStore(config.dbPath) : 'mem', logLevel: 'error', schema, mutators, storageKey: config.clientId });
  const all = zero.materialize(queries.tasks.all());
  const screen = zero.materialize(queries.tasks.startupScreen({ projectId: screenProjectId, ownerId: screenOwnerId }));
  const initialized = performance.now();
  const initialCache = { id: config.clientId, nativeClientId: zero.clientID, storageKey: zero.storageKey, kvStore: config.persistentZero ? 'native-sqlite-store' : 'mem', rows: all.data.length };
  const delivery = { method: 'zero-native-materialized-stream', connects: 0, pauses: 0, observations: 0 };
  const receipts: Receipt[] = [], errors: JsonObject[] = [], connections: JsonObject[] = [], rounds: JsonObject[] = [];
  const serverWaiters: Promise<void>[] = [];
  let allState = 'unknown', screenState = 'unknown', wrote = false, closed = false;
  const state = (): JsonObject => ({ ...(config.fanout ? { delivery: { ...delivery } } : {}), method: 'native-mutation-promises-v1', nativeQueueCount: null,
    nativeClientId: zero.clientID, storageKey: zero.storageKey, kvStore: config.persistentZero ? 'native-sqlite-store' : 'mem',
    acceptedLocalTaskIds: receipts.filter(r => r.client === 'success').map(r => r.taskId).sort(),
    pendingTaskIds: receipts.filter(r => r.server === 'pending').map(r => r.taskId).sort(),
    receipts: receipts.map(r => ({ ...r })), mutationErrors: [...errors],
    views: { all: allState, screen: screenState }, connection: { ...zero.connection.state.current }, connections: [...connections], syncRounds: [...rounds] });
  const fault = (message: string) => Object.assign(new Error(message), { evidence: { zeroRecovery: state() } });
  let rejectFatal!: (error: Error) => void;
  const fatal = new Promise<never>((_, reject) => { rejectFatal = reject; }); void fatal.catch(() => {});
  const unsubscribe = zero.connection.state.subscribe(value => {
    connections.push({ atMs: performance.now() - initialized, ...value });
    if (connections.length > 100) connections.shift();
    if (value.name === 'error' || value.name === 'needs-auth') rejectFatal(fault(`Zero connection entered ${value.name}`));
  });
  const complete = Promise.all([
    new Promise<void>((resolve, reject) => all.addListener((_rows, value, error) => {
      allState = value;
      if (value === 'error') { const failure = fault(`Zero full query failed: ${JSON.stringify(error)}`); reject(failure); rejectFatal(failure); }
      else if (value === 'complete') resolve();
    })),
    new Promise<void>((resolve, reject) => screen.addListener((_rows, value, error) => {
      screenState = value;
      if (value === 'error') { const failure = fault(`Zero screen query failed: ${JSON.stringify(error)}`); reject(failure); rejectFatal(failure); }
      else if (value === 'complete') resolve();
    })),
  ]); void complete.catch(() => {});
  const check = () => { if (closed) throw fault('Zero recovery client is closed'); if (errors.length) throw fault('Zero native mutation failed'); };
  const recordMutation = (taskId: string, result: MutatorResult) => {
    const receipt: Receipt = { taskId, client: 'pending', server: 'pending' }; receipts.push(receipt);
    const settle = async (phase: 'client' | 'server') => {
      try {
        const outcome = await result[phase]; receipt[phase] = outcome.type;
        if (outcome.type !== 'success') { errors.push({ taskId, phase, error: JSON.parse(JSON.stringify(outcome.error)) }); throw fault(`Zero ${phase} mutation rejected`); }
      } catch (error) {
        if (receipt[phase] === 'pending') { receipt[phase] = 'error'; errors.push({ taskId, phase, error: String(error) }); }
        throw fault(`Zero ${phase} mutation failed: ${String(error)}`);
      }
    };
    const server = settle('server'); void server.catch(() => {}); serverWaiters.push(server);
    return settle('client');
  };
  if (config.reopen) {
    const deadline = performance.now() + 30_000;
    while (!all.data.length || !screen.data.length) {
      if (performance.now() >= deadline) throw fault('Zero persistent local hydration timed out');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }
  return {
    rows: async () => all.data.map(taskRecord),
    firstScreen: async () => screen.data.map(row => ({ id: row.id, title: row.title, completed: Number(row.completed) })),
    count: async () => all.data.length,
    pending: async () => receipts.filter(r => r.server === 'pending').length,
    read: async () => ({ rows: all.data.map(taskRecord), pending: receipts.filter(r => r.server === 'pending').length,
      rejected: errors.length, conflicts: null, nativeState: state() }),
    write: async mutations => {
      check(); if (wrote && !config.fanout) throw fault('One recovery write group is allowed per fresh Zero client'); wrote = true;
      const localWaiters = mutations.map(mutation => {
        const request = { id: mutation.id, title: mutation.title };
        return recordMutation(mutation.id, zero.mutate(config.conflicts ? mutators.tasks.update(request) : mutators.tasks.recoveryUpdate(request)));
      });
      await Promise.all(localWaiters); check();
    },
    remove: async id => { check(); if (!config.conflicts || wrote) throw fault('Zero delete requires a fresh conflict peer'); wrote = true; await recordMutation(id, zero.mutate(mutators.tasks.remove({ id }))); check(); },
    sync: async () => {
      check(); const startMs = performance.now() - initialized, pendingBefore = receipts.filter(r => r.server === 'pending').length;
      // The public connect() resumes auth/error states, not ordinary outages.
      // Zero's existing transport retries replay the native mutation queue.
      await Promise.race([Promise.all([complete, ...serverWaiters]), fatal]); check();
      rounds.push({ startMs, endMs: performance.now() - initialized, pendingBefore, pendingAfter: receipts.filter(r => r.server === 'pending').length });
    },
    ...(config.fanout ? {
      connectDelivery: async () => { await Promise.race([complete, fatal]); check(); delivery.connects++; },
      pauseDelivery: async () => { delivery.pauses++; }, // The TCP gate owns the outage; SDK retries stay native.
      observeDelivery: async expected => { delivery.observations++; await pollDelivery(expected, async () => { check(); return matchingDeliveryRows(expected, all.data); }); },
    } : {}),
    probeSync: async () => {
      check();
      // Observe the SDK's five-second retry schedule. The controller requires
      // actual rejected connections at the gate and unchanged remote data.
      await Promise.race([new Promise(resolve => setTimeout(resolve, 11_000)), fatal]); check();
    },
    close: async () => { if (closed) return; closed = true; unsubscribe(); await zero.close(); all.destroy(); screen.destroy(); },
    diagnostics: { localStorage: config.persistentZero ? 'zero-native-sqlite-store' : 'zero-memory', persistence: config.persistentZero ? 'Zero native persistent DAG, indexes and SQLiteStore through a Bun SQLite platform delegate, WAL with synchronous FULL' : 'none; no process durability claim', initialCache,
      ...(config.conflicts ? { conflictWritePath: 'existing tasks.update: title-only patch, absent row ignored; tasks.remove: native keyed delete; server_version remains unchanged' } : {}),
      outbox: config.persistentZero ? 'Zero owns mutation log and replay in its native DAG; this reopen case has no pending writes' : 'native Zero mutations in a live memory-backed client; no harness replay or persistent outbox',
      pendingObservation: 'issued native mutation.server promises not yet settled; aggregate native queue counter unavailable',
      localCommit: 'successful mutation.client receipt', serverAcceptance: 'successful mutation.server receipt',
      sync: 'native materialized queries and mutation receipts; SDK transport owns reconnect timing',
      initialization: 'native client and views constructed; sync can begin during construction',
      authorization: 'benchmark JWT and fixed task mutators/queries; no row-level authorization claim' },
  };
}
