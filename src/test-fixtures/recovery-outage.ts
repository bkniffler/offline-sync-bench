import { recoveryPolicy } from '../contracts/recovery-policy.ts';
export { recoveryPolicy };
export function recoveryOutageFixture(durationMs = 20_000) {
  const before = { blocked: true, rejectedConnections: 0, forwardedConnections: 1, requestBytes: 100, responseBytes: 0 };
  const after = { ...before, rejectedConnections: 1 };
  return { method: 'client-only-tcp-gate', healthyReaderSync: true,
    before: { ...before, endpoints: { sync: { ...before } } }, after: { ...after, endpoints: { sync: { ...after } } },
    restoration: { clock: 'controller-monotonic', anchor: 'immediately-before-gate-block', blockedAtMs: 0,
      queueCommittedAtMs: 1, probeStartedAtMs: 2, probeFinishedAtMs: 3, offlineValidatedAtMs: 4,
      restoreStartedAtMs: durationMs, restoredAtMs: durationMs + 0.1,
      timeline: { sync: [{kind:'block',atMs:0.01},{kind:'rejected',atMs:2.5},{kind:'restore',atMs:durationMs + 0.05},{kind:'forwarded',atMs:durationMs + 1}] } } };
}
