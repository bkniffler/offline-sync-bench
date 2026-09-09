import { ContractError } from './screens.ts';
import type { JsonObject } from '../types.ts';

export function validateElectricConflictReceipt(receipt: JsonObject, expected: { taskId: string; operation: string; idempotencyKey: string }) {
  if (receipt?.method !== 'application-sql-conflict-receipt-v1' || receipt.taskId !== expected.taskId || receipt.operation !== expected.operation
    || receipt.idempotencyKey !== expected.idempotencyKey || !Number.isSafeInteger(receipt.txid) || Number(receipt.txid) < 1
    || ![0, 1].includes(Number(receipt.affectedRows)) || typeof receipt.affectedRows !== 'number' || typeof receipt.replayed !== 'boolean') throw new ContractError('Electric conflict server receipt identity differs');
  const disposition = receipt.affectedRows === 0 ? 'missing-row-noop' : expected.operation === 'delete' ? 'deleted' : 'updated';
  if (receipt.disposition !== disposition || (disposition === 'updated' ? !Number.isSafeInteger(receipt.serverVersion) || Number(receipt.serverVersion) < 2 : receipt.serverVersion !== null)) throw new ContractError('Electric conflict SQL disposition differs');
  return receipt;
}
