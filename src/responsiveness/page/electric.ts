import { Shape, ShapeStream } from '@electric-sql/client';
import { installApp } from './app.ts';
import { arrayScreen, countUpdated, toTask } from './screen.ts';

installApp(async config => {
  const abort = new AbortController();
  // Live shape through the application's scoped shape route; SDK memory cache.
  const stream = new ShapeStream({ url: `${config.origin}/electric-app/benchmark/shape/tasks`, params: { userId: config.actorId }, signal: abort.signal, parser: { int8: (value: string) => Number(value) } });
  const shape = new Shape(stream);
  let failure: unknown;
  stream.subscribe(() => {}, error => { failure = error; });
  const check = () => { if (failure) throw failure; };
  return {
    diagnostics: { storage: 'SDK memory (no persistence)', syncThread: 'main thread', queryThread: 'main thread (application filter/sort over currentValue)' },
    screen: async () => { check(); return arrayScreen(shape.currentValue.values() as any); },
    progress: async prefix => { check(); return { rows: shape.currentValue.size, updated: countUpdated(shape.currentValue.values() as any, prefix) }; },
    rows: async () => [...shape.currentValue.values()].map(row => toTask(row as any)),
    close: async () => { abort.abort(); shape.unsubscribeAll(); stream.unsubscribeAll(); },
  };
}, 'electric');
