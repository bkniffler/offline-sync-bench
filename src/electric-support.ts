import { createUnsupportedScenarioResult } from './unsupported.ts';
import type { ScenarioId } from './types.ts';

export const electricWriteScenarios: readonly ScenarioId[] = [
  'online-propagation', 'offline-replay', 'large-offline-queue', 'offline-restart',
  'conflict-update-update', 'conflict-update-delete', 'connected-fanout', 'reconnect-storm', 'blob-flow',
];
export const electricWriteReason = 'Electric provides read-path sync only. This benchmark requires client writes; no custom write queue or uploader is added.';
export function electricWriteUnsupported() {
  return createUnsupportedScenarioResult({ implementation: 'electric-read-only', coverage: 'unsupported-tested-configuration', notes: [electricWriteReason] });
}
