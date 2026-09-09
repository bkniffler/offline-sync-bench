import { shuffled, seededRandom } from '../statistics.ts';
import { validateClientRuntime, type ChromiumRuntime } from './provenance.ts';
import type { ForwardingMode } from './loaded-run.ts';

export const LOADED_WORKER_ENTRYPOINT = 'src/browser/loaded-trial.ts';

export interface LoadedConfig {
  version: 1;
  purpose: 'smoke' | 'diagnostic';
  method: 'browser-milestone-forwarding-v1';
  seed: number;
  pairs: number;
  trialTimeoutMs: number;
  stacks: Array<'electric' | 'zero'>;
  runtime: ChromiumRuntime;
  network: { id: 'local-loopback'; injectedLatencyMs: 0; injectedLossPct: 0 };
  stoppingRule: string;
}
export interface LoadedEntry { stackId: 'electric' | 'zero'; pair: number; mode: ForwardingMode; order: number }

export function planLoadedCampaign(config: LoadedConfig): LoadedEntry[] {
  if (config.version !== 1 || config.method !== 'browser-milestone-forwarding-v1'
    || !['smoke', 'diagnostic'].includes(config.purpose)) throw new Error('Invalid loaded diagnostic method or purpose');
  if (!Number.isSafeInteger(config.seed) || config.seed < 1
    || !Number.isSafeInteger(config.pairs) || config.pairs < 1
    || config.trialTimeoutMs !== 300_000 || !config.stoppingRule?.trim()) throw new Error('Invalid loaded diagnostic design');
  if (!config.stacks?.length || new Set(config.stacks).size !== config.stacks.length
    || config.stacks.some(stack => !['electric', 'zero'].includes(stack))) throw new Error('Invalid loaded browser roster');
  if (config.purpose === 'diagnostic' && (config.pairs !== 5 || [...config.stacks].sort().join() !== 'electric,zero')) throw new Error('Declared loaded experiment requires five pairs for both browser adapters');
  if (config.network?.id !== 'local-loopback' || config.network.injectedLatencyMs !== 0
    || config.network.injectedLossPct !== 0) throw new Error('Loaded experiment requires the controlled local profile');
  validateClientRuntime(config.runtime);
  if (config.runtime.kind !== 'chromium') throw new Error('Loaded experiment requires Chromium');
  const pairs = shuffled(config.stacks.flatMap(stackId => Array.from({ length: config.pairs }, (_, index) => ({ stackId, pair: index + 1 }))), config.seed);
  const random = seededRandom(config.seed + 1);
  return pairs.flatMap(pair => (random() < 0.5 ? ['buffered', 'forwarded'] : ['forwarded', 'buffered'])
    .map((mode, index) => ({ ...pair, mode: mode as ForwardingMode, order: index + 1 })));
}
