import { ContractError, type Row } from '../contracts/screens.ts';
import type { JsonObject } from '../types.ts';

/** Parent monotonic receipt times. The observer is armed before starting sync;
 * its completion callback runs independently of the writer acknowledgment. */
export async function measureAttachmentSync(
  observe: (armed: () => void) => Promise<Row[]>,
  sync: (uploaded: (receipt: JsonObject) => void) => Promise<JsonObject>,
) {
  let arm!: () => void, rejectArm!: (error: unknown) => void;
  const armed = new Promise<void>((resolve, reject) => { arm = resolve; rejectArm = reject; });
  let visibleAt: number | undefined;
  const observing = observe(arm).then(rows => { visibleAt = performance.now(); return rows; });
  void observing.catch(rejectArm);
  await armed;
  const started = performance.now();
  const uploads: JsonObject[] = [];
  const acknowledgment = await sync(receipt => uploads.push({ ...receipt, atMs: performance.now() - started }));
  const serverAcceptedMs = performance.now() - started;
  const rows = await observing;
  if (visibleAt === undefined || visibleAt < started || uploads.length !== 1) throw new ContractError('Attachment milestone missing or observer saw preexisting metadata');
  return { uploadMs: Number(uploads[0]!.atMs), serverAcceptedMs, metadataVisibleMs: visibleAt - started, uploads, acknowledgment, rows };
}
