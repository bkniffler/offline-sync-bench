import { expect, test } from 'bun:test';
import { createHttpMeter } from './http-meter';

test('stream metering returns before EOF and forwards cancellation', async () => {
  let finishCancellation!: () => void;
  const cancelled = new Promise<void>(resolve => { finishCancellation = resolve; });
  const source = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('first chunk'));
    },
    cancel() { finishCancellation(); },
  }), { headers: { 'content-type': 'application/octet-stream' } });
  Object.defineProperty(source, 'url', { value: 'http://localhost/sync' });
  const meter = createHttpMeter((async (request: Request) => { await request.text(); return source; }) as unknown as typeof fetch);

  const response = await Promise.race([
    meter.fetch('http://localhost/sync', { method: 'POST', body: 'ping' }),
    Bun.sleep(1_000).then(() => { throw new Error('Meter waited for stream EOF'); }),
  ]);
  expect(response.url).toBe('http://localhost/sync');
  expect(response.headers.get('content-type')).toBe('application/octet-stream');
  const reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe('first chunk');
  expect(meter.snapshot()).toEqual({ requestCount: 1, requestBytes: 4, responseBytes: 11 });
  await reader.cancel();
  await cancelled;
});

test('default metering counts finite responses as the client consumes them', async () => {
  const meter = createHttpMeter((async () => new Response('héllo')) as unknown as typeof fetch);
  const response = await meter.fetch('http://localhost/data');
  expect(await response.text()).toBe('héllo');
  expect(meter.snapshot()).toEqual({ requestCount: 1, requestBytes: 0, responseBytes: 6 });
});

test('stream metering preserves bodyless responses', async () => {
  const meter = createHttpMeter(
    (async () => new Response(null, { status: 204 })) as unknown as typeof fetch,
    { streamResponses: true }
  );
  const response = await meter.fetch('http://localhost/data');
  expect(response.status).toBe(204);
  expect(response.body).toBeNull();
  expect(meter.snapshot().responseBytes).toBe(0);
});

test('fixed-length metering preserves binary bytes and Content-Length over HTTP', async () => {
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      return Response.json({
        length: request.headers.get('content-length'),
        transferEncoding: request.headers.get('transfer-encoding'),
        contentType: request.headers.get('content-type'),
        bytes: [...new Uint8Array(await request.arrayBuffer())],
      });
    },
  });
  try {
    const bytes = new Uint8Array([0, 26, 5, 53, 54, 49, 54, 52, 0]).subarray(1, 8);
    const meter = createHttpMeter(fetch, { fixedLengthRequests: true });
    const response = await meter.fetch(server.url, {
      method: 'POST',
      headers: { 'content-type': 'application/protobuf' },
      body: bytes,
    });
    expect(await response.json()).toEqual({
      length: '7',
      transferEncoding: null,
      contentType: 'application/protobuf',
      bytes: [...bytes],
    });
    expect(meter.snapshot().requestBytes).toBe(7);
  } finally {
    await server.stop(true);
  }
});


test('Request inputs respect method, header and body overrides', async () => {
  const meter = createHttpMeter((async (request: Request) => Response.json({ method: request.method, header: request.headers.get('x-test'), body: await request.text() })) as unknown as typeof fetch);
  const response = await meter.fetch(new Request('http://localhost/test', { method: 'POST', body: 'old' }), { method: 'PUT', headers: { 'x-test': 'new' }, body: 'new-body' });
  expect(await response.json()).toEqual({ method: 'PUT', header: 'new', body: 'new-body' });
  expect(meter.snapshot().requestBytes).toBe(8);
});
