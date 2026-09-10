import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import type { JsonObject } from '../types.ts';
import { screenQueries } from '../contracts/screens.ts';
import { deliveryQuery, pollDelivery } from '../fanout/observe.ts';
import { observeBootstrap } from './startup-observer.ts';
import type { RecoveryClientConfig, RecoveryDriver, RecoveryMutation, RecoveryObservation } from './protocol.ts';

/** The parent passes only configuration on reopen, never reconstructed rows or
 * an outbox. Product storage must recover acknowledged offline writes itself. */
async function createDriver(config: RecoveryClientConfig): Promise<RecoveryDriver> {
  if (config.accessNative && config.stackId === 'jazz-v2') return config.accessAdmin
    ? (await import('../access/jazz-admin.ts')).createJazzAccessAdmin(config)
    : (await import('../access/jazz-driver.ts')).createJazzAccessDriver(config);
  if (config.accessNative && config.stackId === 'zero') return (await import('../access/zero-driver.ts')).createZeroAccessDriver(config);
  if (config.recovery && config.stackId === 'electric') return (await import('./electric-driver.ts')).createElectricReadCacheDriver(config);
  if (config.recovery && config.stackId === 'electric-tanstack') return (await import('./tanstack-driver.ts')).createTanStackRecoveryDriver(config);
  if (config.recovery && config.stackId === 'zero') return (await import('./zero-driver.ts')).createZeroRecoveryDriver(config);
  if (config.recovery && config.stackId === 'jazz-v2') return (await import('./jazz-driver.ts')).createJazzRecoveryDriver(config);
  if (config.startup && config.stackId === 'electric') return (await import('../startup/electric-driver.ts')).createElectricStartupDriver(config);
  if (config.startup && config.stackId === 'electric-tanstack') return (await import('../startup/tanstack-driver.ts')).createTanStackStartupDriver(config);
  if (config.startup && config.stackId === 'jazz-v2') return (await import('../startup/jazz-driver.ts')).createJazzStartupDriver(config);
  if (config.startup && config.stackId === 'zero') return (await import('../startup/zero-driver.ts')).createZeroStartupDriver(config);
  if (config.accessRefresh && ['electric', 'electric-tanstack'].includes(config.stackId)) return (await import('../access/refresh-driver.ts')).createAccessRefreshDriver(config);
  if (config.stackId === 'syncular') {
    const { createBenchClient, subscribeTasks, subscribeBlobEntries } = await import('../adapters/syncular.ts');
    const fault = { blocked: false, rejectedPuts: 0 };
    let uploadObserver: ((receipt: JsonObject) => void) | undefined;
    const bench = await createBenchClient(config.actorId, config.attachments ? fault : undefined, { ...config, ...(config.attachments ? { onBlobUploaded: (receipt: { route: string; byteLength: number }) => uploadObserver?.(receipt) } : {}) });
    subscribeTasks(bench, config.projectIds ?? [config.projectId]);
    if (config.attachments) subscribeBlobEntries(bench, config.projectIds ?? [config.projectId]);
    return {
      attachments: config.attachments ? (await import('../attachments/driver.ts')).jsAttachments(bench.client, fault, observer => { uploadObserver = observer; }) : undefined,
      fetchBlob: async ref => (await bench.client.fetchBlob(ref)).bytes,
      blobCacheCount: async () => Number(bench.client.query('SELECT count(*) AS n FROM _syncular_blobs')[0]!.n),
      rows: async () => bench.client.query('SELECT * FROM tasks ORDER BY id'),
      firstScreen: async () => bench.client.query(screenQueries.list),
      count: async () => Number(bench.client.query('SELECT count(*) AS n FROM tasks')[0]!.n),
      pending: async () => bench.client.pendingCommits().length,
      read: async () => ({ rows: bench.client.query('SELECT * FROM tasks ORDER BY id'), pending: bench.client.pendingCommits().length, rejected: bench.client.rejections().length, conflicts: bench.client.conflicts().length,
        nativeState: { conflicts: bench.client.conflicts().map(c => ({ code: c.code, rowId: c.rowId, serverVersion: c.serverVersion })), rejections: bench.client.rejections().map(r => ({ code: r.code, rowId: r.operation?.rowId ?? null })) },
      }),
      remove: async id => { bench.client.mutate([{ table: 'tasks', op: 'delete', rowId: id }]); },
      write: async mutations => {
        for (const mutation of mutations) {
          const row = bench.client.query('SELECT *, _sync_version AS bench_base_version FROM tasks WHERE id = ?', [mutation.id])[0];
          if (!row) throw new Error(`Missing local task ${mutation.id}`);
          bench.client.mutate([{ table: 'tasks', op: 'upsert', ...(mutation.checkVersion ? { baseVersion: Number(row.bench_base_version) } : {}), values: {
            id: row.id, org_id: row.org_id, project_id: row.project_id, owner_id: row.owner_id,
            title: mutation.title, completed: Boolean(row.completed), server_version: 2, updated_at_ms: Date.now(),
          } }]);
        }
      },
      sync: async () => { await bench.client.syncUntilIdle(1_000); },
      probeSync: async () => { await bench.client.sync(); },
      connectDelivery: () => bench.connectRealtimeReady(),
      pauseDelivery: async () => { bench.client.disconnectRealtime(); },
      observeDelivery: expected => pollDelivery(expected, async () => { const q = deliveryQuery(expected); return bench.client.query(q.sql, q.params); }),
      close: () => bench.close(),
      diagnostics: { localStorage: 'bun:sqlite-file', outbox: 'product SQLite outbox', sync: 'explicit HTTP sync; no realtime transport connected' },
    };
  }
  if (config.stackId === 'syncular-rust') {
    const { RustClient, ensureBenchBinary } = await import('../adapters/syncular-rust.ts');
    const client = await RustClient.start({ ...config, binPath: await ensureBenchBinary() });
    if (config.blobDownloadProxy) await client.call('setBlobDownloadProxy', { ...config.blobDownloadProxy });
    for (const projectId of config.projectIds ?? [config.projectId]) await client.subscribe(`tasks:${projectId}`, 'tasks', { project_id: [projectId] });
    if (config.attachments) for (const projectId of config.projectIds ?? [config.projectId]) await client.subscribe(`blobs:${projectId}`, 'task_blob_entries', { project_id: [projectId] });
    return {
      attachments: config.attachments ? (await import('../attachments/driver.ts')).rustAttachments(client) : undefined,
      fetchBlob: async ref => {
        const result = await client.call('fetchBlob', { blob: ref });
        const bytes = (result.blob as { bytes?: { $bytes?: string } })?.bytes?.$bytes;
        if (typeof bytes !== 'string' || bytes.length % 2 || !/^[0-9a-f]*$/i.test(bytes)) throw new Error('Rust fetchBlob returned invalid bytes');
        return Buffer.from(bytes, 'hex');
      },
      blobCacheCount: () => client.count('SELECT count(*) AS n FROM _syncular_blobs'),
      rows: () => client.queryRows('SELECT * FROM tasks ORDER BY id'),
      firstScreen: () => client.queryRows(screenQueries.list),
      count: () => client.count('SELECT count(*) AS n FROM tasks'),
      pending: async () => ((await client.call('pendingCommitIds')).ids as unknown[]).length,
      read: async () => ({ rows: await client.queryRows('SELECT * FROM tasks ORDER BY id'),
        pending: ((await client.call('pendingCommitIds')).ids as unknown[]).length,
        rejected: ((await client.call('rejections')).rejections as unknown[]).length,
        conflicts: ((await client.call('conflicts')).conflicts as unknown[]).length,
        nativeState: { conflicts: (await client.call('conflicts')).conflicts, rejections: (await client.call('rejections')).rejections },
      }),
      remove: async id => { await client.call('mutate', { mutations: [{ table: 'tasks', op: 'delete', rowId: id }] }); },
      write: async mutations => {
        for (const mutation of mutations) {
          const row = (await client.queryRows('SELECT * FROM tasks WHERE id = ?', [mutation.id]))[0];
          if (!row) throw new Error(`Missing local task ${mutation.id}`);
          await client.call('mutate', { mutations: [{ table: 'tasks', op: 'upsert', baseVersion: Number(row._syncular_version), values: {
            id: row.id, org_id: row.org_id, project_id: row.project_id, owner_id: row.owner_id,
            title: mutation.title, completed: Boolean(row.completed), server_version: 2, updated_at_ms: Date.now(),
          } }] });
        }
      },
      initialSync: async () => {
        // Let queued native queries execute between sync rounds. A round itself
        // is serialized by the product driver and cannot expose intermediate rows.
        for (let round = 0; round < 1_000; round++) {
          const outcome = await client.call('sync');
          if (outcome.ok === false) throw new Error(`Rust initial sync failed: ${JSON.stringify(outcome)}`);
          if ((await client.call('statusSnapshot')).syncNeeded !== true) return;
        }
        throw new Error('Rust initial sync did not reach idle');
      },
      connectDelivery: async () => { await client.call('connectRealtime'); },
      pauseDelivery: async () => { await client.call('disconnectRealtime'); },
      observeDelivery: async expected => {
        const q = deliveryQuery(expected);
        const result = await client.waitForQuery({ sql: q.sql, params: q.params, matchCount: { op: 'eq', value: expected.length }, timeoutMs: 90_000, pollIntervalMs: 5 });
        if (!result.ok) throw new Error('Rust connected delivery timed out');
      },
      sync: () => client.syncToIdle(), close: () => client.close(),
      probeSync: async () => { await client.call('sync'); },
      diagnostics: { localStorage: 'rusqlite-file', outbox: 'product SQLite outbox', sync: 'explicit HTTP sync; no realtime transport connected' },
    };
  }
  if (config.stackId === 'turso') {
    const { connect } = await import('@tursodatabase/sync');
    const db = await connect({ path: config.dbPath, url: config.syncBaseUrl, clientName: config.clientId, pushOperationsThreshold: 2_000, ...(config.deliveryMode ? { longPollTimeoutMs: 1_000 } : {}) });
    let deliveryRunning = false, deliveryLoop: Promise<void> | undefined, deliveryError: unknown;
    const pauseDelivery = async () => { deliveryRunning = false; await deliveryLoop; };
    const syncEvents: Array<Record<string, number>> = [];
    // cdcOperations also counts commit markers and sync bookkeeping. These
    // states are read before upload or after a completed push/pull; inspect task
    // changes separately and preserve the raw native counter as diagnostics.
    const pending = async () => Number((await (await db.prepare("SELECT count(*) AS n FROM turso_cdc WHERE table_name = 'tasks' AND change_type IN (-1, 0, 1)")).get()).n);
    return {
      rows: async () => (await db.prepare('SELECT * FROM tasks ORDER BY id')).all(),
      firstScreen: async () => (await db.prepare(screenQueries.list)).all(),
      count: async () => Number((await (await db.prepare('SELECT count(*) AS n FROM tasks')).get()).n),
      pending,
      remove: async id => { await (await db.prepare('DELETE FROM tasks WHERE id = ?')).run(id); },
      read: async () => ({ rows: await (await db.prepare('SELECT * FROM tasks ORDER BY id')).all(), pending: await pending(), rejected: null, conflicts: null, nativeState: { ...(config.startup ? { physical: { method: 'native-client-replica-pragmas-v1', pageSize: Number((await (await db.prepare('PRAGMA page_size')).get()).page_size), pageCount: Number((await (await db.prepare('PRAGMA page_count')).get()).page_count), freelistCount: Number((await (await db.prepare('PRAGMA freelist_count')).get()).freelist_count) } } : {}), syncEvents, cdcOperations: (await db.stats()).cdcOperations,
        cdc: await (await db.prepare('SELECT change_type, table_name, count(*) AS n FROM turso_cdc GROUP BY change_type, table_name')).all(),
      } }),
      write: async mutations => {
        const statement = await db.prepare('UPDATE tasks SET title = ?, server_version = 2, updated_at = ? WHERE id = ?');
        for (const mutation of mutations) await statement.run(mutation.title, new Date().toISOString(), mutation.id);
      },
      sync: async () => {
        const beforePush = (await db.stats()).cdcOperations;
        await db.push();
        const afterPush = (await db.stats()).cdcOperations;
        await db.pull();
        const afterPull = (await db.stats()).cdcOperations;
        if (beforePush || afterPush || afterPull) { syncEvents.push({ beforePush, afterPush, afterPull }); if (syncEvents.length > 10) syncEvents.shift(); }
      },
      probeSync: async () => { await db.push(); },
      connectDelivery: async () => {
        if (deliveryRunning) return;
        deliveryRunning = true; deliveryError = undefined;
        deliveryLoop = (async () => {
          while (deliveryRunning) { try { await db.pull(); } catch (error) { if (deliveryRunning) { deliveryError = error; deliveryRunning = false; } } }
        })();
      },
      pauseDelivery,
      observeDelivery: expected => pollDelivery(expected, async () => {
        if (deliveryError) throw deliveryError;
        const q = deliveryQuery(expected); return (await db.prepare(q.sql)).all(...q.params);
      }),
      close: async () => { await pauseDelivery(); await db.close(); },
      diagnostics: { localStorage: 'turso-file', outbox: 'product CDC log', queueObservation: 'retained task CDC changes before upload or after full push/pull; raw cdcOperations includes commit markers and sync bookkeeping', sync: 'explicit push/pull; queue drain includes pull completion', rejectionCounter: 'not exposed by this driver; final data validated' },
    };
  }
  if (config.stackId === 'powersync') {
    const { PowerSyncDatabase } = await import('@powersync/node');
    const { AppSchema, createConnector, installPowerSyncScreenIndexes } = await import('../adapters/powersync-runner.ts');
    const db = new PowerSyncDatabase({ schema: AppSchema, database: { dbFilename: config.dbPath } });
    await db.init();
    await installPowerSyncScreenIndexes(db);
    const connector = createConnector(config.actorId, config);
    let connected = false;
    return {
      rows: () => db.getAll('SELECT * FROM tasks ORDER BY id'),
      firstScreen: () => db.getAll(screenQueries.list),
      count: async () => Number((await db.getAll<{ n: number }>('SELECT count(*) AS n FROM tasks'))[0]!.n),
      pending: async () => (await db.getUploadQueueStats(true)).count,
      remove: async id => { await db.execute('DELETE FROM tasks WHERE id = ?', [id]); },
      read: async () => {
        const file = config.accessNative ? await stat(config.dbPath) : null;
        return { rows: await db.getAll('SELECT * FROM tasks ORDER BY id'), pending: (await db.getUploadQueueStats(true)).count, rejected: null, conflicts: null,
          ...(file ? { nativeState: { accessReplica: { kind: 'powersync-node-sqlite-file', path: config.dbPath, device: file.dev, inode: file.ino } } } : {}) };
      },
      write: async mutations => {
        for (const mutation of mutations) await db.execute('UPDATE tasks SET title = ?, server_version = 2, updated_at = ? WHERE id = ?', [mutation.title, new Date().toISOString(), mutation.id]);
      },
      sync: async () => {
        if (!connected) { await db.connect(connector); connected = true; }
        await db.waitForFirstSync();
        const deadline = performance.now() + 90_000;
        while ((await db.getUploadQueueStats(true)).count !== 0) {
          if (performance.now() > deadline) throw new Error('PowerSync upload drain timed out');
          await new Promise(resolve => setTimeout(resolve, 1));
        }
      },
      probeSync: async () => {
        // Stop retries before making one explicit call through the native upload
        // connector. Restoring the gate is followed by SDK connect at replay start.
        await db.disconnect(); connected = false;
        await connector.uploadData(db);
      },
      connectDelivery: async () => { if (!connected) { await db.connect(connector); connected = true; } },
      pauseDelivery: async () => { await db.disconnect(); connected = false; },
      observeDelivery: expected => pollDelivery(expected, async () => { const q = deliveryQuery(expected); return db.getAll(q.sql, q.params); }),
      close: async () => { await db.disconnect(); await db.close(); },
      diagnostics: { localStorage: 'powersync-node-sqlite-file', outbox: 'product SQLite CRUD queue', sync: 'SDK connect after outage; continuous reader sync', rejectionCounter: 'not exposed by this driver; final data validated' },
    };
  }
  throw new Error(`Recovery worker not implemented for ${config.stackId}`);
}

