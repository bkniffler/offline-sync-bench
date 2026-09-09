import { jwtVerify } from 'jose';

export interface BenchmarkAuth { userId: string; profile: 'global' | 'access' }
// The local harness supplies identities. This is a fixed benchmark signing key.
const key = new TextEncoder().encode('benchsecret');
export async function authenticate(header: string | null | undefined): Promise<BenchmarkAuth> {
  if (!header?.startsWith('Bearer ')) throw new Error('Bearer token required');
  const { payload } = await jwtVerify(header.slice(7), key, { algorithms: ['HS256'] });
  if (!payload.sub) throw new Error('JWT subject required');
  if (payload.bench_profile !== undefined && payload.bench_profile !== 'global' && payload.bench_profile !== 'access') throw new Error('Unknown benchmark grant');
  return { userId: payload.sub, profile: payload.bench_profile === 'access' ? 'access' : 'global' };
}
export function authorizeQuery(auth: BenchmarkAuth, name: string): void {
  if ((name === 'access.tasks') !== (auth.profile === 'access')) throw new Error('Query outside benchmark grant');
}
