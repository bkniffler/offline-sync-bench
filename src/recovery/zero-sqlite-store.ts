import { Database } from 'bun:sqlite';
import { mkdirSync, rmSync } from 'node:fs';
import { SQLiteStore, dropStore, type SQLiteDatabase, type StoreProvider } from '@rocicorp/zero/sqlite';

/** Use Zero's public SQLite store implementation (transactions, locks, batching
 * and serialization). Only the platform SQLite delegate belongs to the harness. */
export function createZeroSQLiteStore(directory: string): StoreProvider {
  mkdirSync(directory, { recursive: true });
  const delegate = (filename: string): SQLiteDatabase => {
    const db = new Database(filename, { create: true });
    return {
      close: () => db.close(),
      destroy: () => { db.close(); for (const suffix of ['', '-wal', '-shm']) rmSync(`${filename}${suffix}`, { force: true }); },
      execSync: sql => db.exec(sql),
      prepare: sql => {
        const statement = db.query(sql);
        return { exec: async params => { statement.run(...params); }, all: async params => statement.values(...params) };
      },
    };
  };
  const options = { directory, journalMode: 'WAL', synchronous: 'FULL' } as const;
  return { create: name => new SQLiteStore(name, delegate, options), drop: name => dropStore(name, delegate, options) };
}
