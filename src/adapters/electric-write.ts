import { validateElectricMutationReceipt } from '../contracts/electric-collaboration.ts';
import type { JsonObject } from '../types.ts';

/** The SQL mutation response is the acceptance receipt. Independent Shape
 * observation owns visibility; no administrative reread belongs on this path. */
export async function submitElectricCollaborationWrite(
  baseUrl: string,
  taskId: string,
  title: string,
  iteration: number,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<JsonObject> {
  const url = `${baseUrl.replace(/\/$/, '')}/admin/write`, request = { taskId, title };
  const response = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request), signal, redirect: 'error' });
  const receipt: JsonObject = { iteration, url, method: 'POST', request, response: { status: response.status, body: await response.json() as JsonObject } };
  try { validateElectricMutationReceipt(receipt); }
  catch (error) { throw Object.assign(error as Error, { evidence: { mutationReceipt: receipt } }); }
  return receipt;
}
