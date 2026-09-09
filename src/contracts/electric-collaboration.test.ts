import { expect, test } from 'bun:test';
import { validateElectricCollaboration, validateElectricMutationReceipt, ELECTRIC_ACKNOWLEDGMENT } from './electric-collaboration.ts';
import { collaborationIterations, collaborationSeed, collaborationWarmup } from './collaboration.ts';
import { fixtureTasks } from './screens.ts';
import { submitElectricCollaborationWrite } from '../adapters/electric-write.ts';
import type { JsonObject } from '../types.ts';

test('Electric acceptance makes one mutation request and retains its response', async () => {
  const calls: { url: string; method?: string; body: unknown }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method, body: JSON.parse(String(init?.body)) });
    if (init?.method !== 'POST') throw new Error('An administrative reread must not delay acceptance');
    return Response.json({ ok: true, stackId: 'electric', row: { id: 'task', title: 'new title', completed: false, server_version: 2 } });
  }) as unknown as typeof fetch;
  const receipt = await submitElectricCollaborationWrite('http://localhost:3212', 'task', 'new title', -5, new AbortController().signal, fetchImpl);
  expect(calls).toEqual([{ url: 'http://localhost:3212/admin/write', method: 'POST', body: { taskId: 'task', title: 'new title' } }]);
  expect(receipt.response).toEqual({ status: 200, body: { ok: true, stackId: 'electric', row: { id: 'task', title: 'new title', completed: false, server_version: 2 } } });
});

test('Electric rejects successful HTTP responses that do not confirm the write', async () => {
  for (const body of [{ ok: false }, { ok: true, stackId: 'electric', row: { id: 'task', title: 'different', completed: false, server_version: 2 } }]) {
    const fetchImpl = (async () => Response.json(body)) as unknown as typeof fetch;
    await expect(submitElectricCollaborationWrite('http://localhost:3212', 'task', 'new title', 0, new AbortController().signal, fetchImpl)).rejects.toThrow('confirm');
  }
});

test('Electric publication binds every acknowledgment to the exact task, operation and version', () => {
  const task = fixtureTasks(collaborationSeed)[0];
  const receipts = Array.from({ length: collaborationIterations + collaborationWarmup }, (_, i) => ({
    iteration: i - collaborationWarmup, url: 'http://localhost:3212/admin/write', method: 'POST',
    request: { taskId: String(task.id), title: `collaboration-${i}` }, response: { status: 200, body: { ok: true, stackId: 'electric', row: { id: String(task.id), title: `collaboration-${i}`, completed: Boolean(task.completed), server_version: i + 2 } } },
  }));
  const metadata: JsonObject = { implementation: 'electric-collaboration-v3', acknowledgmentContract: ELECTRIC_ACKNOWLEDGMENT, mutationReceipts: receipts,
    samples: receipts.slice(collaborationWarmup).map(r => ({ title: r.request.title })) };
  expect(() => validateElectricCollaboration(metadata)).not.toThrow();
  for (const receipt of receipts) (receipt.response.body.row as any).server_version = String(receipt.response.body.row.server_version);
  expect(() => validateElectricCollaboration(metadata)).not.toThrow();
  for (const version of ['', '02', '2.0', '2e0', ' 2', '2 ', true, null, '9007199254740993', 2.5]) {
    const receipt = structuredClone(receipts[0]);
    (receipt.response.body.row as any).server_version = version;
    expect(() => validateElectricMutationReceipt(receipt)).toThrow('confirm');
  }
  for (const mutate of [
    (m: any) => m.implementation = 'electric-collaboration-v2',
    (m: any) => m.mutationReceipts.pop(),
    (m: any) => m.mutationReceipts[7].response.body.row.server_version++,
    (m: any) => m.mutationReceipts[7].request.title = 'different',
    (m: any) => m.samples[0].title = 'another-operation',
    (m: any) => m.mutationReceipts[0].url = 'http://127.0.0.1:9999/admin/write',
    (m: any) => m.mutationReceipts[0].response.body.row.completed = !Boolean(task.completed),
  ]) { const changed = structuredClone(metadata); mutate(changed); expect(() => validateElectricCollaboration(changed)).toThrow(); }
});
