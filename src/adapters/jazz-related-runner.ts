import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { toWriteRecord, transformRows, type QueryInput } from 'jazz-tools';
import { deploy } from 'jazz-tools/dev';
import { app, appId, adminSecret, productVersion, createJazzNativeClient, jazzSchemaMigration, permissions } from './jazz-native.ts';
import { canonicalData, measureScreens, validateScreenData, arrayScreenQuery, screenProjectId, type Row } from '../contracts/screens.ts';
import { validateJazzDeployment } from '../contracts/jazz-deployment.ts';
import { validateSeedIsolation } from '../contracts/seeding-isolation.ts';
import { getClientStack, getStack } from '../stacks.ts';
import type { JsonObject } from '../types.ts';

const [mode, datasetId, directory, rawReceipt] = process.argv.slice(2);
if (!['seed', 'read'].includes(mode!) || !datasetId?.startsWith('related-') || !directory) throw new Error('Invalid Jazz relationship runner arguments');
const store = join(directory, `${mode}-${randomUUID()}.db`);
const startedAt = new Date().toISOString();
const local = { tier: 'local', propagation: 'local-only' } as const;

async function run() {
  if (mode === 'seed') validateJazzDeployment(await deploy({ appId, adminSecret, serverUrl: getStack('jazz-v2').syncBaseUrl,
    schema: app.wasmSchema, permissions, migration: jazzSchemaMigration }));
  const client = createJazzNativeClient(store, getClientStack('jazz-v2').syncBaseUrl);
  const query = async (table: string, builder: QueryInput, options = local, includes = {}) =>
    transformRows<Row>(await client.query(builder, options), app.wasmSchema, table, includes);
  const readData = async () => {
    const tasks = await query('related_tasks', app.related_tasks.where({ dataset_id: { eq: datasetId } }));
    const projects = await query('related_projects', app.related_projects.where({ dataset_id: { eq: datasetId } }));
    const organizations = await query('related_organizations', app.related_organizations.where({ dataset_id: { eq: datasetId } }));
    const orgs = new Map(organizations.map(o => [o.id, o.external_id]));
    return { tasks: tasks.map(t => ({ ...t, id: t.external_id, project_id: t.project_external_id })),
      projects: projects.map(p => ({ id: p.external_id, org_id: orgs.get(p.organization_id), name: p.name })),
      organizations: organizations.map(o => ({ id: o.external_id, name: o.name })) };
  };
  try {
    if (mode === 'seed') {
      const data = canonicalData('deep-relationship-query');
      const organizationId = randomUUID(), projects = new Map(data.projects!.map(p => [p.id, randomUUID()]));
      const insert = (table: string, id: string, row: Row, batch: string) => client.insertInternal(table,
        toWriteRecord({ ...row, dataset_id: datasetId }, app.wasmSchema, table), { id }, undefined, undefined, batch);
      let batch = client.beginBatch('direct');
      insert('related_organizations', organizationId, { external_id: data.organizations![0]!.id, name: data.organizations![0]!.name }, batch);
      for (const p of data.projects!) insert('related_projects', projects.get(p.id)!, { external_id: p.id, name: p.name, organization_id: organizationId }, batch);
      await client.commitBatch(batch).wait({ tier: 'edge' });
      for (let offset = 0; offset < data.tasks.length; offset += 1_000) {
        batch = client.beginBatch('direct');
        for (const t of data.tasks.slice(offset, offset + 1_000)) {
          const { id, ...fields } = t;
          insert('related_tasks', randomUUID(), { ...fields, external_id: id, project_id: projects.get(t.project_id),
            project_external_id: t.project_id, completed: Boolean(t.completed) }, batch);
        }
        await client.commitBatch(batch).wait({ tier: 'edge' });
      }
      const validation = validateScreenData('deep-relationship-query', await readData());
      return { status: 'completed', metrics: { seeded_tasks: 100_000 }, notes: [], metadata: { seedReceipt: {
        pid: process.pid, parentPid: process.ppid, store, datasetId, taskCount: 100_000, tasksDigest: validation.tasksDigest,
        productVersion, edgeDurable: true, completedAt: new Date().toISOString() } } };
    }
    const seeding = JSON.parse(rawReceipt ?? 'null') as JsonObject;
    if (!seeding || seeding.datasetId !== datasetId || seeding.pid === process.pid || seeding.exitObservedBeforeReaderSpawn !== true) throw new Error('Separate Jazz relationship seeder receipt missing');
    for (const [table, builder, count] of [
      ['related_organizations', app.related_organizations.where({ dataset_id: { eq: datasetId } }), 1],
      ['related_projects', app.related_projects.where({ dataset_id: { eq: datasetId } }), 4],
      ['related_tasks', app.related_tasks.where({ dataset_id: { eq: datasetId } }), 100_000],
    ] as const) {
      const rows = await client.query(builder, { tier: 'edge', propagation: 'full' });
      if (rows.length !== count) throw new Error(`Jazz relationship ${table} expected ${count} rows, got ${rows.length}`);
    }
    const includes = { project: { organization: true } } as const;
    const result = await measureScreens('deep-relationship-query', {
      execution: 'mixed-native-and-application', readData,
      query: async name => {
        if (name === 'detail_join') {
          const rows = await query('related_tasks', app.related_tasks.where({ dataset_id: { eq: datasetId }, project_external_id: { eq: screenProjectId } })
            .orderBy('external_id').limit(100).include(includes), local, includes);
          return rows.map(t => { const p = t.project as Row, o = p.organization as Row;
            return { id: t.external_id, title: t.title, project_name: p.name, org_name: o.name }; });
        }
        return arrayScreenQuery(name, await readData());
      },
      diagnostics: { localStorage: 'jazz-napi-sqlite-file', detail: 'native indexed query with nested project and organization includes',
        dashboard: 'native local materialization plus application aggregation',
        indexes: ['dataset_id', 'external_id', 'project_id', 'project_external_id', 'organization_id'],
        idMapping: 'external_id stores canonical IDs; native UUID references connect records', seeding: 'separate process; edge durability and observed exit before reader launch' },
    });
    const metadata = { ...result.metadata, implementation: 'jazz-related-screens-v2', productVersion, experimental: true,
      seedingIsolation: { method: 'separate-seed-process-v1', seeding, reader: { pid: process.pid, parentPid: process.ppid, store, datasetId, startedAt } } };
    validateSeedIsolation(metadata);
    return { status: 'completed', ...result, metadata };
  } finally { await client.shutdown(); }
}
run().then(result => process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(0)), error => {
  process.stderr.write(`${error.stack ?? error}\n`, () => process.exit(1));
});
