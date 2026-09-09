import { expect, test } from 'bun:test';
import { validateLoadedBrowserCondition } from './loaded-validation.ts';
import { loadedConditionFixture as fixture } from '../test-fixtures/browser-loaded.ts';

for (const stackId of ['electric', 'zero'] as const) {
  for (const mode of ['buffered', 'forwarded'] as const) test(`${stackId} ${mode} synthetic loaded evidence validates`, () => {
    expect(() => validateLoadedBrowserCondition(fixture(stackId, mode))).not.toThrow();
  });
  const corruptions: Array<[string, (e: any) => void]> = [
    ['incomplete operation set', e => e.operations.pop()],
    ['duplicated operation', e => e.operations[1] = e.operations[0]],
    ['missing native receipt', e => e.finalWriter.receipts.pop()],
    ['missing buffered receipt', e => e.buffered.writer.events.pop()],
    ['missing forwarded receipt', e => e.forwardedEvents.pop()],
    ['changed forwarded record', e => e.forwardedEvents[0].data.title = 'wrong'],
    ['changed browser mode', e => e.clients[0].initialized.diagnosticForwarding = 'buffered'],
    ['changed readback mode', e => e.buffered.writer.mode = 'buffered'],
    ['binding-driven completion contract', e => e.completion = 'binding-completes-operation'],
    ['reversed writer clock', e => e.operations[0].writer.finishedAtMs = 0],
    ['overlapping controller operations', e => e.operations[1].controller.startedAtMs = e.operations[0].controller.startedAtMs],
    ['nonmonotonic reader clock', e => e.operations[1].reader.browserAtMs = 0],
    ['incorrect visible record', e => e.operations[0].reader.row.title = 'wrong'],
    ['wrong JSON byte total', e => e.forwardedPayloadJsonBytes += 1],
    ['incomplete final dataset', e => e.finalWriter.rows.pop()],
    ['shared process', e => e.clients[1].connection.pid = e.clients[0].connection.pid],
    ['surviving helper', e => e.cleanup[0].remaining.push(e.cleanup[0].observed[0])],
    ['missing resource scope', e => e.resources.metadata.samples[0].processes = []],
  ];
  for (const [name, corrupt] of corruptions) test(`${stackId} loaded evidence rejects ${name}`, () => {
    const e = fixture(stackId, 'forwarded'); corrupt(e);
    expect(() => validateLoadedBrowserCondition(e)).toThrow();
  });
  test(`${stackId} buffered condition rejects leaked live events`, () => {
    const e = fixture(stackId, 'buffered');
    e.forwardedEvents.push({ role: 'writer', ...e.buffered.writer.events[0], controllerAtMs: 3001 });
    expect(() => validateLoadedBrowserCondition(e)).toThrow('mode leaked');
  });
}
