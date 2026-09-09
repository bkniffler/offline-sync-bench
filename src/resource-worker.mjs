import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
const exec = promisify(execFile);
const rootPid = Number(process.argv[2]);
const intervalMs = Number(process.argv[3]);
const includeRoot = !process.argv.includes('--descendants-only');
const samples = [];
let pending = null;
let stopping = false;
function cpuTime(value) {
  const [days, time] = value.includes('-') ? value.split('-') : ['0', value];
  const parts = time.split(':').map(Number);
  return Number(days) * 86400 + parts.reduce((total, part) => total * 60 + part, 0);
}
async function sample() {
  const { stdout } = await exec('ps', ['-axo', 'pid=,ppid=,rss=,time='], { maxBuffer: 8 * 1024 * 1024 });
  const rows = stdout.trim().split('\n').map(line => {
    const [pid, ppid, rss, time] = line.trim().split(/\s+/);
    return { pid: Number(pid), ppid: Number(ppid), rss: Number(rss), cpuMs: cpuTime(time) * 1000 };
  });
  const included = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) if (row.pid !== process.pid && included.has(row.ppid) && !included.has(row.pid)) { included.add(row.pid); changed = true; }
  }
  const selected = rows.filter(row => included.has(row.pid) && (includeRoot || row.pid !== rootPid));
  if (!rows.some(row => row.pid === rootPid)) throw new Error('Measured process exited during sampling');
  samples.push({ atMs: performance.now(), rssMb: selected.reduce((sum, row) => sum + row.rss / 1024, 0), processes: selected.map(({ pid, cpuMs }) => ({ pid, cpuMs })) });
}
function emit(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
try {
  await sample();
  emit({ ready: true });
  const timer = setInterval(() => {
    if (pending || stopping) return;
    pending = sample().catch(error => { emit({ error: error.message }); }).finally(() => { pending = null; });
  }, intervalMs);
  const input = createInterface({ input: process.stdin });
  for await (const line of input) {
    if (line !== 'stop' || stopping) continue;
    stopping = true; clearInterval(timer); await pending; await sample();
    const first = samples[0], last = samples.at(-1);
    let weightedMemory = 0, duration = 0, cpuTotalMs = 0;
    for (let i = 1; i < samples.length; i++) {
      const previous = samples[i - 1], current = samples[i];
      const elapsed = current.atMs - previous.atMs;
      weightedMemory += previous.rssMb * elapsed; duration += elapsed;
      for (const proc of current.processes) {
        const before = previous.processes.find(p => p.pid === proc.pid);
        if (before) cpuTotalMs += Math.max(0, proc.cpuMs - before.cpuMs);
      }
    }
    emit({ result: {
      metrics: { baseline_memory_mb: first.rssMb, avg_memory_mb: weightedMemory / duration,
        peak_memory_mb: Math.max(...samples.map(s => s.rssMb)), retained_memory_mb: last.rssMb,
        peak_memory_delta_mb: Math.max(...samples.map(s => s.rssMb)) - first.rssMb,
        avg_cpu_pct: cpuTotalMs / duration * 100, cpu_time_ms: cpuTotalMs, resource_sample_count: samples.length },
      metadata: { method: 'external-ps-process-tree-v1', rootPid, intervalMs, cpuResolutionMs: 10,
        scope: includeRoot ? 'measured process and descendants, excluding sampler' : 'client descendants only, excluding controller and sampler', includeRoot, window: 'caller-defined start/stop window; see scenario metadata',
        limitations: ['RSS sums can double-count shared pages across processes.', 'Short-lived children between polls and CPU consumed before first observation are not captured.', 'CPU times use OS ps resolution; peaks are sampled observations.'],
        samples: samples.map(s => ({ ...s, atMs: s.atMs - first.atMs })) }
    } });
    input.close(); process.stdin.destroy(); break;
  }
  clearInterval(timer);
} catch (error) { emit({ error: String(error) }); process.exitCode = 1; }
