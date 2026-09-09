import type { RecoveryObservation } from '../recovery/protocol.ts';
import type { Row } from '../contracts/screens.ts';

export function deliveryQuery(expected: RecoveryObservation[]) {
  const params: (string | number)[] = [];
  const predicates = expected.map(row => {
    if (row.title === null) throw new Error('Fanout observer requires live rows');
    params.push(row.id, row.title);
    if (row.serverVersion !== undefined) { params.push(row.serverVersion); return '(id = ? AND title = ? AND server_version = ?)'; }
    return '(id = ? AND title = ?)';
  });
  if (!predicates.length || new Set(expected.map(r => r.id)).size !== expected.length) throw new Error('Delivery observation requires distinct rows');
  // Keep the expression tree shallow for engines with a depth limit. The
  // workload still matches every id/title/version tuple independently.
  let groups: string[] = predicates;
  while (groups.length > 1) groups = Array.from({ length: Math.ceil(groups.length / 2) }, (_, i) => groups[i * 2 + 1] ? `(${groups[i * 2]} OR ${groups[i * 2 + 1]})` : groups[i * 2]);
  return { sql: `SELECT id FROM tasks WHERE ${groups[0]}`, params };
}
/** Only query local state here. Live delivery belongs to the product connection,
 * not a harness loop issuing catch-up sync requests after the measured write. */
export async function pollDelivery(expected: RecoveryObservation[], query: () => Promise<Row[]>, timeoutMs = 90_000) {
  const ids = new Set(expected.map(row => row.id));
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const rows = await query();
    if (rows.length === expected.length && new Set(rows.map(row => row.id)).size === expected.length && rows.every(row => ids.has(String(row.id)))) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Connected client delivery timed out');
}

/** Match tuples from actual local rows without starting any transport work. */
export function matchingDeliveryRows(expected: RecoveryObservation[], rows: Row[]): Row[] {
  if (!expected.length || expected.some(row => row.title === null) || new Set(expected.map(row => row.id)).size !== expected.length) throw new Error('Delivery observation requires distinct live rows');
  const wanted = new Map(expected.map(row => [row.id, row]));
  return rows.filter(row => {
    const target = wanted.get(String(row.id));
    return target && row.title === target.title && (target.serverVersion === undefined || Number(row.server_version ?? row.serverVersion) === target.serverVersion);
  }).map(row => ({ id: row.id }));
}
