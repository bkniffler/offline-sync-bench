import { boolean, createBuilder, createSchema, defineQueriesWithType, defineQuery, number, string, table, relationships } from '@rocicorp/zero';

const organizations = table('organizations')
  .columns({
    id: string(),
    name: string(),
  })
  .primaryKey('id');

const projects = table('projects')
  .columns({
    id: string(),
    org_id: string(),
    name: string(),
  })
  .primaryKey('id');

const tasks = table('tasks')
  .columns({
    id: string(),
    org_id: string(),
    project_id: string(),
    owner_id: string(),
    title: string(),
    completed: boolean(),
    server_version: number(),
    updated_at: number(),
  })
  .primaryKey('id');

const memberships = table('project_memberships').columns({ project_id: string(), user_id: string(), role: string() }).primaryKey('project_id', 'user_id');
const taskRelationships = relationships(tasks, ({ many, one }) => ({
  memberships: many({ sourceField: ['project_id'], destSchema: memberships, destField: ['project_id'] }),
  project: one({ sourceField: ['project_id'], destSchema: projects, destField: ['id'] }),
}));
const projectRelationships = relationships(projects, ({ many, one }) => ({
  organization: one({ sourceField: ['org_id'], destSchema: organizations, destField: ['id'] }),
  tasks: many({ sourceField: ['id'], destSchema: tasks, destField: ['project_id'] }),
}));
export const schema = createSchema({
  tables: [organizations, projects, tasks, memberships],
  relationships: [taskRelationships, projectRelationships],
  enableLegacyQueries: false,
  enableLegacyMutators: false,
});

export const zql = createBuilder(schema);

export const queries = defineQueriesWithType<typeof schema>()({
  screens: {
    search: defineQuery(({ args }: { args: { projectId: string } }) => zql.tasks
      .where('project_id', args.projectId)
      .where('id', '>=', `${args.projectId}-task-00`).where('id', '<', `${args.projectId}-task-01`)
      .orderBy('id', 'asc').limit(100)),
    aggregate: defineQuery(({ args }: { args: { projectId: string } }) => zql.tasks.where('project_id', args.projectId)),
    dashboard: defineQuery(({ args }: { args: { orgId: string } }) => zql.projects
      .where('org_id', args.orgId).related('organization').related('tasks')),
    detail: defineQuery(({ args }: { args: { projectId: string } }) => zql.tasks
      .where('project_id', args.projectId).orderBy('id', 'asc').limit(100)
      .related('project', q => q.related('organization'))),
  },
  access: {
    tasks: defineQuery(({ ctx }: { ctx: unknown }) => {
      const actor = ctx as { userId?: string } | undefined;
      if (!actor?.userId) throw new Error('Authenticated access actor required');
      return zql.tasks.whereExists('memberships', q => q.where('user_id', actor.userId!)).orderBy('id', 'asc');
    }),
  },
  organizations: {
    all: defineQuery(() => zql.organizations.orderBy('id', 'asc')),
  },
  projects: {
    all: defineQuery(() => zql.projects.orderBy('id', 'asc')),
  },
  tasks: {
    all: defineQuery(() => zql.tasks.orderBy('id', 'asc')),
    startupScreen: defineQuery(({ args }: { args: { projectId: string; ownerId: string } }) => zql.tasks
      .where('project_id', args.projectId)
      .where('owner_id', args.ownerId)
      .where('completed', false).orderBy('id', 'desc').limit(50)),
  },
});
