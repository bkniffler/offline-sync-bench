import { Zero } from '@rocicorp/zero';
import { schema, queries } from '../../../services/zero-bench-app/src/schema.ts';
import { mutators } from '../../../services/zero-bench-app/src/mutators.ts';
import { installApp } from './app.ts';
import { countUpdated, screenOwnerId, screenProjectId, toTask } from './screen.ts';

installApp(async config => {
  const zero = new Zero({ userID: config.actorId, auth: config.auth, cacheURL: config.urls.zero, schema, mutators, storageKey: config.clientId, kvStore: 'idb', logLevel: 'error' });
  // Native views: the full task set and the filtered/ordered/limited screen.
  const all = zero.materialize(queries.tasks.all());
  const screen = zero.materialize(queries.tasks.startupScreen({ projectId: screenProjectId, ownerId: screenOwnerId }));
  let failure: unknown;
  for (const view of [all, screen]) view.addListener((_rows, state, error) => { if (state === 'error') failure = error ?? 'Zero view error'; });
  const check = () => { if (failure) throw new Error(`Zero view failed: ${JSON.stringify(failure)}`); };
  return {
    diagnostics: { storage: 'IndexedDB (kvStore: idb)', syncThread: 'main thread', queryThread: 'main thread (native materialized views)', updatedCount: 'application scan of the native full-task view' },
    screen: async () => { check(); return screen.data.map(toTask); },
    progress: async prefix => { check(); return { rows: all.data.length, updated: countUpdated(all.data as any, prefix) }; },
    rows: async () => all.data.map(toTask),
    close: async () => { all.destroy(); screen.destroy(); await zero.close(); },
  };
}, 'zero');
