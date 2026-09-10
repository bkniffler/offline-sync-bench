import { Shape, ShapeStream } from '@electric-sql/client';
(globalThis as any).sizeProbe = async () => {
 const abort = new AbortController();
 const shape = new Shape(new ShapeStream({ url: `${location.origin}/shape`, params: { table: 'tasks', where: "id = 'org-1-project-1-task-000001'" }, signal: abort.signal }));
 try { return { rows: (await shape.rows).map(row => ({ id: row.id, title: row.title })), storage: 'Memory (read-only)' }; }
 finally { abort.abort(); }
};
