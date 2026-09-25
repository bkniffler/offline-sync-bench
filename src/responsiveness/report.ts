import { median as defaultMedian } from '../statistics.ts';

export const stackLabels: Record<string, string> = { syncular: 'Syncular JS', powersync: 'PowerSync', zero: 'Zero', electric: 'Electric', 'electric-tanstack': 'Electric + TanStack DB' };
const metric = (trial: any, path: string) => path.split('.').reduce((value, key) => value?.[key], trial) as number | undefined;
const format = (value: number | null) => value === null ? 'n/a' : value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2);

export const conditionOrder = ['default', 'low-priority'];
export const conditionLabels: Record<string, string> = { default: 'Default priority', 'low-priority': 'Low CPU priority (slower device)' };

export function aggregate(report: any, median = defaultMedian) {
  const groups = new Map<string, any[]>();
  for (const trial of report.trials) {
    if (!trial.condition || trial.label === 'warmup') continue;
    const key = `${trial.stack}:${trial.condition}`;
    groups.set(key, [...groups.get(key) ?? [], trial]);
  }
  return [...groups.entries()].map(([key, trials]) => {
    const [stack, condition] = key.split(':');
    const done = trials.filter(t => t.status === 'completed');
    const pick = (path: string) => { const values = done.map(t => metric(t, path)!).filter(Number.isFinite); return values.length ? median(values) : null; };
    return { stack, condition: condition!, n: done.length, failed: trials.length - done.length,
      bootstrapMs: pick('milestones.bootstrapCompleteMs'), bootstrapInputP95: pick('windows.bootstrap.input_latency_p95_ms'), bootstrapInputMax: pick('windows.bootstrap.input_latency_max_ms'),
      bootstrapBlockingPct: pick('windows.bootstrap.blocking_pct'), bootstrapLongestFrame: pick('windows.bootstrap.longest_frame_ms'), bootstrapQueryP95: pick('windows.bootstrap.screen_query_p95_ms'),
      catchUpMs: pick('milestones.catchUpCompleteMs'), catchUpInputP95: pick('windows.catchup.input_latency_p95_ms'), catchUpInputMax: pick('windows.catchup.input_latency_max_ms'),
      catchUpBlockingPct: pick('windows.catchup.blocking_pct'), catchUpLongestFrame: pick('windows.catchup.longest_frame_ms'), catchUpQueryP95: pick('windows.catchup.screen_query_p95_ms'),
      idleInputP95: pick('windows.idle.input_latency_p95_ms'), peakRssMb: pick('process.bootstrap.peak_rss_mb'),
      calibrationMainMs: pick('calibration.mainMs'), calibrationWorkerMs: pick('calibration.workerMs') };
  }).sort((a, b) => conditionOrder.indexOf(a.condition) - conditionOrder.indexOf(b.condition) || Object.keys(stackLabels).indexOf(a.stack!) - Object.keys(stackLabels).indexOf(b.stack!));
}

export function renderResponsiveness(report: any, options: { median?: typeof defaultMedian } = {}) {
  const rows = aggregate(report, options.median);
  const label = (row: any) => `${stackLabels[row.stack] ?? row.stack}${row.n < 3 ? ` (n=${row.n})` : ''}${row.failed ? ` · ${row.failed} failed` : ''}`;
  const lines = [`# Sync responsiveness`, '', `${report.plan.bootstrapRows.toLocaleString()}-task cold bootstrap, then ${report.plan.catchUpRows.toLocaleString()} server-side task updates delivered to the live client. Chromium ${report.machine.chromium.match(/chromium-(\d+)/)?.[1] ?? ''} on ${report.machine.cpu}. Medians of completed trials; milliseconds unless marked.`, ''];
  for (const condition of [...new Set(rows.map(row => row.condition))]) {
    const group = rows.filter(row => row.condition === condition);
    lines.push(`## ${conditionLabels[condition] ?? condition}`, '', '| Client | Bootstrap | Input p95 | Input max | Main thread blocked | Longest frame | Screen query p95 | Catch-up | Input p95 | Input max | Main thread blocked | Idle input p95 |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
    for (const row of group) lines.push(`| ${label(row)} | ${format(row.bootstrapMs)} | ${format(row.bootstrapInputP95)} | ${format(row.bootstrapInputMax)} | ${format(row.bootstrapBlockingPct)}% | ${format(row.bootstrapLongestFrame)} | ${format(row.bootstrapQueryP95)} | ${format(row.catchUpMs)} | ${format(row.catchUpInputP95)} | ${format(row.catchUpInputMax)} | ${format(row.catchUpBlockingPct)}% | ${format(row.idleInputP95)} |`);
    lines.push('');
  }
  lines.push('Calibration (fixed integer loop, ms, main thread / worker): ' + rows.map(row => `${stackLabels[row.stack!]} ${row.condition} ${format(row.calibrationMainMs)} / ${format(row.calibrationWorkerMs)}`).join('; '), '');
  return lines.join('\n');
}
