import type { BenchmarkStatus, JsonValue } from './types';

export interface UnsupportedScenarioResult {
  status: BenchmarkStatus;
  metrics: Record<string, number | null>;
  notes: string[];
  metadata: { [key: string]: JsonValue };
}

export function createUnsupportedScenarioResult(args: {
  implementation: string;
  notes: string[];
  coverage?: 'not-implemented' | 'unsupported-tested-configuration';
}): UnsupportedScenarioResult {
  return {
    status: 'unsupported',
    metrics: {},
    notes: args.notes,
    metadata: {
      implementation: args.implementation,
      coverage: { status: args.coverage ?? 'not-implemented', reason: args.notes.join(' ') },
    },
  };
}
