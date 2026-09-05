import {expect, test} from 'bun:test';
import {syncularCoverageGaps} from './syncular-coverage';

test('a completed 25-client storm does not count as a complete scale study', () => {
  const missing = syncularCoverageGaps('syncular', 'reconnect-storm', {clients_25_convergence_ms: 80.21});
  expect(missing).toContain('clients_1000_convergence_ms');
  expect(missing).toContain('clients_500_sync_avg_memory_mb');
  expect(missing).not.toContain('clients_25_convergence_ms');
});

test('unscoped resource measurements cannot populate a 500-client result', () => {
  const metrics = Object.fromEntries([25,100,250,500,1000].map(n => [`clients_${n}_convergence_ms`, 1]));
  expect(syncularCoverageGaps('syncular-rust', 'reconnect-storm', {...metrics, sync_avg_memory_mb: 100})).toContain('clients_500_sync_avg_memory_mb');
});

test('zero-valued measurements are present while null and non-finite values are missing', () => {
  expect(syncularCoverageGaps('syncular-rust', 'deep-relationship-query', {
    dashboard_query_p50_ms: 0, detail_join_query_p50_ms: Number.NaN, avg_memory_mb: null,
  })).toEqual(['detail_join_query_p50_ms', 'avg_memory_mb']);
});


test('a recorded scale failure counts as an attempted tier without inventing values', () => {
  const metrics = Object.fromEntries([25, 100, 250, 500, 1000].map(n => [`clients_${n}_failed`, 1]));
  expect(syncularCoverageGaps('syncular', 'reconnect-storm', metrics)).toEqual([]);
  delete metrics.clients_1000_failed;
  expect(syncularCoverageGaps('syncular', 'reconnect-storm', metrics)).toEqual(['clients_1000_convergence_ms']);
});
