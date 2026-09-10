import { electricWriteScenarios, electricWriteReason } from './electric-support.ts';
export const noNativeAttachmentsReason = 'This library has no native attachment storage and transfer API. An application-provided uploader is outside this benchmark.';
/** Feature support controls the displayed comparison; old raw attempts remain immutable. */
export const nativeFeatureExclusions = [
  ...electricWriteScenarios.map(scenario => ({ stack: 'electric', scenario, label: 'Not supported', reason: electricWriteReason })),
  ...['turso', 'zero', 'electric-tanstack'].map(stack => ({ stack, scenario: 'blob-flow', label: 'Not supported', reason: noNativeAttachmentsReason })),
];
