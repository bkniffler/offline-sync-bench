import { ContractError } from './screens.ts';
import type { JsonObject } from '../types.ts';

export function validateOutage(before: JsonObject | undefined, after: JsonObject | undefined): void {
  for (const snapshot of [before, after]) {
    if (snapshot?.blocked !== true) throw new ContractError('Client outage is not active');
    for (const field of ['rejectedConnections', 'forwardedConnections', 'requestBytes', 'responseBytes']) {
      if (typeof snapshot[field] !== 'number' || !Number.isSafeInteger(snapshot[field]) || Number(snapshot[field]) < 0) throw new ContractError(`Missing or invalid outage ${field}`);
    }
  }
  if (Number(after!.rejectedConnections) <= Number(before!.rejectedConnections) || after!.requestBytes !== before!.requestBytes || after!.forwardedConnections !== before!.forwardedConnections) throw new ContractError('Client outage did not reject a probe without forwarding traffic');
}
