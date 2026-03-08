import type { BenchmarkAdapter, StackId } from '../types';
import { ElectricBenchmarkAdapter } from './electric';
import { LiveStoreBenchmarkAdapter } from './livestore';
import { PowerSyncBenchmarkAdapter } from './powersync';
import { ReplicacheBenchmarkAdapter } from './replicache';
import { SyncularBenchmarkAdapter } from './syncular';
import { ZeroBenchmarkAdapter } from './zero';

export function createAdapter(stackId: StackId): BenchmarkAdapter {
  switch (stackId) {
    case 'syncular':
      return new SyncularBenchmarkAdapter();
    case 'electric':
      return new ElectricBenchmarkAdapter();
    case 'zero':
      return new ZeroBenchmarkAdapter();
    case 'powersync':
      return new PowerSyncBenchmarkAdapter();
    case 'replicache':
      return new ReplicacheBenchmarkAdapter();
    case 'livestore':
      return new LiveStoreBenchmarkAdapter();
    default:
      throw new Error(`Unsupported stack adapter: ${stackId}`);
  }
}
