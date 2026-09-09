import { expect, test } from 'bun:test';
import { validateLoadedProcessGroup } from './loaded-process.ts';

const controller = { pid: 100, ppid: 1, pgid: 100, started: 'synthetic-controller' };
const root = { pid: 200, ppid: 100, pgid: 200, started: 'synthetic-trial' };
const browser = { pid: 300, ppid: 200, pgid: 200, started: 'synthetic-browser' };
function fixture() {
  return { status: 'completed', processGroup: { pid: 200, emptyVerified: true, remaining: [], initial: [{ ...root }], beforeTermination: [], signals: [] },
    evidence: { clients: [{ connection: { pid: 300, parent: { ...root }, osProcesses: [{ ...browser }] } }] } };
}
test('loaded group binds the browser to its trial and declared controller', () => {
  expect(validateLoadedProcessGroup(controller, fixture())).toEqual([root, browser]);
});
for (const [name, corrupt] of [
  ['unrelated controller', (r: any) => r.processGroup.initial[0].ppid = 999],
  ['unrelated browser parent', (r: any) => r.evidence.clients[0].connection.parent.pid = 999],
  ['browser escaped group', (r: any) => r.evidence.clients[0].connection.osProcesses[0].pgid = 999],
  ['browser adopted from elsewhere', (r: any) => r.evidence.clients[0].connection.osProcesses[0].ppid = 999],
  ['missing root', (r: any) => r.processGroup.initial = []],
  ['missing cleanup', (r: any) => r.processGroup.emptyVerified = false],
  ['changed root before kill', (r: any) => r.processGroup.beforeTermination = [{ members: [{ ...root, started: 'different-process' }] }]],
] as const) test(`loaded group rejects ${name}`, () => {
  const r = structuredClone(fixture()); corrupt(r);
  expect(() => validateLoadedProcessGroup(controller, r)).toThrow();
});
test('a deadline flag alone cannot establish termination evidence', () => {
  const r: any = structuredClone(fixture()); r.status = 'timed-out';
  expect(() => validateLoadedProcessGroup(controller, r)).toThrow('deadline');
  r.processGroup.deadlineElapsedMs = 300000;
  r.processGroup.beforeTermination = [{ reason: 'whole-attempt-deadline', members: [root, browser] }];
  r.processGroup.signals = [{ reason: 'whole-attempt-deadline', signal: 'SIGKILL' }];
  expect(() => validateLoadedProcessGroup(controller, r)).not.toThrow();
});
test('a failed launch stays invalid without inventing a native process identity', () => {
  const r: any = { status: 'invalid', processGroup: { pid: null, launchError: 'Synthetic launch failure', initial: [], beforeTermination: [], signals: [], remaining: [], emptyVerified: true }, evidence: null };
  expect(validateLoadedProcessGroup(controller, r)).toEqual([]);
  r.status = 'completed'; expect(() => validateLoadedProcessGroup(controller, r)).toThrow('root identity');
});
