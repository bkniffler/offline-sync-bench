import { expect, test } from 'bun:test';
import { awaitBrowserFixture } from './initial-ready.ts';
import { ContractError } from '../contracts/screens.ts';

const expected = [{ id: 'task-1', org_id: 'org-1', project_id: 'project-1', owner_id: 'user-1', title: 'Seeded title', completed: 0, server_version: 1 }];
test('browser readiness waits through empty and stale complete views for exact seeded data', async () => {
  const views = [[], [{ ...expected[0], title: 'Old title' }], [{ ...expected[0], completed: false, server_version: 1n }]];
  const result = await awaitBrowserFixture(() => views.shift()!, expected, { pollMs: 1 });
  expect(result.observations).toBe(3);
  expect(result.firstRowCount).toBe(0);
  expect(result.finalRowCount).toBe(1);
  expect(result.countMismatches).toBe(1);
  expect(result.contentMismatches).toBe(1);
});
test('browser readiness retains deadline evidence for a same-size incorrect fixture', async () => {
  try {
    await awaitBrowserFixture(() => [{ ...expected[0], owner_id: 'wrong-user' }], expected, { timeoutMs: 10, pollMs: 1 });
    throw new Error('Accepted incorrect fixture');
  } catch (error) {
    expect(error).toBeInstanceOf(ContractError);
    expect((error as ContractError).evidence?.finalRowCount).toBe(1);
    expect(Number((error as ContractError).evidence?.contentMismatches)).toBeGreaterThan(0);
  }
});
test('browser readiness propagates native errors and rejects an empty expected fixture', async () => {
  const failure = new Error('Native connection failed');
  await expect(awaitBrowserFixture(() => { throw failure; }, expected)).rejects.toBe(failure);
  await expect(awaitBrowserFixture(() => [], [])).rejects.toThrow('Invalid browser fixture');
});
