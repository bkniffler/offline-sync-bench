import { expect, test } from 'bun:test';
import { connect, createServer, type Socket } from 'node:net';
import { once } from 'node:events';
import { NetworkGate } from './network-gate.ts';

test('client gate kills existing streams and blocks new ones while service remains healthy', async () => {
  const sockets = new Set<Socket>();
  const server = createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {}); socket.pipe(socket); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  const gate = new NetworkGate(`http://127.0.0.1:${address.port}/api`, true);
  await gate.start();
  const port = Number(new URL(gate.url).port);
  const exchange = async (target: number) => {
    const client = connect(target, '127.0.0.1'); client.on('error', () => {});
    await once(client, 'connect');
    const received = once(client, 'data'); client.write('payload');
    expect(String((await received)[0])).toBe('payload');
    return client;
  };
  try {
    const client = await exchange(port);
    const closed = once(client, 'close'); const origin = performance.now(); gate.block(); await closed;
    const before = gate.snapshot();
    const rejected = connect(port, '127.0.0.1'); rejected.on('error', () => {});
    await new Promise<void>(resolve => rejected.once('close', () => resolve()));
    expect(gate.snapshot().rejectedConnections).toBeGreaterThan(before.rejectedConnections);
    expect(gate.snapshot().forwardedConnections).toBe(before.forwardedConnections);
    (await exchange(address.port)).destroy();
    gate.restore(); (await exchange(port)).destroy();
    expect(gate.snapshot().requestBytes).toBe(14);
    const events = gate.timeline(origin);
    expect(events.map(e => e.kind)).toEqual(['block', 'rejected', 'restore', 'forwarded']);
    expect(events.every((e, i) => e.atMs >= 0 && (!i || e.atMs >= events[i - 1].atMs))).toBe(true);
  } finally {
    await gate.close(); for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
