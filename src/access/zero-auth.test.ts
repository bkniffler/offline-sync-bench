import { expect, test } from 'bun:test';
import { SignJWT } from 'jose';
import { handleQueryRequest } from '@rocicorp/zero/server';
import { authenticate, authorizeQuery } from '../../services/zero-bench-app/src/auth.ts';
import { schema, queries } from '../../services/zero-bench-app/src/schema.ts';
const key = new TextEncoder().encode('benchsecret');
async function token(claims: Record<string, string> = {}, signingKey = key) {
  return new SignJWT(claims).setProtectedHeader({ alg: 'HS256' }).setSubject('actor-A').setExpirationTime('5m').sign(signingKey);
}
test('Zero query grants require a verified actor and prevent global-query bypass', async () => {
  const access = await authenticate(`Bearer ${await token({ bench_profile: 'access' })}`);
  expect(access).toEqual({ userId: 'actor-A', profile: 'access' });
  expect(() => authorizeQuery(access, 'access.tasks')).not.toThrow();
  for (const name of ['tasks.all', 'projects.all', 'organizations.all', 'tasks.startupScreen']) expect(() => authorizeQuery(access, name)).toThrow('outside');
  const global = await authenticate(`Bearer ${await token()}`);
  expect(() => authorizeQuery(global, 'tasks.all')).not.toThrow();
  expect(() => authorizeQuery(global, 'access.tasks')).toThrow('outside');
  await expect(authenticate(null)).rejects.toThrow('Bearer');
  await expect(authenticate(`Bearer ${await token({}, new TextEncoder().encode('wrong-key'))}`)).rejects.toThrow();
  await expect(authenticate(`Bearer ${await token({ bench_profile: 'unknown' })}`)).rejects.toThrow('Unknown');
});
test('Zero server query uses the authenticated actor in the native membership relation', async () => {
  const result = await handleQueryRequest({ schema, userID: 'actor-A', body: ['transform', [{ id: 'q1', name: 'access.tasks', args: [{ userId: 'actor-B' }] }]], query: {},
    handler: (_name, args) => queries.access.tasks.fn({ args, ctx: { userId: 'actor-A' } }) });
  expect(result).toMatchObject({ kind: 'QueryResponse' });
  const ast = JSON.stringify(result);
  expect(ast).toContain('project_memberships');
  expect(ast).toContain('actor-A');
  expect(ast).not.toContain('actor-B');
});
