import { SignJWT } from 'jose';
import { Zero } from '@rocicorp/zero';
import { schema, queries } from '../../services/zero-bench-app/src/schema.ts';
import { taskRecord } from '../contracts/screens.ts';
import type { RecoveryClientConfig, RecoveryDriver } from '../recovery/protocol.ts';

export async function createZeroAccessDriver(config: RecoveryClientConfig): Promise<RecoveryDriver> {
  const auth = await new SignJWT({ bench_profile: 'access' }).setProtectedHeader({ alg: 'HS256' })
    .setSubject(config.actorId).setIssuedAt().setExpirationTime('10m').sign(new TextEncoder().encode('benchsecret'));
  const zero = new Zero<typeof schema, undefined, unknown>({ userID: config.actorId, auth, context: { userId: config.actorId }, cacheURL: config.syncBaseUrl,
    kvStore: 'mem', schema, storageKey: config.clientId, logLevel: 'error' });
  const view = zero.materialize(queries.access.tasks());
  const connections: Array<Record<string, unknown>> = [];
  let failure: Error | undefined, closed = false, queryState = 'unknown';
  let rejectFatal!: (error: Error) => void;
  const fatal = new Promise<never>((_, reject) => { rejectFatal = reject; }); void fatal.catch(() => {});
  const fail = (error: Error) => { failure = error; rejectFatal(error); };
  const unsubscribe = zero.connection.state.subscribe(state => {
    connections.push({ atMs: performance.now(), ...state }); if (connections.length > 100) connections.shift();
    if (state.name === 'error' || state.name === 'needs-auth') fail(new Error(`Zero access connection ${state.name}`));
  });
  const complete = new Promise<void>((resolve, reject) => view.addListener((_rows, state, error) => {
    queryState = state;
    if (state === 'complete') resolve();
    if (state === 'error') { const e = new Error(`Zero access query failed: ${JSON.stringify(error)}`); reject(e); fail(e); }
  })); void complete.catch(() => {});
  const check = () => { if (closed) throw new Error('Zero access client closed'); if (failure) throw failure; };
  const rows = async () => { check(); return (await zero.inspector.client.rows('tasks')).map(taskRecord).sort((a, b) => String(a.id).localeCompare(String(b.id))); };
  const unsupportedWrite = async () => { throw new Error('Access workload issues no client mutations'); };
  return {
    rows, count: async () => (await rows()).length, firstScreen: async () => [], pending: async () => 0,
    read: async () => ({ rows: await rows(), pending: 0, rejected: null, conflicts: null,
      nativeState: { accessCache: { kind: 'zero-memory', store: config.dbPath, nativeClientId: zero.clientID, storageKey: zero.storageKey, kvStore: 'mem',
        queryState, viewRows: JSON.parse(JSON.stringify(view.data.map(taskRecord))), rowSource: 'Zero.inspector.client.rows(tasks)', connections: JSON.parse(JSON.stringify(connections)) } } }),
    sync: async () => { check(); await Promise.race([complete, fatal]); check(); },
    probeSync: async () => { check(); await Promise.race([complete, fatal]); },
    write: unsupportedWrite, remove: unsupportedWrite,
    close: async () => { if (closed) return; closed = true; unsubscribe(); view.destroy(); await zero.close(); },
    diagnostics: { localStorage: 'zero-memory', persistence: 'no process durability', query: 'access.tasks: native membership existence relation',
      authorization: 'verified JWT subject and access-only grant; no globally scoped query or mutation under this grant',
      observation: 'native raw cached task rows plus materialized view; no application cache reset', nativeClientId: zero.clientID },
  };
}
