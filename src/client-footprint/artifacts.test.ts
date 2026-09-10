import { test, expect } from 'bun:test';
import { embeddedWasm, footprintTotals, validateRuntimeReceipt } from './artifacts.ts';
test('embedded WASM belongs to its JS file and cannot be double-counted', () => {
 const js = Buffer.from('const source="data:application/wasm;base64,AGFzbQEAAAA=";');
 expect(embeddedWasm(js)[0]!.bytes).toBe(8);
 expect(footprintTotals([{ path: 'worker.js', bytes: js.length, gzipBytes: 60 }]).rawBytes).toBe(js.length);
 expect(() => footprintTotals([{ path: 'worker.js', bytes: 1, gzipBytes: 20 }, { path: 'worker.js', bytes: 1, gzipBytes: 20 }])).toThrow('once');
 expect(() => embeddedWasm(Buffer.from('data:application/wasm;base64,YmFk'))).toThrow('Invalid embedded WASM');
});
test('import-only or failed browser measurements are rejected', () => {
 expect(() => validateRuntimeReceipt({ id: 'syncular', status: 'completed', profileWasEmpty: false })).toThrow();
 expect(() => validateRuntimeReceipt({ id: 'powersync', status: 'failed' })).toThrow();
});
