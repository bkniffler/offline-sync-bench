import { scenarios } from './scenarios';
import { stacks } from './stacks';
import type { JsonObject } from './types';

export const benchmarkPolicyVersion = '2026-03-14.v1';

export function getMethodologyManifest(): JsonObject {
  return {
    policyVersion: benchmarkPolicyVersion,
    benchmarkMode: 'published-packages-and-images',
    benchmarkModeNotes: [
      'Syncular is benchmarked from the published packages, exact-pinned: the host-side JS client and the Dockerized server stack use the npm packages (@syncular/*@0.15.18), and the native Rust client row drives the rusqlite core over real HTTP+WS via a harness-owned bench binary built against the published crates (syncular-client / syncular-command / syncular-ffi 0.15.18).',
      'The other stacks are benchmarked from the package versions and image references installed in offline-sync-bench itself.',
      'The benchmark compares workload outcomes per scenario, not a single cross-framework score.',
      'Model difference, stated honestly: the CDC stacks (Electric, Zero, and PowerSync) observe an app-owned Postgres via WAL/CDC, so bench-admin writes plain SQL. Syncular v2 materializes real per-app Postgres tables but owns them: ingestion goes through the engine (push API / storage API), never CDC. The Syncular bench-admin therefore writes through the storage API and wakes clients via the engine’s Postgres LISTEN/NOTIFY fanout — its supported multi-instance path — while reads use plain SQL over the materialized columns.',
    ],
    supportLevelSemantics: {
      native:
        'The scenario uses the framework as shipped for that workflow, without adding a benchmark-owned durability or sync layer.',
      emulated:
        'The benchmark adds a clearly documented auxiliary layer because the framework does not ship that capability directly in the tested path.',
      unsupported:
        'The scenario is not measured because the framework does not target that capability in this harness, or measuring it fairly would require inventing product behavior.',
    },
    stackAdmission: {
      primaryRule:
        'Admit deployable sync products that supply both a server/backend and a local client.',
      combinationException:
        'Admit an exceptionally popular, officially supported combination only when the combination supplies those layers together.',
      requiredCoreCoverage: [
        'bootstrap',
        'online-propagation',
        'offline-replay or an explicit non-offline product model',
        'local reads',
      ],
      excludedModels: [
        'Generic BYOB client libraries whose benchmark-owned server would define most of the measured behavior.',
        'Products whose active row would be dominated by unsupported scenarios.',
      ],
      admittedCombinationExceptions: ['electric-tanstack'],
      experimentalLane: ['jazz-v2'],
      excludedFromActiveMatrix: ['livestore', 'replicache'],
    },
    fairnessRules: [
      'All stacks use the same seeded domain model: organizations, projects, users, memberships, and tasks.',
      'All stacks are started by Docker Compose and reset between runs so server-side state does not leak across scenarios.',
      'Benchmark claims are scenario-scoped. A stack may be strong on bootstrap and intentionally unsupported on offline replay.',
      'Unsupported scenarios are preferred over synthetic adapters that would stop measuring the framework as shipped.',
      'Emulated scenarios must be labeled explicitly and described in the result metadata and README.',
      'Auth and scoping are minimized for the first benchmark generation so the core transport and local-data paths can be compared before policy-heavy scenarios are added.',
      'Results should be compared within the same run or on the same hardware profile whenever possible.',
      'Image digests and package versions are captured in the run metadata so results can be reproduced or challenged precisely.',
      'Experimental-lane results remain visible but are excluded from stable headline rankings.',
    ],
    currentLimitations: [
      'Permission-change convergence is currently verified for Syncular and for Electric through a benchmark-owned auth-scoped shape proxy; the remaining stacks are intentionally marked unsupported.',
      'The first benchmark generation still uses benchmark-owned simplified auth/scoping setups rather than each product’s full production policy stack.',
    ],
    scenarioContracts: scenarios.map((scenario) => ({
      id: scenario.id,
      title: scenario.title,
      summary: scenario.summary,
      primaryMetrics: scenario.primaryMetrics,
    })),
    stackMatrix: stacks.map((stack) => ({
      id: stack.id,
      title: stack.title,
      support: {
        bootstrap: stack.capabilities.bootstrap,
        onlinePropagation: stack.capabilities.onlinePropagation,
        offlineReplay: stack.capabilities.offlineReplay,
        reconnectStorm: stack.capabilities.reconnectStorm,
        largeOfflineQueue: stack.capabilities.largeOfflineQueue,
        localQuery: stack.capabilities.localQuery,
        permissionChange: stack.capabilities.permissionChange,
      },
    })),
  };
}
