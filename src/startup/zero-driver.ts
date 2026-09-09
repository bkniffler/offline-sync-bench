import { SignJWT } from 'jose';
import { Zero } from '@rocicorp/zero';
import { schema, queries } from '../../services/zero-bench-app/src/schema.ts';
import { screenOwnerId, screenProjectId, taskRecord } from '../contracts/screens.ts';
import type { RecoveryClientConfig, RecoveryDriver } from '../recovery/protocol.ts';

export async function createZeroStartupDriver(config: RecoveryClientConfig): Promise<RecoveryDriver> {
  const auth = await new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setIssuedAt()
    .setSubject(config.actorId).setExpirationTime('10m').sign(new TextEncoder().encode('benchsecret'));
  const zero = new Zero({ userID: config.actorId, auth, cacheURL: config.syncBaseUrl,
    kvStore: 'mem', logLevel: 'error', schema, storageKey: config.clientId });
  const all = zero.materialize(queries.tasks.all());
  const screen = zero.materialize(queries.tasks.startupScreen({ projectId: screenProjectId, ownerId: screenOwnerId }));
  const initialCache = { id: config.clientId, kind: 'memory', clientConstructed: true,
    rows: all.data.length, screenRows: screen.data.length, kvStore: 'mem', storageKey: zero.storageKey, nativeClientId: zero.clientID };
  let allState = 'unknown', screenState = 'unknown';
  const complete = Promise.all([
    new Promise<void>((resolve, reject) => all.addListener((_rows, state, error) => {
      allState = state; if (state === 'error') reject(new Error(`Zero full query failed: ${JSON.stringify(error)}`)); else if (state === 'complete') resolve();
    })),
    new Promise<void>((resolve, reject) => screen.addListener((_rows, state, error) => {
      screenState = state; if (state === 'error') reject(new Error(`Zero screen query failed: ${JSON.stringify(error)}`)); else if (state === 'complete') resolve();
    })),
  ]);
  // Observe failures through the shared sync call, even if a callback fires
  // before the controller has received the initialization event.
  void complete.catch(() => {});
  const readonly = async () => { throw new Error('The Zero startup driver is read-only'); };
  return {
    rows: async () => all.data.map(taskRecord),
    firstScreen: async () => screen.data.map(row => ({ id: row.id, title: row.title, completed: Number(row.completed) })),
    count: async () => all.data.length,
    pending: async () => 0,
    read: async () => ({ rows: all.data.map(taskRecord), pending: 0, rejected: null, conflicts: null,
      nativeState: { startupViews: { all: allState, screen: screenState, nativeClientId: zero.clientID } } }),
    sync: async () => { await complete; },
    write: readonly, remove: readonly, probeSync: readonly,
    close: async () => { all.destroy(); screen.destroy(); await zero.close(); },
    diagnostics: { localStorage: 'zero-memory', persistence: 'none; no process durability claim', initialCache,
      queryEngine: 'native Zero materialized full-task and filtered/ordered/limited screen queries',
      initialization: 'Zero client and both native views constructed; sync can begin during construction',
      subscriptionScope: ['tasks.all', 'tasks.startupScreen'], authorization: 'benchmark JWT and fixed task queries; no row-level authorization claim' },
  };
}
