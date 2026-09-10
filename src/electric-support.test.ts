import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ElectricBenchmarkAdapter } from './adapters/electric.ts';
import { adapterMethods } from './execution.ts';
import { electricWriteScenarios } from './electric-support.ts';
import { createElectricReadCacheDriver } from './recovery/electric-driver.ts';

test('plain Electric rejects every client-write workload before any service setup', async () => {
  const adapter=new ElectricBenchmarkAdapter();
  for(const scenario of electricWriteScenarios){
    const result=await adapter[adapterMethods[scenario]]();
    expect(result.status).toBe('unsupported');
    expect(result.metrics).toEqual({});
    expect((result.metadata as import('./types.ts').JsonObject).coverage).toMatchObject({status:'unsupported-tested-configuration'});
  }
});
test('Electric cache reopens offline without creating a queue and rejects writes', async () => {
  const dir=await mkdtemp(join(tmpdir(),'electric-read-cache-'));
  const path=join(dir,'cache.sqlite');
  const db=new Database(path);
  db.run('CREATE TABLE recovery_tasks (id TEXT PRIMARY KEY, record TEXT NOT NULL)');
  const row={id:'task',title:'unchanged'};
  db.query('INSERT INTO recovery_tasks VALUES (?,?)').run('task',JSON.stringify(row));db.close();
  const driver=await createElectricReadCacheDriver({stackId:'electric',clientId:'read-only',actorId:'actor',projectId:'project',dbPath:path,reopen:true,syncBaseUrl:'http://127.0.0.1:1',appBaseUrl:'http://127.0.0.1:1'});
  try {
    expect(await driver.rows()).toEqual([row]);
    await expect(driver.write([{id:'task',title:'changed'}])).rejects.toThrow('not supported');
    await expect(driver.remove('task')).rejects.toThrow('not supported');
    await expect(driver.probeSync()).rejects.toThrow('not supported');
    expect(await driver.rows()).toEqual([row]);
    const check=new Database(path,{readonly:true});
    expect(check.query("SELECT name FROM sqlite_master WHERE name='recovery_outbox'").all()).toEqual([]);check.close();
  } finally {await driver.close();await rm(dir,{recursive:true,force:true});}
});
