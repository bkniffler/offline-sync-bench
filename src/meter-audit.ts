import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHttpMeter } from './http-meter.ts';
import { shuffled, trialSummary } from './statistics.ts';
import { sourceIdentity } from './provenance.ts';
import { benchmarkRoot } from './paths.ts';

/** Transport instrumentation experiment, separate from product measurements. */
const samples: Array<{ bytes: number; mode: string; trial: number; durationMs: number; receivedBytes: number; meteredBytes: number | null }> = [];
const server = Bun.serve({ port: 0, fetch(request) {
  const size = Number(new URL(request.url).pathname.slice(1));
  let remaining = size;
  return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
    if (remaining === 0) { controller.close(); return; }
    const chunk = new Uint8Array(Math.min(remaining, 16_384)).fill(97);
    remaining -= chunk.length; controller.enqueue(chunk);
  } }), { headers: { 'content-type': 'application/octet-stream' } });
} });
try {
  for (const bytes of [65_536, 2_097_152]) {
    for (let trial = -2; trial < 10; trial++) {
      for (const mode of shuffled(['unmetered', 'stream-metered'], 20260906 + trial)) {
        const meter = createHttpMeter(fetch);
        const measuredFetch = mode === 'unmetered' ? fetch : meter.fetch;
        const start = performance.now();
        const body = new Uint8Array(await (await measuredFetch(new URL(String(bytes), server.url))).arrayBuffer());
        const durationMs = performance.now() - start;
        if (body.length !== bytes || body.some(byte => byte !== 97)) throw new Error('Meter audit body mismatch');
        if (mode === 'stream-metered' && meter.snapshot().responseBytes !== bytes) throw new Error('Meter audit byte count mismatch');
        if (trial >= 0) samples.push({ bytes, mode, trial, durationMs, receivedBytes: body.length, meteredBytes: mode === 'stream-metered' ? meter.snapshot().responseBytes : null });
      }
    }
  }
  const summaries = [65_536, 2_097_152].map(bytes => {
    const baseline = samples.filter(s => s.bytes === bytes && s.mode === 'unmetered').map(s => s.durationMs);
    const measured = samples.filter(s => s.bytes === bytes && s.mode === 'stream-metered').map(s => s.durationMs);
    const ratios = measured.map((value, index) => value / baseline[index]);
    return { bytes, unmetered: trialSummary(baseline), metered: trialSummary(measured), pairedRatio: trialSummary(ratios) };
  });
  const path = join(benchmarkRoot, 'results/diagnostics/http-meter-audit.json');
  await mkdir(join(benchmarkRoot, 'results/diagnostics'), { recursive: true });
  await writeFile(path, `${JSON.stringify({ kind: 'instrumentation-experiment', capturedAt: new Date().toISOString(), source: sourceIdentity(), runtime: Bun.version, protocol: 'loopback HTTP, 16 KiB response chunks, full body consumption', warmups: 2, trials: 10, limitations: ['One runtime and machine; this experiment does not establish overhead for all product transports.', 'Sub-millisecond loopback durations are noisy. Product comparisons require their own phase diagnostics.'], summaries, samples }, null, 2)}\n`);
  console.log(path);
} finally { await server.stop(true); }
