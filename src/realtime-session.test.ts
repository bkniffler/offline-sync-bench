import { expect, test } from 'bun:test';
import { PendingRealtimeSession } from '../stacks/syncular/syncular-app/src/realtime-session.ts';

test('early binary and text frames reach the asynchronous session in order', () => {
  const frames: unknown[] = [], binary = new Uint8Array([1, 2]);
  const pending = new PendingRealtimeSession(() => { throw new Error('unexpected disconnect'); });
  pending.receive('hello'); pending.receive(binary); binary[0] = 9;
  expect(frames).toEqual([]);
  pending.ready({ handleMessage: value => frames.push(value), handleBinary: value => frames.push([...value]), close() {} });
  pending.receive('round');
  expect(frames).toEqual(['hello', [1, 2], 'round']);
});
test('a closed socket closes a late session without delivering its buffered frames', () => {
  let closed = 0;
  const pending = new PendingRealtimeSession(() => {});
  pending.receive('hello'); pending.close();
  pending.ready({ handleMessage() { throw new Error('delivered after close'); }, handleBinary() {}, close() { closed++; } });
  expect(closed).toBe(1);
});
test('pre-handshake buffering is bounded', () => {
  let disconnected = 0, closed = 0;
  const pending = new PendingRealtimeSession(() => { disconnected++; }, 2);
  pending.receive('abc');
  pending.ready({ handleMessage() { throw new Error('delivered overflowing frame'); }, handleBinary() {}, close() { closed++; } });
  expect(disconnected).toBe(1); expect(closed).toBe(1);
});
