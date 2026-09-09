import { ContractError, taskRecord, type Row } from '../contracts/task-record.ts';

const canonical = (rows: Row[]) => JSON.stringify(rows.map(taskRecord).sort((a, b) => String(a.id).localeCompare(String(b.id))));

/** A native query can be complete while its server cache still predates the
 * seeded fixture. Wait for exact local data before any measured operations. */
export async function awaitBrowserFixture(read: () => Row[], expected: Row[],
  { timeoutMs = 60_000, pollMs = 25 } = {}) {
  if (!expected.length || new Set(expected.map(row => row.id)).size !== expected.length
    || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(pollMs) || pollMs <= 0) throw new Error('Invalid browser fixture readiness configuration');
  const wanted = canonical(expected), started = performance.now();
  const evidence = { method: 'exact-browser-fixture-v1', timeoutMs, pollMs, elapsedMs: 0,
    observations: 0, firstRowCount: -1, finalRowCount: 0, countMismatches: 0, contentMismatches: 0 };
  while (true) {
    const rows = read(); // Native connection errors must propagate.
    evidence.observations++;
    if (evidence.observations === 1) evidence.firstRowCount = rows.length;
    evidence.finalRowCount = rows.length;
    let matches = false;
    if (rows.length !== expected.length) evidence.countMismatches++;
    else {
      try { matches = canonical(rows) === wanted; }
      catch (error) { if (!(error instanceof ContractError)) throw error; }
      if (!matches) evidence.contentMismatches++;
    }
    evidence.elapsedMs = performance.now() - started;
    if (evidence.elapsedMs >= timeoutMs) throw Object.assign(new ContractError(`browser initial fixture timed out: ${JSON.stringify(evidence)}`), { evidence });
    if (matches) return evidence;
    await new Promise(resolve => setTimeout(resolve, Math.min(pollMs, timeoutMs - evidence.elapsedMs)));
  }
}
