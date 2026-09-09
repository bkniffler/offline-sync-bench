import { expect, test } from 'bun:test';
import { ExternalResources } from './resources.ts';
test('a selected client tree excludes its controller and sibling clients', async () => {
  const children = [0, 1].map(() => Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], { stdout: 'ignore', stderr: 'ignore' }));
  const sampler = new ExternalResources(true, children[0]!.pid);
  try {
    await sampler.start();
    const result = await sampler.stop();
    expect(result.metadata.rootPid).toBe(children[0]!.pid);
    const samples = result.metadata.samples as Array<{ processes: Array<{ pid: number }> }>;
    expect(samples.length).toBeGreaterThanOrEqual(2);
    expect(samples.every(sample => sample.processes.some(p => p.pid === children[0]!.pid))).toBe(true);
    expect(samples.every(sample => sample.processes.every(p => p.pid !== process.pid && p.pid !== children[1]!.pid))).toBe(true);
  } finally { sampler.abort(); for (const child of children) child.kill(); await Promise.all(children.map(child => child.exited)); }
});
test('external samples continue during synchronous work', async () => {
  const sampler = new ExternalResources();
  await sampler.start();
  try {
    const deadline = performance.now() + 250;
    while (performance.now() < deadline) Math.sqrt(Math.random());
    const result = await sampler.stop();
    expect(result.metrics.resource_sample_count).toBeGreaterThan(3);
    expect(result.metrics.peak_memory_mb).toBeGreaterThanOrEqual(result.metrics.baseline_memory_mb);
    expect(result.metrics.retained_memory_mb).toBeGreaterThan(0);
    expect(result.metadata.method).toBe('external-ps-process-tree-v1');
  } finally { sampler.abort(); }
});

test('startup sampling excludes retained controller data and includes a newly launched client', async () => {
  const sampler = new ExternalResources(false);
  await sampler.start();
  const child = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], { stdout: 'ignore', stderr: 'ignore' });
  try {
    await new Promise(resolve => setTimeout(resolve, 100));
    const result = await sampler.stop();
    expect(result.metrics.baseline_memory_mb).toBe(0);
    expect(result.metrics.peak_memory_mb).toBeGreaterThan(0);
    expect(result.metadata.includeRoot).toBe(false);
    const samples = result.metadata.samples as Array<{ processes: Array<{ pid: number }> }>;
    expect(samples.some(sample => sample.processes.some(p => p.pid === child.pid))).toBe(true);
    expect(samples.every(sample => sample.processes.every(p => p.pid !== process.pid))).toBe(true);
  } finally { sampler.abort(); child.kill(); await child.exited; }
});
