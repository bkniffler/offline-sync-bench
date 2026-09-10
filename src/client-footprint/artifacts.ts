import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
export const footprintIds = ['syncular','powersync','zero','electric','electric-tanstack','jazz'] as const;
export function embeddedWasm(data: Uint8Array) {
 const text = Buffer.from(data).toString('utf8');
 return [...text.matchAll(/data:application\/wasm;base64,([A-Za-z0-9+/=]+)/g)].map(match => {
  const bytes = Buffer.from(match[1]!, 'base64');
  assert.equal(bytes.subarray(0, 8).toString('hex'), '0061736d01000000', 'Invalid embedded WASM');
  return { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
 });
}
export function footprintTotals(assets: Array<{ path: string; bytes: number; gzipBytes: number }>) {
 assert.equal(new Set(assets.map(a => a.path)).size, assets.length, 'Count each file once');
 assert(assets.length > 0);
 for (const asset of assets) {
  assert(Number.isSafeInteger(asset.bytes) && asset.bytes >= 0);
  assert(Number.isSafeInteger(asset.gzipBytes) && asset.gzipBytes > 0);
 }
 // Embedded WASM is already inside its JavaScript asset. Never add it again.
 return { rawBytes: assets.reduce((n, a) => n + a.bytes, 0), gzipBytes: assets.reduce((n, a) => n + a.gzipBytes, 0) };
}
export function validateRuntimeReceipt(row: any) {
 assert(footprintIds.includes(row.id)); assert.equal(row.status, 'completed'); assert.equal(row.profileWasEmpty, true);
 assert.equal(row.cleanup.allObservedAbsent, true);
 assert.deepEqual(row.verification.map((v: any) => v.phase), ['write', 'reopen']);
 const [write, reopen] = row.verification;
 assert.notEqual(write.documentTimeOrigin, reopen.documentTimeOrigin);
 assert.equal(write.rows.length, 1); assert.deepEqual(write.rows, reopen.rows);
 if (!row.id.startsWith('electric')) assert.deepEqual(write.rows, [{ id: 'task-1', title: 'footprint' }]);
 if (row.id === 'electric-tanstack') { assert.equal(reopen.serverReadsBlocked, true); assert(write.offlineOutbox && reopen.offlineOutbox); }
 assert(row.requests.every((r: any) => r.status === 200));
 assert.deepEqual([...new Set(row.assetUrls.map((url: string) => new URL(url).pathname))].sort(), row.assets.map((a: any) => a.path).sort());
 assert.deepEqual([...new Set(row.requests.map((r: any) => r.path))].sort(), row.assets.map((a: any) => a.path).sort());
 footprintTotals(row.assets);
}

// Whole-file accounting: shared SDK/adaptor chunks stay in core. Do not estimate
// per-module gzip contributions; compression does not add up that way.
export function assetCategory(id: string, asset: { path: string; type: string }, inputs: string[]) {
 if (asset.type === 'wasm') return 'storage';
 if (asset.path === '/sqlite3-opfs-async-proxy.js' || asset.path.startsWith('/assets/opfs-worker-')) return 'storage';
 if (id === 'jazz' && ['/jazz-worker.js', '/jazz-broker-worker.js'].includes(asset.path)) return 'storage';
 if (id === 'powersync' && asset.path === '/powersync-worker.js') return 'storage';
 if (inputs.length && inputs.every(path => /node_modules\/(?:@sqlite.org\/sqlite-wasm|@journeyapps\/wa-sqlite|jazz-wasm)\//.test(path))) return 'storage';
 return 'core';
}
