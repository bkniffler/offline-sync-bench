import { ContractError, hash } from './screens.ts';
import type { JsonObject } from '../types.ts';

export const defaultRecoveryOutageMs = 20_000;
export function recoveryPolicy(durationMs: unknown = defaultRecoveryOutageMs): JsonObject {
  if (typeof durationMs !== 'number' || !Number.isSafeInteger(durationMs) || durationMs < 1_000 || durationMs > 120_000) throw new ContractError('Recovery outage duration must be an integer from 1000 through 120000 ms');
  return { method: 'fixed-block-to-restoration-v1', durationMs, maxLatenessMs: 250, clock: 'controller-monotonic', readiness: 'all-offline-checks-before-deadline', probe: 'existing-adapter-native-probe' };
}
export function configuredRecoveryPolicy(): JsonObject {
  const value = process.env.BENCH_RECOVERY_OUTAGE_MS;
  if (value && !/^[1-9][0-9]*$/.test(value)) throw new ContractError('Malformed recovery outage duration');
  return recoveryPolicy(value ? Number(value) : defaultRecoveryOutageMs);
}
export function validateRestoration(policy: JsonObject, timing: JsonObject, before: JsonObject, atRestoration: JsonObject): void {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw new ContractError('Recovery restoration policy missing');
  if (hash(policy) !== hash(recoveryPolicy(policy?.durationMs))) throw new ContractError('Recovery restoration policy changed');
  if (!timing || timing.clock !== policy.clock || timing.anchor !== 'immediately-before-gate-block' || timing.blockedAtMs !== 0) throw new ContractError('Recovery restoration clock missing');
  let last = 0;
  for (const key of ['queueCommittedAtMs', 'probeStartedAtMs', 'probeFinishedAtMs', 'offlineValidatedAtMs', 'restoreStartedAtMs', 'restoredAtMs']) {
    const value = timing[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < last) throw new ContractError(`Recovery restoration milestone invalid: ${key}`);
    last = value;
  }
  if (Number(timing.offlineValidatedAtMs) >= Number(policy.durationMs)
    || Number(timing.restoreStartedAtMs) < Number(policy.durationMs)
    || Number(timing.restoredAtMs) > Number(policy.durationMs) + Number(policy.maxLatenessMs)) throw new ContractError('Recovery restoration missed its predeclared deadline');
  const endpoints = before?.endpoints as JsonObject, restoredEndpoints = atRestoration?.endpoints as JsonObject, timeline = timing.timeline as JsonObject;
  if (!endpoints || !restoredEndpoints || !timeline || !Object.keys(endpoints).length || hash(Object.keys(endpoints).sort()) !== hash(Object.keys(timeline).sort()) || hash(Object.keys(endpoints).sort()) !== hash(Object.keys(restoredEndpoints).sort())) throw new ContractError('Recovery restoration endpoint timeline missing');
  for (const [name, initialValue] of Object.entries(endpoints)) {
    const initial = initialValue as JsonObject, final = restoredEndpoints[name] as JsonObject, events = timeline[name] as JsonObject[];
    if (!Array.isArray(events) || !events.length || initial.blocked !== true || final?.blocked !== true || initial.requestBytes !== final.requestBytes || initial.forwardedConnections !== final.forwardedConnections) throw new ContractError('Traffic forwarded during recovery outage');
    let previous = 0, block = 0, restore = 0, rejected = 0;
    for (const event of events) {
      if (typeof event.atMs !== 'number' || !Number.isFinite(event.atMs) || event.atMs < previous || !['block','restore','rejected','forwarded'].includes(String(event.kind))) throw new ContractError('Recovery connection timeline invalid');
      previous = event.atMs;
      if (event.kind === 'block') { block++; if (event.atMs > Number(timing.queueCommittedAtMs)) throw new ContractError('Recovery queue preceded outage'); }
      if (event.kind === 'restore') { restore++; if (event.atMs < Number(timing.restoreStartedAtMs) || event.atMs > Number(timing.restoredAtMs)) throw new ContractError('Recovery gate restored outside the declared clock'); }
      if (event.kind === 'forwarded' && restore === 0) throw new ContractError('Recovery timeline forwarded blocked traffic');
      if (event.kind === 'rejected') { if (block !== 1 || restore !== 0) throw new ContractError('Recovery rejection outside outage'); rejected++; }
    }
    if (block !== 1 || restore !== 1 || rejected !== Number(final.rejectedConnections) - Number(initial.rejectedConnections)) throw new ContractError('Recovery timeline differs from gate counters');
  }
}
