import { createHash } from 'node:crypto';
import { JazzClient, definePermissions, transformRows, type QueryInput, type QueryExecutionOptions } from 'jazz-tools';
import { NapiRuntime, mintLocalFirstToken, verifyLocalFirstIdentityProof } from 'jazz-napi';
import { mergePermissionsIntoWasmSchema } from '../../node_modules/jazz-tools/dist/schema-permissions.js';
import { translateQuery } from '../../node_modules/jazz-tools/dist/runtime/query-adapter.js';
import { app, appId, backendSecret, type TaskRow } from '../adapters/jazz-native.ts';
import { taskRecord } from '../contracts/screens.ts';
import { accessProfile } from '../contracts/access.ts';
import type { RecoveryClientConfig } from '../recovery/protocol.ts';

export const jazzAccessPermissions = definePermissions(app, ({ policy, session }) => {
  policy.tasks.allowRead.where(task => policy.memberships.exists.where({ dataset_id: task.dataset_id, project_id: task.project_id, user_id: session.user_id }));
  policy.tasks.allowInsert.never(); policy.tasks.allowUpdate.never(); policy.tasks.allowDelete.never();
  policy.memberships.allowRead.where({ user_id: session.user_id });
  policy.memberships.allowInsert.never(); policy.memberships.allowUpdate.never(); policy.memberships.allowDelete.never();
});
export const jazzAccessSchema = mergePermissionsIntoWasmSchema(app.wasmSchema, jazzAccessPermissions);
export const jazzAccessLocal = { tier: 'local', propagation: 'local-only' } as const;
export function jazzAccessIdentity(datasetId: string, actor: string) {
  if (!datasetId.startsWith('access-') || ![accessProfile.actor, accessProfile.unaffectedActor].includes(actor)) throw new Error('Unexpected Jazz access identity');
  // Public benchmark fixture identities. No credential is written into results.
  const seed = createHash('sha256').update(`jazz-benchmark-access:${datasetId}:${actor}`).digest('base64url');
  const token = mintLocalFirstToken(seed, appId, 600);
  const proof = verifyLocalFirstIdentityProof(token, appId);
  if (!proof.ok || !proof.id) throw new Error('Jazz benchmark identity verification failed');
  return { token, nativeActorId: proof.id };
}
export function createJazzAccessClient(config: RecoveryClientConfig, admin = false) {
  if (!config.datasetId?.startsWith('access-')) throw new Error('Jazz access needs an isolated dataset');
  const identity = jazzAccessIdentity(config.datasetId, config.actorId);
  const runtime = new NapiRuntime(JSON.stringify({ __jazzRuntimeSchema: 1, schema: jazzAccessSchema, loadedPolicyBundle: true }), appId, 'bench', 'main', config.dbPath, 'local');
  const client = JazzClient.connectWithRuntime(runtime, { appId, schema: jazzAccessSchema, env: 'bench', userBranch: 'main', tier: 'local', defaultDurabilityTier: 'local', clientId: config.clientId,
    serverUrl: config.syncBaseUrl, ...(admin ? { backendSecret } : { jwtToken: identity.token }) });
  const full = app.tasks.where({ dataset_id: { eq: config.datasetId } }).orderBy('external_id', 'asc');
  const memberships = app.memberships.where({ dataset_id: { eq: config.datasetId } });
  const rawQuery = translateQuery(full._build(), full._schema);
  const nativeRows = async () => transformRows<TaskRow>(await runtime.query(rawQuery, undefined, 'local', JSON.stringify({ propagation: 'local-only' })), app.wasmSchema, 'tasks');
  const visibleRows = async (query: QueryInput = full, options: QueryExecutionOptions = jazzAccessLocal) => transformRows<TaskRow>(await client.query(query, options), app.wasmSchema, 'tasks');
  return { runtime, client, full, memberships, nativeRows, visibleRows, identity,
    connect: () => client.connectTransport(config.syncBaseUrl, admin ? { backend_secret: backendSecret } : { jwt_token: identity.token }) };
}
export const canonicalJazzAccessRows = (rows: TaskRow[]) => rows.map(row => taskRecord({ ...row, id: row.external_id })).sort((a,b) => String(a.id).localeCompare(String(b.id)));
