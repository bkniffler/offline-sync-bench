import type { Row } from '../contracts/screens.ts';

/** Read the product's persisted rows before reporting full materialization.
 * Exact values are checked by the controller outside the timed window. */
export async function readPersistedSnapshot(read: () => Promise<Row[]>, count: number, timeoutMs = 30_000) {
  const started = performance.now();
  let scans = 0;
  while (true) {
    const rows = await read();
    scans++;
    if (rows.length === count) return { rows, scans };
    if (rows.length > count) throw new Error('Persisted startup snapshot exceeds the active collection');
    if (performance.now() - started >= timeoutMs) throw new Error('Persisted startup snapshot did not catch up');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
