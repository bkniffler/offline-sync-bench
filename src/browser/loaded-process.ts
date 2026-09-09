import type { ProcessIdentity } from './process.ts';

const requireEvidence = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(`Loaded process ${message}`);
};
const positivePid = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 1;
const same = (a: any, b: any) => ['pid', 'ppid', 'pgid', 'started'].every(key => a?.[key] === b?.[key]);
export const processIdentityKey = (row: ProcessIdentity) => `${row.pid}/${row.started}`;

/** Bind a child group and native browser parents to the declared controller.
 * A failed launch can remain an invalid attempt without inventing an OS root. */
export function validateLoadedProcessGroup(controller: ProcessIdentity, result: any): ProcessIdentity[] {
  requireEvidence(positivePid(controller?.pid) && positivePid(controller?.pgid) && typeof controller?.started === 'string' && controller.started, 'declared controller missing');
  const group = result.processGroup;
  requireEvidence(group?.emptyVerified === true && Array.isArray(group.remaining) && !group.remaining.length
    && Array.isArray(group.initial) && Array.isArray(group.beforeTermination) && Array.isArray(group.signals), 'cleanup inventory missing');
  const roots = group.initial.filter((row: any) => row.pid === group.pid);
  if (!roots.length) {
    const failedLaunch = group.pid === null && typeof group.launchError === 'string' && group.launchError;
    const failedInventory = positivePid(group.pid) && group.beforeTermination.some((entry: any) => ['invalid-initial-group', 'initial-inventory-failed'].includes(entry.reason));
    requireEvidence(result.status === 'invalid' && (failedLaunch || failedInventory), 'trial root identity missing');
    requireEvidence(!(result.evidence?.clients ?? []).some((client: any) => client.connection), 'unbound browser evidence after failed launch');
    return [];
  }
  requireEvidence(roots.length === 1, 'trial root identity duplicated');
  const root = roots[0];
  requireEvidence(positivePid(root.pid) && root.pid !== controller.pid && root.ppid === controller.pid
    && root.pgid === root.pid && typeof root.started === 'string' && root.started, 'trial root is not owned by the declared controller');
  for (const row of group.initial) requireEvidence(positivePid(row.pid) && row.pgid === root.pgid && typeof row.started === 'string' && row.started, 'initial member escaped the child group');
  for (const snapshot of group.beforeTermination) {
    requireEvidence(Array.isArray(snapshot.members), 'termination snapshot missing');
    for (const row of snapshot.members) {
      requireEvidence(positivePid(row.pid) && row.pgid === root.pgid && typeof row.started === 'string' && row.started, 'termination member escaped the child group');
      if (row.pid === root.pid) requireEvidence(same(row, root), 'trial root identity changed before termination');
    }
  }
  for (const signal of group.signals) requireEvidence(signal.signal === 'SIGKILL'
    && ['whole-attempt-deadline', 'post-exit-helper-cleanup', 'invalid-initial-group', 'initial-inventory-failed'].includes(signal.reason), 'termination action differs');
  if (result.status === 'timed-out') requireEvidence(Number.isFinite(group.deadlineElapsedMs) && group.deadlineElapsedMs >= 300_000
    && group.beforeTermination.some((snapshot: any) => snapshot.reason === 'whole-attempt-deadline'), 'deadline termination evidence missing');
  const identities: ProcessIdentity[] = [root];
  for (const client of result.evidence?.clients ?? []) {
    const connection = client.connection;
    if (!connection) continue;
    requireEvidence(same(connection.parent, root), 'browser parent differs from the owned trial root');
    const browser = connection.osProcesses?.find((row: any) => row.pid === connection.pid);
    requireEvidence(browser && browser.ppid === root.pid && browser.pgid === root.pgid, 'browser is outside its trial group');
    identities.push(browser);
  }
  requireEvidence(new Set(identities.map(processIdentityKey)).size === identities.length, 'process identity duplicated within a condition');
  return identities;
}
