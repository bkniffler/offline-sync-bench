import { Zero, createSchema, table, string, createBuilder, defineMutatorsWithType, defineMutatorWithType, defineQueriesWithType, defineQueryWithType } from '@rocicorp/zero';
const schema = createSchema({ tables: [table('tasks').columns({ id: string(), title: string() }).primaryKey('id')] });
const builder = createBuilder(schema);
const queries = defineQueriesWithType<typeof schema>()({ all: defineQueryWithType<typeof schema>()(() => builder.tasks) });
const mutators = defineMutatorsWithType<typeof schema>()({ add: defineMutatorWithType<typeof schema>()(async ({ tx }) => { await tx.mutate.tasks.insert({ id: 'task-1', title: 'footprint' }); }) });
(globalThis as any).sizeProbe = async (phase: string) => {
 const zero = new Zero({ schema, mutators, userID: 'footprint', storageKey: 'footprint', kvStore: 'idb', cacheURL: null });
 try {
  if (phase === 'write') { const result = await zero.mutate(mutators.add()).client; if (result.type !== 'success') throw new Error(JSON.stringify(result)); }
  const view = zero.materialize(queries.all());
  try {
   const end = Date.now() + 10000;
   while (!view.data.length && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 20));
   if (phase === 'write') await new Promise(resolve => setTimeout(resolve, 2000));
   return { rows: Array.from(view.data), storage: 'IndexedDB' };
  } finally { view.destroy(); }
 } finally { await zero.close(); }
};
