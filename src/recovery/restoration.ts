import { ContractError } from '../contracts/screens.ts';
/** Wait for an absolute monotonic deadline. A slow setup never moves it. */
export async function waitForRestoration(deadline: number, now = () => performance.now(), sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))): Promise<void> {
  if (now() >= deadline) throw new ContractError('Recovery offline checks missed the restoration deadline');
  while (now() < deadline) await sleep(deadline - now());
}
