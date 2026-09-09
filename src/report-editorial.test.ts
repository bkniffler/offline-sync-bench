import { expect, test } from 'bun:test';
import { profileLabel, workloadLabel } from './report-editorial.ts';
import { recoveryGuarantees } from './contracts/recovery.ts';
import { fanoutProfile } from './contracts/fanout.ts';

test('recovery headings expose ownership and queue persistence instead of identical contract labels', () => {
  const label = (stack: 'electric' | 'electric-tanstack' | 'zero' | 'syncular') => profileLabel({ contract: 'offline-recovery-v2', lane: 'stable-native-host', guarantee: recoveryGuarantees(stack, 'offline-replay') });
  expect(new Set(['electric', 'electric-tanstack', 'zero', 'syncular'].map(stack => label(stack as Parameters<typeof label>[0]))).size).toBe(4);
  expect(label('electric')).toContain('benchmark-owned queue; persisted cache and queue');
  expect(label('electric-tanstack')).toContain('product queue; persisted cache, memory queue storage');
  expect(label('zero')).toContain('memory cache and queue');
  expect(label('syncular')).toContain('product queue; persisted cache and queue');
  expect(profileLabel({ contract: 'offline-recovery-v2', lane: 'stable-native-host', guarantee: recoveryGuarantees('electric', 'offline-restart') })).toContain('SIGKILL recovery');
  const missing = profileLabel({ contract: 'offline-recovery-v2', lane: 'stable-native-host', guarantee: { localStore: 'persistent-file', offlineQueue: 'product-managed', restart: 'live-process-replay' } });
  expect(missing).toContain('unspecified queue storage');
  expect(missing).not.toContain('persisted cache and queue');
});

test('fanout headings expose cache ownership and do not infer restart durability', () => {
  const labels = ['electric', 'zero', 'syncular'].map(stack => profileLabel({ contract: 'client-fanout-recovery-v1', lane: 'stable-native-host', guarantee: fanoutProfile('connected-fanout', stack as 'electric' | 'zero' | 'syncular') }));
  expect(new Set(labels).size).toBe(3);
  expect(labels[0]).toContain('benchmark-owned persisted cache');
  expect(labels[1]).toContain('memory cache');
  expect(labels[2]).toContain('product persisted cache');
  expect(labels.every(label => label.includes('no process-restart guarantee'))).toBe(true);
  expect(profileLabel({ contract: 'client-fanout-recovery-v1', lane: 'stable-native-host', guarantee: {} })).toContain('unspecified cache');
});


test('startup report labels use the declared campaign sizes', () => {
  expect(workloadLabel('bootstrap', [500000, 1000000])).toContain('500,000, 1,000,000 tasks');
  expect(workloadLabel('bootstrap', [500000])).not.toContain('100k');
});
