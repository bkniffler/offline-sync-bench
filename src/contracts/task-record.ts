import type { JsonObject } from '../types.ts';

export type Row = Record<string, unknown>;
export class ContractError extends Error {
  evidence?: JsonObject;
  constructor(message: string) { super(`Invalid measurement: ${message}`); this.name = 'ContractError'; }
}

/** Browser-safe normalization shared with the complete fixture validator. */
export function taskRecord(row: Row): Row {
  const completed = row.completed;
  if (![true, false, 0, 1].includes(completed as boolean | number)) {
    throw new ContractError(`invalid task completed value for ${row.id}`);
  }
  return {
    id: row.id, org_id: row.org_id ?? row.orgId,
    project_id: row.project_id ?? row.projectId, owner_id: row.owner_id ?? row.ownerId,
    title: row.title, completed: Number(completed),
    server_version: Number(row.server_version ?? row.serverVersion),
  };
}
