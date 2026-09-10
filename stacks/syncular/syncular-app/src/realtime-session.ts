interface Session {
  handleMessage(message: string): unknown;
  handleBinary(message: Uint8Array): unknown;
  close(): unknown;
}
/** Bun can deliver frames (or close) before the asynchronous hub handshake
 * finishes. Preserve their order instead of silently dropping early frames. */
export class PendingRealtimeSession {
  #session?: Session;
  #queue: Array<string | Uint8Array> = [];
  #bytes = 0;
  #closed = false;
  constructor(private readonly disconnect: () => void, private readonly maxBytes = 8 * 1024 * 1024) {}
  receive(message: string | Uint8Array) {
    if (this.#closed) return;
    if (this.#session) { this.#deliver(message); return; }
    const size = typeof message === 'string' ? Buffer.byteLength(message) : message.byteLength;
    if (this.#bytes + size > this.maxBytes || this.#queue.length >= 1024) { this.close(); this.disconnect(); return; }
    this.#bytes += size;
    this.#queue.push(typeof message === 'string' ? message : message.slice());
  }
  ready(session: Session) {
    if (this.#closed) { session.close(); return; }
    this.#session = session;
    for (const message of this.#queue) this.#deliver(message);
    this.#queue = []; this.#bytes = 0;
  }
  #deliver(message: string | Uint8Array) {
    if (typeof message === 'string') this.#session!.handleMessage(message);
    else this.#session!.handleBinary(message);
  }
  close() {
    if (this.#closed) return;
    this.#closed = true; this.#queue = []; this.#bytes = 0;
    this.#session?.close();
  }
}
