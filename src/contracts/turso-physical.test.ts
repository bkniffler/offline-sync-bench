import { expect, test } from 'bun:test';
import { validateTursoPhysicalState } from './turso-physical.ts';
import type { JsonObject } from '../types.ts';

test('Turso physical evidence keeps server files and replica page statistics distinct', () => {
  const server = { method: 'server-main-and-wal-file-stat-v1', containerId: 'server', files: { 'server.db': { exists: true, bytes: 4096 }, 'server.db-wal': { exists: true, bytes: 100000 } } };
  const good: JsonObject = { serverBefore: server, serverAfter: structuredClone(server), clientReplica: { method: 'native-client-replica-pragmas-v1', pageSize: 4096, pageCount: 20, freelistCount: 10 } };
  expect(() => validateTursoPhysicalState(good, 'server')).not.toThrow();
  for (const mutate of [
    (s: JsonObject) => { delete s.serverBefore; },
    (s: JsonObject) => { (s.serverAfter as JsonObject).containerId = 'replacement'; },
    (s: JsonObject) => { (s.clientReplica as JsonObject).pageCount = '20'; },
    (s: JsonObject) => { (s.clientReplica as JsonObject).pageSize = 4000; },
    (s: JsonObject) => { (s.clientReplica as JsonObject).freelistCount = 21; },
    (s: JsonObject) => { (((s.serverBefore as JsonObject).files as JsonObject)['server.db'] as JsonObject).bytes = -1; },
  ]) { const bad = structuredClone(good); mutate(bad); expect(() => validateTursoPhysicalState(bad, 'server')).toThrow(); }
});
