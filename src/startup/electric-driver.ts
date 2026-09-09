import { Shape, ShapeStream } from '@electric-sql/client';
import { arrayScreenQuery, taskRecord, type Row } from '../contracts/screens.ts';
import type { RecoveryClientConfig, RecoveryDriver } from '../recovery/protocol.ts';

/** A fresh SDK memory cache. Startup does not borrow the access-refresh
 * driver's cache replacement behavior or add an application write queue. */
export async function createElectricStartupDriver(config: RecoveryClientConfig): Promise<RecoveryDriver> {
  if (!config.appBaseUrl) throw new Error('Electric startup requires the scoped application shape route');
  const abort = new AbortController();
  const stream = new ShapeStream({ url: `${config.appBaseUrl}/benchmark/shape/tasks`,
    params: { userId: config.actorId }, subscribe: false, signal: abort.signal,
    parser: { int8: (value: string) => Number(value) },
  });
  const shape = new Shape(stream);
  const rows = () => shape.currentRows as Row[];
  const unsupported = async () => { throw new Error('The Electric startup driver is read-only'); };
  const diagnostics = {
    localStorage: 'electric-shape-memory',
    queryEngine: 'application filter/sort/projection over SDK currentRows',
    authorization: 'application shape proxy derives scope from actor memberships',
    initialCache: { id: config.clientId, kind: 'memory', clientConstructed: true, rows: shape.currentValue.size, syncStarted: stream.hasStarted() },
    persistence: 'none; no process durability claim',
  };
  return {
    rows: async () => rows().map(taskRecord),
    firstScreen: async () => arrayScreenQuery('list', { tasks: rows() }),
    count: async () => shape.currentValue.size,
    pending: async () => 0,
    read: async () => ({ rows: rows().map(taskRecord), pending: 0, rejected: null, conflicts: null }),
    write: unsupported, remove: unsupported, probeSync: unsupported,
    sync: async () => {
      // The SDK starts its stream during Shape construction. Initialization
      // includes that constructor; this milestone waits for its existing work.
      await shape.rows;
    },
    close: async () => { abort.abort(); shape.unsubscribeAll(); stream.unsubscribeAll(); },
    diagnostics,
  };
}
