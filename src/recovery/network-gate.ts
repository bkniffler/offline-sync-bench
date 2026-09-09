import { createConnection, createServer, type Server, type Socket } from 'node:net';

/** Transparent client-only TCP relay. Closing the gate destroys established
 * connections and refuses new ones without stopping or modifying the service. */
export class NetworkGate {
  #server: Server;
  #sockets = new Set<Socket>();
  #blocked = false;
  #rejectedConnections = 0;
  #forwardedConnections = 0;
  #requestBytes = 0;
  #responseBytes = 0;
  #path: string;
  #recordTimeline: boolean;
  #events: { kind: string; atMs: number }[] = [];
  #record(kind: string) { if (this.#recordTimeline) this.#events.push({ kind, atMs: performance.now() }); }
  timeline(origin: number) { return this.#events.filter(e => e.atMs >= origin).map(e => ({ ...e, atMs: e.atMs - origin })); }
  url = '';

  constructor(target: string, recordTimeline = false) {
    this.#recordTimeline = recordTimeline;
    const upstream = new URL(target);
    if (upstream.protocol !== 'http:' || upstream.search || upstream.hash) throw new Error('Network gate requires an HTTP base URL');
    this.#path = upstream.pathname === '/' ? '' : upstream.pathname.replace(/\/$/, '');
    this.#server = createServer(incoming => {
      if (this.#blocked) { this.#record('rejected'); this.#rejectedConnections++; incoming.destroy(); return; }
      this.#record('forwarded'); this.#forwardedConnections++;
      const outgoing = createConnection({ host: upstream.hostname, port: Number(upstream.port || 80) });
      for (const socket of [incoming, outgoing]) {
        this.#sockets.add(socket);
        socket.on('close', () => this.#sockets.delete(socket));
        socket.on('error', () => { incoming.destroy(); outgoing.destroy(); });
      }
      incoming.on('data', bytes => { this.#requestBytes += bytes.length; });
      outgoing.on('data', bytes => { this.#responseBytes += bytes.length; });
      incoming.pipe(outgoing); outgoing.pipe(incoming);
    });
  }
  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen(0, '127.0.0.1', () => { this.#server.removeListener('error', reject); resolve(); });
    });
    const address = this.#server.address();
    if (!address || typeof address === 'string') throw new Error('Network gate has no TCP port');
    this.url = `http://127.0.0.1:${address.port}${this.#path}`;
  }
  block(): void {
    this.#record('block'); this.#blocked = true;
    for (const socket of this.#sockets) socket.destroy();
  }
  restore(): void { this.#record('restore'); this.#blocked = false; }
  snapshot() {
    return { blocked: this.#blocked, rejectedConnections: this.#rejectedConnections,
      forwardedConnections: this.#forwardedConnections, requestBytes: this.#requestBytes, responseBytes: this.#responseBytes };
  }
  async close(): Promise<void> {
    for (const socket of this.#sockets) socket.destroy();
    if (this.#server.listening) await new Promise<void>((resolve, reject) => this.#server.close(error => error ? reject(error) : resolve()));
  }
}

/** Some clients download from a sync service and upload through an application
 * endpoint. Both routes must be blocked to claim a client outage. */
export class ClientNetworkGate {
  #gates: Record<string, NetworkGate>;
  constructor(endpoints: Record<string, string>, recordTimeline = false) { this.#gates = Object.fromEntries(Object.entries(endpoints).map(([name, url]) => [name, new NetworkGate(url, recordTimeline)])); }
  timeline(origin: number) { return Object.fromEntries(Object.entries(this.#gates).map(([name, gate]) => [name, gate.timeline(origin)])); }
  url(name: string): string | undefined { return this.#gates[name]?.url; }
  async start() { await Promise.all(Object.values(this.#gates).map(gate => gate.start())); }
  block() { for (const gate of Object.values(this.#gates)) gate.block(); }
  restore() { for (const gate of Object.values(this.#gates)) gate.restore(); }
  async close() { await Promise.all(Object.values(this.#gates).map(gate => gate.close())); }
  snapshot() {
    const endpoints = Object.fromEntries(Object.entries(this.#gates).map(([name, gate]) => [name, gate.snapshot()]));
    const values = Object.values(endpoints);
    const sum = (key: 'rejectedConnections' | 'forwardedConnections' | 'requestBytes' | 'responseBytes') => values.reduce((n, value) => n + value[key], 0);
    return { blocked: values.every(value => value.blocked), rejectedConnections: sum('rejectedConnections'), forwardedConnections: sum('forwardedConnections'), requestBytes: sum('requestBytes'), responseBytes: sum('responseBytes'), endpoints };
  }
}
