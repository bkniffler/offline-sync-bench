/** Local capability checks only; these are not benchmark performance samples. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { PowerSyncDatabase, Schema, AttachmentTable, AttachmentQueue, AttachmentState, NodeFileSystemAdapter } from '@powersync/node';
import { Db, TypedTableQueryBuilder } from 'jazz-tools';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
await mkdir(join(process.cwd(), '.tmp'), { recursive: true });
const powersyncVersion = JSON.parse(await readFile('node_modules/@powersync/node/package.json', 'utf8')).version;
const jazzVersion = JSON.parse(await readFile('node_modules/jazz-tools/package.json', 'utf8')).version;
assert.equal(powersyncVersion, '1.0.0');
assert.equal(jazzVersion, '2.0.0-alpha.53');
const dir = await mkdtemp(join(process.cwd(), '.tmp/coverage-capabilities-'));
const schema = new Schema({ attachments: new AttachmentTable() });
const dbPath = join(dir, 'attachments.sqlite');
let db;
try {
  db = new PowerSyncDatabase({ schema, database: { dbFilename: dbPath } });
  await db.init();
  const localStorage = new NodeFileSystemAdapter(join(dir, 'files'));
  await localStorage.initialize();
  let remoteCalls = 0;
  const noNetwork = async () => { remoteCalls++; throw new Error('Capability probe must remain offline'); };
  const queue = new AttachmentQueue({ db, localStorage, watchAttachments: () => {}, remoteStorage: { uploadFile: noNetwork, downloadFile: noNetwork, deleteFile: noNetwork } });
  const bytes = Buffer.alloc(2 * 1024 * 1024, 37);
  const attachment = await queue.saveFile({ id: 'coverage-probe', data: bytes, fileExtension: 'bin', mediaType: 'application/octet-stream' });
  assert.equal(attachment.state, AttachmentState.QUEUED_UPLOAD);
  assert.equal(sha(await readFile(attachment.localUri)), sha(bytes));
  await db.close();
  db = new PowerSyncDatabase({ schema, database: { dbFilename: dbPath } });
  await db.init();
  const rows = await db.getAll('SELECT id, state, size FROM attachments');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'coverage-probe');
  assert.equal(rows[0].state, AttachmentState.QUEUED_UPLOAD);
  assert.equal(rows[0].size, bytes.length);
  assert.equal(remoteCalls, 0);
  assert.equal(sha(await readFile(attachment.localUri)), sha(bytes));
  const jazzMethods = ['createFileFromBlob', 'loadFileAsBlob', 'createFileFromStream', 'loadFileAsStream'];
  for (const method of jazzMethods) assert.equal(typeof Db.prototype[method], 'function');
  assert.equal(typeof TypedTableQueryBuilder.prototype.include, 'function');
  const result = {
    scope: 'Installed-version capability checks; no sync service contacted and no timing results generated.',
    powersync: { sdk: powersyncVersion, bytes: bytes.length, sha256: sha(bytes), nativeAttachmentQueue: true, queuedRecordAndFileSurviveCleanDatabaseReopen: true, remoteCalls,
      limitations: 'This verifies local attachment staging/persistence only, not upload, download, retry or crash durability.' },
    jazz: { sdk: jazzVersion, fileMethods: jazzMethods, relationshipIncludeExported: true,
      limitations: 'Runtime API availability only; no Jazz file-transfer or relationship benchmark executed.' },
    scriptSha256: sha(await readFile(new URL(import.meta.url)))
  };
  await writeFile('results/diagnostics/final-publication/CAPABILITY-PROBE.json', JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
} finally { await db?.close(); await rm(dir, { recursive: true, force: true }); }
