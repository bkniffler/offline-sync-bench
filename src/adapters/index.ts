import type { BenchmarkAdapter, StackId } from '../types';
import { ElectricBenchmarkAdapter } from './electric';
import { ElectricTanStackBenchmarkAdapter } from './electric-tanstack';
import { JazzV2BenchmarkAdapter } from './jazz-v2';
import { PowerSyncBenchmarkAdapter } from './powersync';
import { SyncularRustBenchmarkAdapter } from './syncular-rust';
import { SyncularBenchmarkAdapter } from './syncular';
import { TursoBenchmarkAdapter } from './turso';
import { TriplitBenchmarkAdapter } from './triplit';
import { ZeroBenchmarkAdapter } from './zero';

export function createAdapter(stackId: StackId): BenchmarkAdapter {
  switch (stackId) {
    case 'syncular':
      return new SyncularBenchmarkAdapter();
    case 'syncular-rust':
      return new SyncularRustBenchmarkAdapter();
    case 'electric':
      return new ElectricBenchmarkAdapter();
    case 'electric-tanstack':
      return new ElectricTanStackBenchmarkAdapter();
    case 'zero':
      return new ZeroBenchmarkAdapter();
    case 'powersync':
      return new PowerSyncBenchmarkAdapter();
    case 'turso':
      return new TursoBenchmarkAdapter();
    case 'jazz-v2':
      return new JazzV2BenchmarkAdapter();
    case 'triplit':
      return new TriplitBenchmarkAdapter();
    default:
      throw new Error(`Unsupported stack adapter: ${stackId}`);
  }
}
