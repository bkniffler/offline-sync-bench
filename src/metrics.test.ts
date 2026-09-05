import { expect, spyOn, test } from 'bun:test';
import { DockerServiceSampler } from './metrics';

test('slow Docker polls keep timers responsive and never overlap', async () => {
  const spawn = Bun.spawn.bind(Bun);
  let active = 0;
  let peakActive = 0;
  const spy = spyOn(Bun, 'spawn').mockImplementation(() => {
    active++;
    peakActive = Math.max(peakActive, active);
    const child = spawn([
      process.execPath, '-e',
      "await Bun.sleep(120); console.log('test-container|12%|64MiB / 1GiB|1kB / 2kB')",
    ], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    void child.exited.then(() => { active--; });
    return child;
  });
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 5);
  const sampler = new DockerServiceSampler([{ label: 'sync', id: 'test-container' }], 10);
  let stopped = false;
  try {
    await sampler.start();
    expect(ticks).toBeGreaterThan(5);
    await Bun.sleep(60);
    const result = await sampler.stop();
    stopped = true;
    expect(peakActive).toBe(1);
    expect(spy).toHaveBeenCalledTimes(3);
    expect(result.sync?.avgMemoryMb).toBe(64);
    expect(result.sync?.avgCpuPct).toBe(12);
  } finally {
    if (!stopped) await sampler.stop().catch(() => {});
    clearInterval(timer);
    spy.mockRestore();
  }
});
