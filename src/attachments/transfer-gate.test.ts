import { expect, test } from 'bun:test';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { BlobTransferGate, relayBlobUrl } from './transfer-gate.ts';
import { attachmentPayload, interruptionBytes } from './download-recovery.ts';

test('real HTTP interruption transmits a prefix, persists across retries, and restores exact bytes with signed Host/path intact', async () => {
  const payload = attachmentPayload(1);
  const observations: { host: string | undefined; path: string | undefined }[] = [];
  const origin = createServer((req, res) => {
    observations.push({ host: req.headers.host, path: req.url });
    res.writeHead(200, { 'content-length': payload.length, 'content-type': 'application/octet-stream' });
    let offset = 0;
    const pump = () => {
      while (offset < payload.length) {
        const part = payload.subarray(offset, offset + 8192); offset += part.length;
        if (!res.write(part)) { res.once('drain', pump); return; }
      }
      res.end();
    };
    pump();
  });
  await new Promise<void>(resolve => origin.listen(0, '127.0.0.1', resolve));
  const address = origin.address() as { port: number };
  const originUrl = `http://127.0.0.1:${address.port}`;
  const gate = new BlobTransferGate(originUrl);
  const path = '/bucket/key%2Fpart?X-Amz-Signature=opaque%2Bvalue&x=1&x=2';
  try {
    await gate.start(); gate.interruptAfter(interruptionBytes);
    const url = relayBlobUrl(`${originUrl}${path}`, gate.proxy());
    for (let attempt = 0; attempt < 2; attempt++) {
      // Read the actual socket bytes. Fetch may discard already-buffered bytes
      // when it reports a truncated response, obscuring the delivered prefix.
      const target = new URL(url);
      const wire = await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        const socket = createConnection({ host: target.hostname, port: Number(target.port) });
        socket.on('error', reject);
        socket.on('connect', () => socket.write(`GET ${target.pathname}${target.search} HTTP/1.1\r\nHost: ${target.host}\r\nConnection: close\r\n\r\n`));
        socket.on('data', (bytes: Buffer) => chunks.push(bytes));
        socket.on('end', () => resolve(Buffer.concat(chunks)));
      });
      const boundary = wire.indexOf('\r\n\r\n');
      expect(wire.subarray(0, boundary).toString().toLowerCase()).toContain(`content-length: ${payload.length}`);
      expect(wire.subarray(boundary + 4)).toEqual(Buffer.from(payload.subarray(0, interruptionBytes)));
      const record = gate.snapshot().attempts.at(-1)!;
      expect(record.interrupted).toBe(true); expect(record.completed).toBe(false);
      expect(record.forwardedBodyBytes).toBe(interruptionBytes);
    }
    gate.restore();
    expect(new Uint8Array(await (await fetch(url)).arrayBuffer())).toEqual(payload.slice());
    const restored = gate.snapshot().attempts.at(-1)!;
    expect(restored.completed).toBe(true); expect(restored.interrupted).toBe(false);
    expect(restored.forwardedBodyBytes).toBe(payload.length);
    expect(observations).toEqual(Array(3).fill({ host: `127.0.0.1:${address.port}`, path }));
    expect(() => relayBlobUrl('http://unrelated.test/blob', gate.proxy())).toThrow('declared object origin');
  } finally { await gate.close(); origin.closeAllConnections(); await new Promise<void>(resolve => origin.close(() => resolve())); }
}, 10_000);
