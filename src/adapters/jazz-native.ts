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

const previousSchema = {
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
const previousRelatedSchema = {
  ...previousSchema,
  related_organizations: s.table({ dataset_id: s.string(), external_id: s.string(), name: s.string() })
    .indexOnly(['dataset_id', 'external_id']),
  related_projects: s.table({ dataset_id: s.string(), external_id: s.string(), organization_id: s.ref('related_organizations'), name: s.string() })
    .indexOnly(['dataset_id', 'external_id', 'organization_id']),
  related_tasks: s.table({ dataset_id: s.string(), external_id: s.string(), project_id: s.ref('related_projects'),
    org_id: s.string(), project_external_id: s.string(), owner_id: s.string(), title: s.string(), completed: s.boolean(), server_version: s.int() })
    .indexOnly(['dataset_id', 'external_id', 'project_id', 'project_external_id', 'owner_id', 'completed']),
};
const schema = {
  ...previousRelatedSchema,
  attachment_tasks: s.table({ dataset_id: s.string(), external_id: s.string(), title: s.string() }).indexOnly(['dataset_id', 'external_id']),
  file_parts: s.table({ data: s.bytes() }),
  files: s.table({ name: s.string().optional(), mimeType: s.string(), partIds: s.array(s.ref('file_parts')), partSizes: s.array(s.int()) }).indexOnly(['name']),
  task_file_links: s.table({ task_id: s.ref('attachment_tasks'), file_id: s.ref('files'), variant: s.int(), dataset_id: s.string() }).indexOnly(['dataset_id', 'variant']),
};
export const app = s.defineApp(schema);
export const jazzSchemaMigration = s.defineMigration({ from: previousRelatedSchema, to: schema, createTables: { attachment_tasks: true, file_parts: true, files: true, task_file_links: true } });
export const permissions = definePermissions(app, ({ policy }) => {
  for (const table of [policy.related_organizations, policy.related_projects, policy.related_tasks, policy.attachment_tasks, policy.file_parts, policy.files, policy.task_file_links]) {
    table.allowRead.always(); table.allowInsert.always(); table.allowUpdate.always(); table.allowDelete.always();
  }
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
