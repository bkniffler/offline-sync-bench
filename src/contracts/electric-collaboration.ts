import { collaborationIterations, collaborationSeed, collaborationWarmup } from './collaboration.ts';
import { ContractError, fixtureTasks } from './screens.ts';
import { getStack } from '../stacks.ts';
import type { JsonObject } from '../types.ts';

export const ELECTRIC_ACKNOWLEDGMENT = 'electric-mutation-response-v1';

// PostgreSQL bigint JSON values arrive as decimal strings. Preserve the raw
// response and normalize only for validation of this small fixture's versions.
function mutationVersion(value: unknown): number | null {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^[1-9][0-9]*$/.test(value))) return null;
  const version = Number(value);
  return Number.isSafeInteger(version) && version >= 2 ? version : null;
}

export function validateElectricMutationReceipt(receipt: JsonObject): void {
  const request = receipt.request as JsonObject, response = receipt.response as JsonObject;
  const body = response?.body as JsonObject, row = body?.row as JsonObject;
  if (receipt.method !== 'POST' || typeof receipt.url !== 'string' || new URL(receipt.url).pathname !== '/admin/write'
    || !request || typeof request.taskId !== 'string' || typeof request.title !== 'string'
    || response?.status !== 200 || body?.ok !== true || body.stackId !== 'electric'
    || row?.id !== request.taskId || row.title !== request.title || typeof row.completed !== 'boolean'
    || mutationVersion(row.server_version) === null) throw new ContractError('Electric mutation response does not confirm the requested write');
}

export function validateElectricCollaboration(metadata: JsonObject): void {
  if (metadata.implementation !== 'electric-collaboration-v3' || metadata.acknowledgmentContract !== ELECTRIC_ACKNOWLEDGMENT) throw new ContractError('Electric acknowledgment must use the mutation response without an administrative reread');
  validateElectricCollaborationReceipts(metadata);
}

/** Receipt semantics shared by native and browser controllers. Each controller
 * must separately validate its implementation and measurement boundary. */
export function validateElectricCollaborationReceipts(metadata: JsonObject): void {
  const receipts = metadata.mutationReceipts as JsonObject[], samples = metadata.samples as JsonObject[];
  if (!Array.isArray(receipts) || receipts.length !== collaborationWarmup + collaborationIterations || !Array.isArray(samples) || samples.length !== collaborationIterations) throw new ContractError('Electric warmup or measured mutation receipts missing');
  const endpoints = (metadata.clientRouting as JsonObject | undefined)?.endpoints as JsonObject | undefined;
  const base = endpoints?.mutationBaseUrl ?? getStack('electric').mutationBaseUrl;
  const expectedUrl = `${String(base).replace(/\/$/, '')}/admin/write`;
  const fixture = new Map(fixtureTasks(collaborationSeed).map(row => [String(row.id), row]));
  const titles = new Set<string>(); let taskId: string | undefined;
  for (const [index, receipt] of receipts.entries()) {
    validateElectricMutationReceipt(receipt);
    const request = receipt.request as JsonObject, row = ((receipt.response as JsonObject).body as JsonObject).row as JsonObject;
    taskId ??= String(request.taskId);
    const initial = fixture.get(taskId);
    if (!initial || request.taskId !== taskId || receipt.url !== expectedUrl || receipt.iteration !== index - collaborationWarmup
      || mutationVersion(row.server_version) !== index + 2 || Number(row.completed) !== Number(initial.completed)
      || !String(request.title).startsWith('collaboration-') || titles.has(String(request.title))) throw new ContractError('Electric mutation receipt order, route or task state changed');
    titles.add(String(request.title));
    if (index >= collaborationWarmup && samples[index - collaborationWarmup].title !== request.title) throw new ContractError('Electric acknowledgment receipt is not bound to its measured operation');
  }
}
