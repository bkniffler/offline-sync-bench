import { JazzClient, definePermissions, schema as s, transformRows, type QueryInput, type QueryExecutionOptions } from 'jazz-tools';
import { NapiRuntime } from 'jazz-napi';

export const appId = '782ccb53-dcba-56c0-acc8-d056d008eea3';
export const adminSecret = 'jazz-admin';
export const backendSecret = 'jazz-backend';
export const productVersion = '2.0.0-alpha.53';

export interface TaskRow {
  id: string;
  dataset_id: string;
  external_id: string;
  org_id: string;
  project_id: string;
  owner_id: string;
  title: string;
  completed: boolean;
  server_version: number;
  updated_at: Date;
}

const schema = {
  memberships: s.table({ dataset_id: s.string(), project_id: s.string(), user_id: s.string() })
    .indexOnly(['dataset_id', 'project_id', 'user_id']),
  tasks: s
    .table({
      dataset_id: s.string(),
      external_id: s.string(),
      org_id: s.string(),
      project_id: s.string(),
      owner_id: s.string(),
      title: s.string(),
      completed: s.boolean(),
      server_version: s.int(),
      updated_at: s.timestamp(),
    })
    .indexOnly([
      'dataset_id',
      'external_id',
      'org_id',
      'project_id',
      'owner_id',
      'completed',
      'updated_at',
    ]),
};
export const app = s.defineApp(schema);
export const jazzMembershipMigration = s.defineMigration({ from: { tasks: schema.tasks }, to: schema, createTables: { memberships: true } });
export const permissions = definePermissions(app, ({ policy }) => {
  policy.memberships.allowRead.always();
  policy.memberships.allowInsert.always();
  policy.memberships.allowUpdate.always();
  policy.memberships.allowDelete.always();
  policy.tasks.allowRead.always();
  policy.tasks.allowInsert.always();
  policy.tasks.allowUpdate.always();
  policy.tasks.allowDelete.always();
});
const schemaJson = JSON.stringify({
  __jazzRuntimeSchema: 1,
  schema: app.wasmSchema,
  loadedPolicyBundle: false,
});


export function createJazzNativeClient(store: string, serverUrl: string, connected = true) {
  const runtime = new NapiRuntime(schemaJson, appId, 'bench', 'main', store, 'local');
  const client = JazzClient.connectWithRuntime(runtime, { appId, schema: app.wasmSchema, serverUrl,
    backendSecret, env: 'bench', userBranch: 'main', tier: 'local', defaultDurabilityTier: 'local' }).asBackend();
  if (connected) client.connectTransport(serverUrl, { backend_secret: backendSecret });
  return client;
}

export async function queryTasks(
  client: JazzClient,
  query: QueryInput,
  options: QueryExecutionOptions
): Promise<TaskRow[]> {
  const rows = await client.query(query, options);
  return transformRows<TaskRow>(rows, app.wasmSchema, 'tasks');
}