if (import.meta.main) {
  // Detached groups make deliberate crashes include the native Rust child.
  // Also terminate the group if a campaign timeout kills our controlling parent.
  const parentPid = Number(process.env.BENCH_RECOVERY_PARENT_PID);
  const orphanCheck = setInterval(() => {
    if (parentPid && process.ppid !== parentPid) process.kill(-process.pid, 'SIGKILL');
  }, 250);
  orphanCheck.unref();
  let driver: RecoveryDriver | undefined;
  let fanout = false;
  const protocolCalls: Record<string, number> = {};
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    const request = JSON.parse(line);
    protocolCalls[request.method] = (protocolCalls[request.method] ?? 0) + 1;
    try {
      let value: unknown = null;
      switch (request.method) {
        case 'bootstrap': {
          driver = await createDriver(request.params.config);
          const emit = (event: string, data: unknown) => process.stdout.write(`${JSON.stringify({ id: request.id, event, data })}\n`);
          emit('initialized', { pid: process.pid, diagnostics: driver.diagnostics });
          value = await observeBootstrap({ sync: () => (driver!.initialSync ?? driver!.sync)(), firstScreen: () => driver!.firstScreen(), count: () => driver!.count(), rows: () => driver!.rows() }, request.params.screen, request.params.count, emit);
          break;
        }
        case 'init': fanout = request.params.fanout === true; driver = await createDriver(request.params); value = { pid: process.pid, diagnostics: driver.diagnostics }; break;
        case 'read': { const state = await driver!.read(); value = fanout ? { ...state, nativeState: { ...state.nativeState, protocolCalls: { ...protocolCalls } } } : state; break; }
        case 'attachmentState': value = await driver!.attachments!.state(); break;
        case 'attachmentStage': {
          const variant = request.params.variant;
          if (variant !== 0 && variant !== 1) throw new Error('Invalid attachment variant');
          value = await driver!.attachments!.stage(variant); break;
        }
        case 'attachmentPrepare': {
          const variant = request.params.variant;
          if (variant !== 0 && variant !== 1) throw new Error('Invalid attachment variant');
          await driver!.attachments!.prepare(variant); break;
        }
        case 'attachmentFault': value = await driver!.attachments!.fault(request.params.blocked === true); break;
        case 'attachmentSync': value = await driver!.attachments!.sync(data => process.stdout.write(`${JSON.stringify({ id: request.id, event: 'blobUploaded', data })}\n`)); break;
        case 'attachmentObserve': {
          const observing = driver!.attachments!.observe(request.params.ids);
          process.stdout.write(`${JSON.stringify({ id: request.id, event: 'armed', data: { pid: process.pid } })}\n`);
          value = await observing; break;
        }
        case 'blobCacheCount': if (!driver!.blobCacheCount) throw new Error('Blob cache inspection not implemented'); value = await driver!.blobCacheCount(); break;
        case 'fetchBlob': {
          if (!driver!.fetchBlob) throw new Error('Blob download not implemented');
          const bytes = await driver!.fetchBlob(String(request.params.ref));
          process.stdout.write(`${JSON.stringify({ id: request.id, event: 'downloaded', data: { byteLength: bytes.byteLength } })}\n`);
          value = { byteLength: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
          break;
        }
        case 'rows': value = await driver!.rows(); break;
        case 'firstScreen': value = await driver!.firstScreen(); break;
        case 'write': await driver!.write(request.params as RecoveryMutation[]); break;
        case 'remove': await driver!.remove(String(request.params.id)); break;
        case 'sync': await driver!.sync(); value = { pending: await driver!.pending() }; break;
        case 'resumeDelivery': {
          if (!driver!.connectDelivery || !driver!.observeDelivery) throw new Error('Delivery resume not implemented');
          // A fresh subscription cannot assume that a wake sent during the
          // outage will be replayed. Catch up with the native sync API first.
          await driver!.sync(); await driver!.connectDelivery();
          await driver!.observeDelivery(request.params as RecoveryObservation[]); break;
        }
        case 'connectDelivery': if (!driver!.connectDelivery) throw new Error('Connected delivery not implemented'); await driver!.connectDelivery(); break;
        case 'pauseDelivery': if (!driver!.pauseDelivery) throw new Error('Delivery pause not implemented'); await driver!.pauseDelivery(); break;
        case 'observeDelivery': {
          if (!driver!.observeDelivery) throw new Error('Connected observation not implemented');
          const observing = driver!.observeDelivery(request.params as RecoveryObservation[]);
          process.stdout.write(`${JSON.stringify({ id: request.id, event: 'armed', data: { pid: process.pid } })}\n`);
          await observing; break;
        }
        case 'probeSync': await driver!.probeSync(); break;
        case 'observe': {
          const expected = request.params as RecoveryObservation[];
          const deadline = performance.now() + 90_000;
          while (true) {
            await driver!.sync();
            const rows = new Map((await driver!.rows()).map(row => [row.id, row]));
            if (expected.every(wanted => {
              const row = rows.get(wanted.id);
              return wanted.title === null ? !row : row?.title === wanted.title && (wanted.serverVersion === undefined || Number(row.server_version ?? row.serverVersion) === wanted.serverVersion);
            })) break;
            if (performance.now() >= deadline) throw new Error('Recovery reader observation timed out');
            await new Promise(resolve => setTimeout(resolve, 1));
          }
          break;
        }
        case 'close': await driver!.close(); break;
        default: throw new Error(`Unknown recovery command ${request.method}`);
      }
      process.stdout.write(`${JSON.stringify({ id: request.id, value })}\n`);
      if (request.method === 'close') process.exit(0);
    } catch (error) { process.stdout.write(`${JSON.stringify({ id: request.id, error: error instanceof Error ? error.message : String(error), evidence: error instanceof Error ? (error as Error & { evidence?: JsonObject }).evidence : undefined })}\n`); }
  }
  await driver?.close();
}
