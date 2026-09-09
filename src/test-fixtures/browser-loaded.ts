import { readFileSync } from 'node:fs';
import { collaborationSeed } from '../contracts/collaboration.ts';

// Synthetic diagnostic fixtures using preserved native rows/receipts/process
// identities. All diagnostic clocks and modes below are invented for validation
// tests; these records must never be archived as experiment observations.
export function loadedConditionFixture(stackId: 'electric' | 'zero', mode: 'buffered' | 'forwarded', serial = 0) {
  const e = JSON.parse(readFileSync(new URL(`../../results/diagnostics/browser-collaboration-development/${stackId}-verified/RESULT.json`, import.meta.url), 'utf8'));
  e.method = 'browser-milestone-forwarding-v1'; e.mode = mode;
  e.fixture = collaborationSeed; e.warmups = 5; e.iterations = 50;
  e.completion = 'controller-reader-arm-and-independent-writer-reader-RPC-v1';
  e.clock = 'separate-controller-writer-reader-monotonic-clocks';
  e.binding = { browserVersion: e.clients[0].connection.version.product.split('/')[1] };
  for (const client of e.clients) client.initialized.diagnosticForwarding = mode;
  const receipts = e.finalWriter.receipts;
  e.taskId = stackId === 'electric' ? receipts[0].request.taskId : receipts[0].taskId;
  const titles = receipts.map((r: any) => stackId === 'electric' ? r.request.title : r.title);
  for (const [index, event] of e.events.entries()) {
    const i = titles.indexOf(event.data.title);
    event.data.browserAtMs = event.role === 'reader' ? 2000 + i * 100 + 20 : 1000 + i * 100 + (event.event === 'local' ? 10 : 30);
    event.controllerAtMs = 3000 + i * 100 + 2 + index % (stackId === 'zero' ? 3 : 2);
  }
  e.operations = titles.map((title: string, i: number) => ({
    iteration: i - 5, title, taskId: e.taskId,
    controller: { startedAtMs: 3000 + i * 100, finishedAtMs: 3080 + i * 100, armMs: 1, writerMs: 70, readerMs: 60, totalMs: 80 },
    writer: { startedAtMs: 1000 + i * 100, finishedAtMs: 1050 + i * 100 },
    reader: { browserAtMs: 2020 + i * 100, row: structuredClone(e.events.find((event: any) => event.event === 'visible' && event.data.title === title).data.row) },
  }));
  e.buffered = Object.fromEntries(['writer', 'reader'].map(role => [role, {
    mode, events: e.events.filter((event: any) => event.role === role).map(({ event, data }: any) => structuredClone({ event, data })),
  }]));
  e.forwardedEvents = mode === 'forwarded' ? structuredClone(e.events).sort((a: any, b: any) => a.controllerAtMs - b.controllerAtMs) : [];
  e.forwardedPayloadJsonBytes = e.forwardedEvents.reduce((sum: number, { event, data }: any) => sum + Buffer.byteLength(JSON.stringify({ event, data })), 0);
  e.resources = structuredClone({ metrics: e.result.metrics, metadata: e.result.metadata.resources });
  // Each synthetic condition needs distinct OS/profile identities. The native
  // archive itself is unchanged; these relocated identities are test data.
  const offset = serial * 10000;
  const relocate = (value: any) => {
    if (Array.isArray(value)) { value.forEach(relocate); return; }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (['pid', 'ppid', 'pgid', 'rootPid'].includes(key) && typeof child === 'number') value[key] = child + offset;
      else {
        if (key === 'processInfo' && Array.isArray(child)) for (const row of child) row.id += offset;
        relocate(child);
      }
    }
  };
  relocate(e);
  const rootPid = e.clients[0].connection.parent.pid;
  const ownGroup = (value: any) => {
    if (Array.isArray(value)) { value.forEach(ownGroup); return; }
    if (!value || typeof value !== 'object') return;
    if (value.pid === rootPid && typeof value.ppid === 'number') value.ppid = 100;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'pgid') value[key] = rootPid;
      else ownGroup(child);
    }
  };
  ownGroup(e);
  e.profiles = e.profiles.map((path: string, i: number) => {
    const next = `${path}-loaded-fixture-${serial}`;
    const connection = e.clients[i].connection;
    connection.profileDirectory = next;
    connection.commandLine.arguments = connection.commandLine.arguments.map((arg: string) => arg === `--user-data-dir=${path}` ? `--user-data-dir=${next}` : arg);
    return next;
  });
  return e;
}
