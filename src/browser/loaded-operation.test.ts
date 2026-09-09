import { expect, test } from 'bun:test';
import { measureLoadedOperation } from './loaded-operation.ts';

const operation = { iteration: 0, taskId: 'task', title: 'loaded-operation' };
const readReceipt = { ...operation, browserAtMs: 20, row: { id: operation.taskId, title: operation.title } };
const writeReceipt = { ...operation, startedAtMs: 10, finishedAtMs: 12 };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test('loaded timing uses the same independent RPC completions in both forwarding modes', async () => {
  for (const mode of ['buffered', 'forwarded']) {
    const visible = deferred<typeof readReceipt>(), accepted = deferred<typeof writeReceipt>();
    const calls: string[] = [], forwarded: unknown[] = [];
    const reader = { call: async (method: string) => {
      calls.push(method);
      if (method === 'diagnostic-arm') return { title: operation.title, armed: true };
      if (method === 'diagnostic-wait') return visible.promise;
      throw new Error('Unexpected reader call');
    } };
    const writer = { call: async (method: string) => {
      calls.push(method);
      if (mode === 'forwarded') forwarded.push(readReceipt, writeReceipt);
      return accepted.promise;
    } };
    let finished = false;
    const sample = measureLoadedOperation(writer, reader, operation).then(value => { finished = true; return value; });
    await Promise.resolve(); await Promise.resolve();
    expect(calls).toEqual(['diagnostic-arm', 'diagnostic-wait', 'diagnostic-write']);
    expect(forwarded).toHaveLength(mode === 'forwarded' ? 2 : 0);
    expect(finished).toBe(false);
    accepted.resolve(writeReceipt);
    await Promise.resolve(); await Promise.resolve();
    expect(finished).toBe(false);
    visible.resolve(readReceipt);
    const value = await sample;
    expect(value.controller.totalMs).toBeGreaterThanOrEqual(value.controller.readerMs);
    expect(value.controller.totalMs).toBeGreaterThanOrEqual(value.controller.writerMs);
    expect(value.writer).toEqual({ startedAtMs: 10, finishedAtMs: 12 });
    expect(value.reader.browserAtMs).toBe(20);
  }
});

test('loaded operation rejects an incorrect observer receipt and reversed writer clock', async () => {
  const reader = { call: async (method: string) => method === 'diagnostic-arm'
    ? { title: operation.title, armed: true } : readReceipt };
  await expect(measureLoadedOperation({ call: async () => ({ ...writeReceipt, finishedAtMs: 9 }) }, reader, operation)).rejects.toThrow('monotonic');
  const wrongReader = { call: async (method: string) => method === 'diagnostic-arm'
    ? { title: operation.title, armed: true } : { ...readReceipt, taskId: 'wrong-task' } };
  await expect(measureLoadedOperation({ call: async () => writeReceipt }, wrongReader, operation)).rejects.toThrow('identity mismatch');
});

test('loaded operation retains a missing-native-completion timeout', async () => {
  const reader = { call: async (method: string) => method === 'diagnostic-arm'
    ? { title: operation.title, armed: true } : new Promise(() => {}) };
  await expect(measureLoadedOperation({ call: async () => writeReceipt }, reader, operation, 5)).rejects.toThrow('timed out');
});
