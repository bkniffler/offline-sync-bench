import { screenOrgId, screenProjectId, type ScreenData, type Row } from './screens.ts';

/** Application-maintained lookup/order indexes, prepared alongside the local
 * snapshot. Aggregates are computed on every query, never cached answers. */
export function indexRelatedScreens(data: ScreenData) {
  const organizations = new Map((data.organizations ?? []).map(o => [o.id, o]));
  const projects = new Map((data.projects ?? []).map(p => [p.id, p]));
  const tasks = new Map<unknown, Row[]>();
  for (const task of data.tasks) { const group = tasks.get(task.project_id) ?? []; group.push(task); tasks.set(task.project_id, group); }
  for (const group of tasks.values()) group.sort((a,b) => String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0);
  return (name: string): Row[] => {
    if (name === 'detail_join') {
      const project = projects.get(screenProjectId), org = organizations.get(project?.org_id);
      if (!project || !org) return [];
      return (tasks.get(screenProjectId) ?? []).slice(0, 100).map(t => ({ id: t.id, title: t.title, project_name: project.name, org_name: org.name }));
    }
    if (name !== 'dashboard') throw new Error(`Unexpected related screen ${name}`);
    const org = organizations.get(screenOrgId);
    if (!org) return [];
    return [...projects.values()].filter(p => p.org_id === org.id).map(p => {
      const group = tasks.get(p.id) ?? [];
      let completed = 0;
      for (const task of group) if (task.completed) completed++;
      return { org_name: org.name, project_id: p.id, project_name: p.name, task_count: group.length,
        completed_task_count: completed, open_task_count: group.length - completed };
    }).sort((a,b) => b.open_task_count - a.open_task_count || (String(a.project_id) < String(b.project_id) ? -1 : String(a.project_id) > String(b.project_id) ? 1 : 0)).slice(0,20);
  };
}
