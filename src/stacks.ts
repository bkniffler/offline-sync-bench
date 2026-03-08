import { benchmarkRoot } from './paths';
import type { StackId, StackSpec } from './types';

export const stacks: StackSpec[] = [
  {
    id: 'syncular',
    title: 'Syncular',
    composeFile: `${benchmarkRoot}/stacks/syncular/docker-compose.yml`,
    composeProjectName: 'offline-sync-bench-syncular',
    databaseUrl: 'postgresql://bench:bench@localhost:55432/bench?sslmode=disable',
    adminBaseUrl: 'http://localhost:3211',
    syncBaseUrl: 'http://localhost:3210/api',
    syncRealtimeBaseUrl: 'ws://localhost:3210/api/sync/realtime',
    services: {
      sync: 'syncular',
      admin: 'admin',
      postgres: 'postgres',
    },
    capabilities: {
      bootstrap: 'native',
      onlinePropagation: 'native',
      offlineReplay: 'native',
      reconnectStorm: 'native',
      largeOfflineQueue: 'native',
      localQuery: 'native',
      permissionChange: 'native',
    },
    notes: [
      'Uses the real Syncular client and server packages.',
      'Measures bootstrap into a local Bun SQLite database and native outbox replay.',
    ],
  },
  {
    id: 'electric',
    title: 'Electric',
    composeFile: `${benchmarkRoot}/stacks/electric/docker-compose.yml`,
    composeProjectName: 'offline-sync-bench-electric',
    databaseUrl: 'postgresql://bench:bench@localhost:55433/bench?sslmode=disable',
    adminBaseUrl: 'http://localhost:3212',
    syncBaseUrl: 'http://localhost:3213',
    appBaseUrl: 'http://localhost:3224',
    services: {
      sync: 'electric',
      app: 'app',
      admin: 'admin',
      postgres: 'postgres',
    },
    capabilities: {
      bootstrap: 'native',
      onlinePropagation: 'native',
      offlineReplay: 'emulated',
      reconnectStorm: 'native',
      largeOfflineQueue: 'emulated',
      localQuery: 'native',
      permissionChange: 'native',
    },
    notes: [
      'Uses Electric shape feeds directly for bootstrap and visibility timing.',
      'Permission-change convergence uses a benchmark-owned auth-scoped Electric shape proxy that derives project access from project_memberships.',
      'Offline replay uses a benchmark-owned Bun SQLite outbox to emulate durable client-side queuing.',
    ],
  },
  {
    id: 'zero',
    title: 'Zero',
    composeFile: `${benchmarkRoot}/stacks/zero/docker-compose.yml`,
    composeProjectName: 'offline-sync-bench-zero',
    databaseUrl: 'postgresql://bench:bench@localhost:55434/bench?sslmode=disable',
    adminBaseUrl: 'http://localhost:3216',
    syncBaseUrl: 'http://localhost:3214',
    appBaseUrl: 'http://localhost:3215',
    services: {
      sync: 'zero-cache',
      app: 'app',
      admin: 'admin',
      postgres: 'postgres',
    },
    capabilities: {
      bootstrap: 'native',
      onlinePropagation: 'native',
      offlineReplay: 'unsupported',
      reconnectStorm: 'unsupported',
      largeOfflineQueue: 'unsupported',
      localQuery: 'unsupported',
      permissionChange: 'unsupported',
    },
    notes: [
      'Uses a real zero-cache service plus a minimal benchmark app implementing query and mutate endpoints.',
      'Offline replay is marked unsupported because Zero does not target durable offline write queues in this deployment model.',
    ],
  },
  {
    id: 'powersync',
    title: 'PowerSync',
    composeFile: `${benchmarkRoot}/stacks/powersync/docker-compose.yml`,
    composeProjectName: 'offline-sync-bench-powersync',
    databaseUrl: 'postgresql://bench:bench@localhost:55435/bench?sslmode=disable',
    adminBaseUrl: 'http://localhost:3219',
    syncBaseUrl: 'http://localhost:3217',
    appBaseUrl: 'http://localhost:3218',
    services: {
      sync: 'powersync',
      app: 'app',
      admin: 'admin',
      postgres: 'postgres',
      storage: 'storage-postgres',
    },
    capabilities: {
      bootstrap: 'native',
      onlinePropagation: 'native',
      offlineReplay: 'native',
      reconnectStorm: 'unsupported',
      largeOfflineQueue: 'unsupported',
      localQuery: 'unsupported',
      permissionChange: 'unsupported',
    },
    notes: [
      'Uses the official PowerSync service with Postgres-backed bucket storage and a benchmark-owned Bun backend.',
      'Client-side benchmarks run through the real Node SDK and its native upload queue.',
    ],
  },
  {
    id: 'replicache',
    title: 'Replicache',
    composeFile: `${benchmarkRoot}/stacks/replicache/docker-compose.yml`,
    composeProjectName: 'offline-sync-bench-replicache',
    databaseUrl: 'postgresql://bench:bench@localhost:55437/bench?sslmode=disable',
    adminBaseUrl: 'http://localhost:3221',
    syncBaseUrl: 'http://localhost:3220',
    appBaseUrl: 'http://localhost:3220',
    services: {
      sync: 'app',
      app: 'app',
      admin: 'admin',
      postgres: 'postgres',
    },
    capabilities: {
      bootstrap: 'native',
      onlinePropagation: 'native',
      offlineReplay: 'native',
      reconnectStorm: 'unsupported',
      largeOfflineQueue: 'unsupported',
      localQuery: 'unsupported',
      permissionChange: 'unsupported',
    },
    notes: [
      'Uses a benchmark-owned Bun BYOB server with the real Replicache client running against fake-indexeddb under Bun.',
      'Pull responses currently use full-dataset patches keyed by a derived cookie instead of server-side diffing.',
    ],
  },
  {
    id: 'livestore',
    title: 'LiveStore',
    composeFile: `${benchmarkRoot}/stacks/livestore/docker-compose.yml`,
    composeProjectName: 'offline-sync-bench-livestore',
    databaseUrl: 'postgresql://bench:bench@localhost:55438/bench?sslmode=disable',
    adminBaseUrl: 'http://localhost:3223',
    syncBaseUrl: 'http://localhost:3222',
    appBaseUrl: 'http://localhost:3223',
    services: {
      sync: 'electric',
      app: 'app',
      admin: 'app',
      postgres: 'postgres',
    },
    capabilities: {
      bootstrap: 'native',
      onlinePropagation: 'native',
      offlineReplay: 'unsupported',
      reconnectStorm: 'unsupported',
      largeOfflineQueue: 'unsupported',
      localQuery: 'unsupported',
      permissionChange: 'unsupported',
    },
    notes: [
      'Uses the real LiveStore Bun node adapter with the official sync-electric package and a benchmark-owned proxy/admin service.',
      'The canonical benchmark state is mirrored into both a server-side tasks table and LiveStore eventlog rows for consistent admin introspection.',
      'Durable offline replay is currently marked unsupported in this harness because transport failures terminate sync sessions before queued writes can be measured fairly.',
    ],
  },
];

export function getStack(stackId: StackId): StackSpec {
  const stack = stacks.find((candidate) => candidate.id === stackId);
  if (!stack) {
    throw new Error(`Unknown stack: ${stackId}`);
  }
  return stack;
}
