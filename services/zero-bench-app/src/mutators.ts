import { defineMutator, defineMutatorsWithType } from '@rocicorp/zero';
import { schema, zql } from './schema.ts';

type TaskUpdate = { id: string; title: string };
const validate = (args: TaskUpdate) => {
  if (!args || typeof args.id !== 'string' || !args.id || typeof args.title !== 'string') throw new Error('Invalid task update');
};
/** The same transaction runs optimistically in the client and on the server. */
export const mutators = defineMutatorsWithType<typeof schema>()({
  tasks: {
    remove: defineMutator<{ id: string }, typeof schema>(async ({ tx, args }) => {
      if (!args || typeof args.id !== 'string' || !args.id) throw new Error('Invalid task delete');
      await tx.mutate.tasks.delete({ id: args.id });
    }),
    update: defineMutator<TaskUpdate, typeof schema>(async ({ tx, args }) => {
      validate(args);
      if (!await tx.run(zql.tasks.where('id', args.id).one())) return;
      await tx.mutate.tasks.update({ id: args.id, title: args.title });
    }),
    recoveryUpdate: defineMutator<TaskUpdate, typeof schema>(async ({ tx, args }) => {
      validate(args);
      if (!await tx.run(zql.tasks.where('id', args.id).one())) throw new Error(`Missing recovery task ${args.id}`);
      await tx.mutate.tasks.update({ id: args.id, title: args.title, server_version: 2 });
    }),
  },
});
