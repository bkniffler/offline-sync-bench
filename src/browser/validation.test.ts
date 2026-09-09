import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { validateBrowserProbe } from './validation.ts';
import { browserDescendants } from './process.ts';

// Actual native SDK receipts, full rows and process identities from the browser
// development archive. These are correctness fixtures, never timing baselines.
const fixtures = Object.fromEntries(['electric', 'zero'].map(stack => [stack, JSON.parse(readFileSync(new URL(`../../results/diagnostics/browser-collaboration-development/${stack}-verified/RESULT.json`, import.meta.url), 'utf8'))]));
for (const stack of ['electric', 'zero']) {
  test(`${stack} real browser evidence passes complete validation`, () => expect(() => validateBrowserProbe(fixtures[stack])).not.toThrow());
  const corruptions: Array<[string, (value: any) => void]> = [
    ['missing client', r => r.clients.pop()],
    ['shared browser process', r => r.clients[1].connection.pid = r.clients[0].connection.pid],
    ['shared profile directory', r => r.clients[1].connection.profileDirectory = r.clients[0].connection.profileDirectory],
    ['shared native client ID', r => r.clients[1].initialized.clientId = r.clients[0].initialized.clientId],
    ['different runtime', r => r.clients[1].connection.version.product = 'Chrome/150.0.0.0'],
    ['wrong browser origin', r => r.clients[0].initialized.origin = 'https://wrong.example'],
    ['disabled web security', r => r.clients[0].connection.commandLine.arguments.push('--disable-web-security')],
    ['helper escapes trial group', r => r.clients[0].connection.osProcesses[1].pgid += 1],
    ['unowned CDP process', r => r.clients[0].connection.processes.processInfo[0].id = 999999],
    ['surviving helper', r => r.cleanup[0].remaining.push(r.cleanup[0].observed[0])],
    ['missing helper cleanup', r => r.cleanup[0].observed = r.cleanup[0].observed.filter((member: any) => member.pid !== r.clients[0].connection.osProcesses[1].pid)],
    ['missing late helper cleanup', r => r.cleanup[0].observed = r.cleanup[0].observed.filter((member: any) => member.pid !== r.cleanup[0].before.at(-1).pid)],
    ['altered initial title', r => r.clients[0].initialized.rows[1].title = 'wrong'],
    ['altered final owner', r => r.finalReader.rows[1].owner_id = 'wrong'],
    ['missing final writer row', r => r.finalWriter.rows.pop()],
    ['altered final digest', r => r.finalDigests.reader = 'wrong'],
    ['missing native receipt', r => r.finalWriter.receipts.pop()],
    ['duplicate native receipt', r => r.finalWriter.receipts[1] = r.finalWriter.receipts[0]],
    ['missing native event', r => r.events.pop()],
    ['altered visibility row', r => r.events.find((e: any) => e.event === 'visible').data.row.title = 'wrong'],
    ['decreasing event clock', r => r.events[1].controllerAtMs = r.events[0].controllerAtMs - 1],
    ['unbound measured sample', r => r.result.metadata.samples[0].title = 'collaboration-wrong'],
    ['wrong reported percentile', r => r.result.metrics.server_accepted_p50_ms += 1],
    ['missing reader resource sampling', r => r.result.metadata.resources.samples[0].processes = r.result.metadata.resources.samples[0].processes.filter((p: any) => p.pid !== r.clients[1].connection.pid)],
    ['missing after calibration', r => delete r.calibrationAfter],
    ['missing calibration sample', r => r.calibrationBefore.samples.pop()],
    ['calibration binding before arming', r => r.calibrationAfter.samples[0].bindingMs = 0],
  ];
  for (const [name, corrupt] of corruptions) test(`${stack} rejects ${name}`, () => {
    const evidence = structuredClone(fixtures[stack]); corrupt(evidence);
    expect(() => validateBrowserProbe(evidence)).toThrow();
  });
}
for (const [name, corrupt] of [
  ['shared native IndexedDB', (r: any) => r.clients[1].initialized.databases = r.clients[0].initialized.databases],
  ['failed local mutation', (r: any) => r.finalWriter.receipts[0].local.type = 'error'],
  ['failed server mutation', (r: any) => r.finalWriter.receipts[0].server.type = 'error'],
  ['false acceptance event', (r: any) => r.events.find((e: any) => e.event === 'accepted').data.receipt.server.type = 'error'],
] as const) test(`Zero rejects ${name}`, () => { const r = structuredClone(fixtures.zero); corrupt(r); expect(() => validateBrowserProbe(r)).toThrow(); });

test('Electric rejects receipt-only administrative reread and altered version sequence', () => {
  const receipt = structuredClone(fixtures.electric);
  receipt.finalWriter.receipts[0].method = 'GET';
  expect(() => validateBrowserProbe(receipt)).toThrow();
  const version = structuredClone(fixtures.electric);
  version.finalWriter.receipts[0].response.body.row.server_version = '99';
  expect(() => validateBrowserProbe(version)).toThrow();
});

test('browser ownership follows descendants, excluding unrelated same-group processes', () => {
  const rows = [
    { pid: 10, ppid: 1, pgid: 10, started: 'controller' },
    { pid: 11, ppid: 10, pgid: 10, started: 'browser' },
    { pid: 13, ppid: 12, pgid: 10, started: 'grandchild' },
    { pid: 12, ppid: 11, pgid: 10, started: 'renderer' },
    { pid: 14, ppid: 10, pgid: 10, started: 'other browser' },
  ];
  expect(browserDescendants(rows, 11).map(row => row.pid).sort()).toEqual([11, 12, 13]);
});
