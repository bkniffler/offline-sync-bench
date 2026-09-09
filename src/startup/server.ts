import { spawnSync } from 'node:child_process';
import { resolveServiceContainerId, stopService, startService } from '../stack-manager.ts';
import type { StackId } from '../types.ts';

export function serverState(stackId: StackId) {
  const containerId = resolveServiceContainerId(stackId, 'sync');
  const result = spawnSync('docker', ['inspect', '--format', '{{json .State}}', containerId], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Cannot inspect startup service: ${result.stderr}`);
  const state = JSON.parse(result.stdout);
  return { containerId, startedAt: String(state.StartedAt), running: state.Running === true, health: String(state.Health?.Status ?? 'unavailable') };
}

/** Restart only the sync process. Database volumes, downstream services and OS
 * caches stay intact. Docker health probes run before client timing begins. */
export async function restartStartupServer(stackId: StackId) {
  const before = serverState(stackId);
  stopService(stackId, 'sync'); startService(stackId, 'sync');
  const deadline = performance.now() + 60_000;
  while (performance.now() < deadline) {
    const after = serverState(stackId);
    if (after.running && after.health === 'healthy' && after.startedAt !== before.startedAt) return { before, after };
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw new Error('Startup service restart/health check timed out');
}
