import type Database from 'better-sqlite3';
import type { StorageAdapter } from '@tanstack/offline-transactions';

/** The SDK owns serialization, restoration and retries; this adapter only stores
 * its opaque values. Each acknowledgment follows a synchronous SQLite commit. */
export function createSQLiteOutbox(database: Database.Database, namespace: string): StorageAdapter {
  database.pragma('journal_mode = WAL');
  database.pragma('synchronous = FULL');
  database.exec('CREATE TABLE IF NOT EXISTS benchmark_offline_storage (namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(namespace, key))');
  const read = database.prepare('SELECT value FROM benchmark_offline_storage WHERE namespace = ? AND key = ?');
  const write = database.prepare('INSERT INTO benchmark_offline_storage VALUES (?, ?, ?) ON CONFLICT(namespace, key) DO UPDATE SET value=excluded.value');
  const remove = database.prepare('DELETE FROM benchmark_offline_storage WHERE namespace = ? AND key = ?');
  const keys = database.prepare('SELECT key FROM benchmark_offline_storage WHERE namespace = ? ORDER BY key');
  const clear = database.prepare('DELETE FROM benchmark_offline_storage WHERE namespace = ?');
  return {
    get: async key => (read.get(namespace, key) as { value: string } | undefined)?.value ?? null,
    set: async (key, value) => { write.run(namespace, key, value); },
    delete: async key => { remove.run(namespace, key); },
    keys: async () => (keys.all(namespace) as { key: string }[]).map(row => row.key),
    clear: async () => { clear.run(namespace); },
  };
}
