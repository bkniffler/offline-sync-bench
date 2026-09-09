import { describe, expect, test } from 'bun:test';
import { PacketNetwork, packetRoutes, readPacketAudit, validatePacketImpairment } from './emulator.ts';

describe('packet network admission and accounting', () => {
  test('routes HTTP and WebSocket paths through the same service port', () => {
    expect(packetRoutes({ sync: 'http://localhost:3210/api', realtime: 'ws://127.0.0.1:3210/api/sync/realtime', app: 'http://localhost:3211' })).toEqual([
      { port: 19000, upstreamPort: 3211, names: ['app'] },
      { port: 19001, upstreamPort: 3210, names: ['realtime', 'sync'] },
    ]);
    for (const endpoint of ['https://localhost:3210', 'http://example.com', 'http://[::1]:3210', 'http://user:password@localhost:3210', 'http://localhost:3210?token=value', 'http://localhost:3210#fragment']) expect(() => packetRoutes({ sync: endpoint })).toThrow();
    expect(() => packetRoutes({})).toThrow();
  });
  test('requires immutable images and finite bounded impairment settings', () => {
    const settings = { oneWayDelayMs: 50, lossPct: 5, seed: 42, packetLimit: 10000 };
    expect(() => validatePacketImpairment(settings)).not.toThrow();
    for (const changed of [{ oneWayDelayMs: NaN }, { oneWayDelayMs: -1 }, { oneWayDelayMs: 1001 }, { lossPct: Infinity }, { lossPct: 101 }, { seed: 0 }, { seed: 2 ** 32 }, { seed: 1.5 }, { packetLimit: 99 }, { hidden: true }]) expect(() => validatePacketImpairment({ ...settings, ...changed })).toThrow();
    expect(() => new PacketNetwork('alpine:latest', { sync: 'http://localhost:3210' }, settings)).toThrow(/immutable/);
    const network = new PacketNetwork(`sha256:${'a'.repeat(64)}`, { sync: 'http://localhost:3210' }, settings);
    settings.lossPct = 99;
    expect(network.impairment.lossPct).toBe(5);
    expect(Object.isFrozen(network.impairment)).toBe(true);
  });
  test('audits all selected packets, including oversized or uncounted skbs', () => {
    const rules = '[200:20000] -A FORWARD -s 169.254.254.2/32 -p tcp -m tcp --sport 19000 -j NETEM_AUDIT\n[100:10000] -A FORWARD -s 169.254.254.2/32 -p tcp -m tcp --sport 19001 -j NETEM_AUDIT\n[300:30000] -A NETEM_AUDIT -m length --length 0:65535\n[2:4000] -A NETEM_AUDIT -m length --length 1501:65535';
    expect(readPacketAudit(rules)).toEqual({ packets: 300, oversized: 2 });
    // A jumbo skb above the length rule's upper bound must not disappear.
    expect(() => readPacketAudit(rules.replace('[300:30000]', '[299:30000]'))).toThrow(/all selected/);
    expect(() => readPacketAudit(rules.replace('1501:65535', '9001:65535'))).toThrow(/rules/);
    expect(() => readPacketAudit(rules.replace('[2:4000]', '[301:4000]'))).toThrow();
    expect(() => readPacketAudit(rules.replace('[200:20000]', ''))).toThrow();
  });
});
