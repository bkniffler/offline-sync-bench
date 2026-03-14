import { scenarios } from './scenarios';
import { stacks } from './stacks';
import type { JsonObject } from './types';

export const benchmarkPolicyVersion = '2026-03-14.v1';

export function getMethodologyManifest(): JsonObject {
  return {
    policyVersion: benchmarkPolicyVersion,
    benchmarkMode: 'published-packages-and-images',
    benchmarkModeNotes: [
      'Syncular is benchmarked from the published npm packages installed in offline-sync-bench for the host-side client path and in the Syncular stack app for the Dockerized server stack.',
      'The other stacks are benchmarked from the package versions and image references installed in offline-sync-bench itself.',
      'The benchmark compares workload outcomes per scenario, not a single cross-framework score.',
    ],
    supportLevelSemantics: {
      native:
        'The scenario uses the framework as shipped for that workflow, without adding a benchmark-owned durability or sync layer.',
      emulated:
        'The benchmark adds a clearly documented auxiliary layer because the framework does not ship that capability directly in the tested path.',
      unsupported:
        'The scenario is not measured because the framework does not target that capability in this harness, or measuring it fairly would require inventing product behavior.',
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
