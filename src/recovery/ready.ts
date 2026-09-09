import { ContractError } from '../contracts/screens.ts';
import { validateRecoveryState } from '../contracts/recovery.ts';
import type { RecoveryState, RecoveryMutation } from './protocol.ts';

/** Native completion is a hint: a reseeded server cache can still be catching
 * up. Require the actual canonical records before the measured outage starts. */
export async function awaitRecoveryReady(client: { sync(): Promise<unknown>; read(): Promise<RecoveryState> }, label: string,
  { timeoutMs = 60_000, pollMs = 25, mutations = [] as RecoveryMutation[] } = {}): Promise<{ state: RecoveryState; digest: string }> {
  let lastMismatch: string | null = null, observations = 0;
  let expired = false;
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      reject(Object.assign(new ContractError(`${label}: canonical recovery setup timed out`),
        { evidence: { recoveryReadiness: { label, timeoutMs, observations, lastMismatch } } }));
    }, timeoutMs);
  });
  const observe = async () => {
    while (!expired) {
      await client.sync();
      if (expired) break;
      const state = await client.read(); observations++;
      if (expired) break;
      try { return { state, digest: validateRecoveryState(label, state, mutations, 'empty') }; }
      catch (error) {
        if (!(error instanceof ContractError)) throw error;
        lastMismatch = error.message;
      }
      await new Promise(resolve => setTimeout(resolve, pollMs));
    }
    throw new ContractError(`${label}: recovery setup expired`);
  };
  try { return await Promise.race([observe(), deadline]); }
  finally { expired = true; clearTimeout(timer!); }
}
