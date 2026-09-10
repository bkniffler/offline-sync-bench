import { createServer, request, type Server } from 'node:http';
import type { Socket } from 'node:net';

export interface BlobDownloadProxy { origin: string; relay: string }
export interface TransferAttempt {
  method: string; status: number; contentLength: number | null; range: string | null;
  upstreamBodyBytes: number; forwardedBodyBytes: number; interrupted: boolean; completed: boolean;
}

/** A streaming HTTP relay for a declared object origin. Restore the signed Host
 * header upstream, retaining path/query bytes. No grant, payload or signature is
 * fabricated. Only the client's URL origin changes to select the local relay. */
export class BlobTransferGate {
  #server: Server;
  #sockets = new Set<Socket>();
  #cutAfter: number | null = null;
  #attempts: TransferAttempt[] = [];
  readonly origin: string;
  url = '';
  constructor(origin: string) {
    const target = new URL(origin);
    if (target.protocol !== 'http:' || target.pathname !== '/' || target.search || target.hash || target.username || target.password) throw new Error('Blob relay requires an HTTP origin');
    this.origin = target.origin;
    this.#server = createServer((incoming, response) => {
      if (incoming.method !== 'GET' || !incoming.url?.startsWith('/') || incoming.url.startsWith('//')) { response.writeHead(400).end(); return; }
      const attempt: TransferAttempt = { method: incoming.method, status: 0, contentLength: null, range: incoming.headers.range ?? null, upstreamBodyBytes: 0, forwardedBodyBytes: 0, interrupted: false, completed: false };
      this.#attempts.push(attempt);
      const cutAfter = this.#cutAfter;
      const upstream = request({ hostname: target.hostname, port: target.port || 80, path: incoming.url, method: 'GET', headers: { ...incoming.headers, host: target.host, connection: 'close' } }, source => {
        attempt.status = source.statusCode ?? 0;
        attempt.contentLength = source.headers['content-length'] === undefined ? null : Number(source.headers['content-length']);
        response.writeHead(source.statusCode ?? 502, { ...source.headers, connection: 'close' });
        source.on('error', () => { if (!attempt.interrupted) response.destroy(); });
        source.on('aborted', () => { if (!attempt.interrupted) response.destroy(); });
        source.on('data', (bytes: Buffer) => {
          attempt.upstreamBodyBytes += bytes.length;
          if (attempt.interrupted) return;
          const remaining = cutAfter === null ? bytes.length : Math.max(0, cutAfter - attempt.forwardedBodyBytes);
          const sent = bytes.subarray(0, remaining);
          attempt.forwardedBodyBytes += sent.length;
          if (cutAfter !== null && attempt.forwardedBodyBytes === cutAfter) {
            attempt.interrupted = true;
            source.pause();
            // Flush this prefix onto the downstream socket, then terminate it
            // without sending the remaining body or a successful response end.
            // End through ServerResponse so queued body chunks flush before FIN.
            // The declared full Content-Length remains unchanged: clients see
            // a truncated body, not a successful shorter object.
            response.end(sent, () => { upstream.destroy(); source.destroy(); });
          } else if (!response.write(sent)) { source.pause(); response.once('drain', () => source.resume()); }
        });
        source.on('end', () => { if (!attempt.interrupted) { attempt.completed = true; response.end(); } });
      });
      upstream.on('socket', socket => this.#track(socket));
      // Deliberately aborting upstream must not destroy the downstream socket
      // while its final prefix is still flushing.
      upstream.on('error', () => { if (!attempt.interrupted) response.destroy(); });
      response.on('close', () => upstream.destroy());
      incoming.on('aborted', () => upstream.destroy());
      upstream.end();
    });
    this.#server.on('connection', socket => this.#track(socket));
  }
  #track(socket: Socket) { this.#sockets.add(socket); socket.once('close', () => this.#sockets.delete(socket)); }
  async start() {
    await new Promise<void>((resolve, reject) => { this.#server.once('error', reject); this.#server.listen(0, '127.0.0.1', () => { this.#server.removeListener('error', reject); resolve(); }); });
    const address = this.#server.address();
    if (!address || typeof address === 'string') throw new Error('Blob relay has no port');
    this.url = `http://127.0.0.1:${address.port}`;
  }
  interruptAfter(bytes: number) {
    if (!Number.isSafeInteger(bytes) || bytes < 1) throw new Error('Interruption requires a positive body byte count');
    this.#cutAfter = bytes;
  }
  restore() { this.#cutAfter = null; }
  proxy(): BlobDownloadProxy { if (!this.url) throw new Error('Blob relay has not started'); return { origin: this.origin, relay: this.url }; }
  snapshot() { return { method: 'http-object-download-cut-v1', cutAfterBytes: this.#cutAfter, attempts: this.#attempts.map(attempt => ({ ...attempt })) }; }
  async close() {
    for (const socket of this.#sockets) socket.destroy();
    if (this.#server.listening) await new Promise<void>((resolve, reject) => this.#server.close(error => error ? reject(error) : resolve()));
  }
}

export function relayBlobUrl(url: string, proxy: BlobDownloadProxy): string {
  if (!url.startsWith(`${proxy.origin}/`)) throw new Error('Signed blob URL does not match the declared object origin');
  return `${proxy.relay}${url.slice(proxy.origin.length)}`;
}
