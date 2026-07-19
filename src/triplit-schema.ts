import { Schema as S } from '@triplit/client';

export const schema = S.Collections({
  organizations: {
    schema: S.Schema({
      id: S.Id(),
      dataset_id: S.String(),
      name: S.String(),
    }),
    relationships: {
      projects: S.RelationMany('projects', {
        where: [['org_id', '=', '$id']],
      }),
    },
  },
  projects: {
    schema: S.Schema({
      id: S.Id(),
      dataset_id: S.String(),
      org_id: S.String(),
      name: S.String(),
    }),
    relationships: {
      organization: S.RelationById('organizations', '$org_id'),
      tasks: S.RelationMany('tasks', {
        where: [['project_id', '=', '$id']],
      }),
    },
  },
  tasks: {
    schema: S.Schema({
      id: S.Id(),
      dataset_id: S.String(),
      external_id: S.String(),
      org_id: S.String(),
      project_id: S.String(),
      owner_id: S.String(),
      title: S.String(),
      completed: S.Boolean(),
      server_version: S.Number(),
      updated_at: S.String(),
    }),
    relationships: {
      project: S.RelationById('projects', '$project_id'),
    },
  },
});
