export function percentile(values: number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1)
  );
  return round(sorted[index] ?? 0);
}

export function average(values: number[]): number {
  if (values.length === 0) return 0;
  const total = values.reduce((sum, value) => sum + value, 0);
  return round(total / values.length);
}

export function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export interface CpuUsageMetrics {
  avgCpuPct: number;
  peakCpuPct: number;
}

export interface MemoryUsageMetrics {
  avgMemoryMb: number;
  peakMemoryMb: number;
}

export interface DockerServiceUsageMetrics {
  avgCpuPct: number;
  peakCpuPct: number;
  avgMemoryMb: number;
  peakMemoryMb: number;
  rxNetworkMb: number;
  txNetworkMb: number;
}

export class MemorySampler {
  #peakBytes: number;
  #sumBytes: number;
  #sampleCount: number;
  #timer: ReturnType<typeof setInterval> | null;
  readonly #intervalMs: number;

  constructor(intervalMs = 20) {
    this.#intervalMs = intervalMs;
    const initialBytes = process.memoryUsage().rss;
    this.#peakBytes = initialBytes;
    this.#sumBytes = initialBytes;
    this.#sampleCount = 1;
    this.#timer = null;
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      const rss = process.memoryUsage().rss;
      this.#sumBytes += rss;
      this.#sampleCount += 1;
      if (rss > this.#peakBytes) {
        this.#peakBytes = rss;
      }
    }, this.#intervalMs);
  }

  stop(): MemoryUsageMetrics {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    const finalBytes = process.memoryUsage().rss;
    this.#sumBytes += finalBytes;
    this.#sampleCount += 1;
    if (finalBytes > this.#peakBytes) {
      this.#peakBytes = finalBytes;
    }

    return {
      avgMemoryMb: round(this.#sumBytes / this.#sampleCount / (1024 * 1024)),
      peakMemoryMb: round(this.#peakBytes / (1024 * 1024)),
    };
  }
}

export class CpuSampler {
  #lastCpuUsage: NodeJS.CpuUsage;
  #lastWallTimeMs: number;
  #peakCpuPct: number;
  #startedCpuUsage: NodeJS.CpuUsage;
  #startedWallTimeMs: number;
  #timer: ReturnType<typeof setInterval> | null;
  readonly #intervalMs: number;

  constructor(intervalMs = 50) {
    this.#startedCpuUsage = process.cpuUsage();
    this.#startedWallTimeMs = performance.now();
    this.#lastCpuUsage = this.#startedCpuUsage;
    this.#lastWallTimeMs = this.#startedWallTimeMs;
    this.#peakCpuPct = 0;
    this.#timer = null;
    this.#intervalMs = intervalMs;
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      const currentCpuUsage = process.cpuUsage();
      const currentWallTimeMs = performance.now();
      const intervalCpuPct = calculateCpuPct({
        currentCpuUsage,
        previousCpuUsage: this.#lastCpuUsage,
        currentWallTimeMs,
        previousWallTimeMs: this.#lastWallTimeMs,
      });

      if (intervalCpuPct > this.#peakCpuPct) {
        this.#peakCpuPct = intervalCpuPct;
      }

      this.#lastCpuUsage = currentCpuUsage;
      this.#lastWallTimeMs = currentWallTimeMs;
    }, this.#intervalMs);
  }

  stop(): CpuUsageMetrics {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }

    const currentCpuUsage = process.cpuUsage();
    const currentWallTimeMs = performance.now();
    const avgCpuPct = calculateCpuPct({
      currentCpuUsage,
      previousCpuUsage: this.#startedCpuUsage,
      currentWallTimeMs,
      previousWallTimeMs: this.#startedWallTimeMs,
    });

    const finalIntervalCpuPct = calculateCpuPct({
      currentCpuUsage,
      previousCpuUsage: this.#lastCpuUsage,
      currentWallTimeMs,
      previousWallTimeMs: this.#lastWallTimeMs,
    });

    return {
      avgCpuPct,
      peakCpuPct: round(Math.max(this.#peakCpuPct, finalIntervalCpuPct)),
    };
  }
}

function calculateCpuPct(args: {
  currentCpuUsage: NodeJS.CpuUsage;
  previousCpuUsage: NodeJS.CpuUsage;
  currentWallTimeMs: number;
  previousWallTimeMs: number;
}): number {
  const cpuMicros =
    args.currentCpuUsage.user -
    args.previousCpuUsage.user +
    (args.currentCpuUsage.system - args.previousCpuUsage.system);
  const wallTimeMs = args.currentWallTimeMs - args.previousWallTimeMs;

  if (wallTimeMs <= 0) {
    return 0;
  }

  const cpuMs = cpuMicros / 1000;
  return round((cpuMs / wallTimeMs) * 100);
}

interface DockerServiceSample {
  cpuPct: number;
  memoryMb: number;
  rxBytes: number;
  txBytes: number;
}

export class DockerServiceSampler {
  #timer: ReturnType<typeof setInterval> | null;
  readonly #intervalMs: number;
  readonly #containers: Array<{ label: string; id: string }>;
  readonly #samples = new Map<string, DockerServiceSample[]>();

  constructor(
    containers: Array<{ label: string; id: string }>,
    intervalMs = 250
  ) {
    this.#containers = containers;
    this.#intervalMs = intervalMs;
    this.#timer = null;
  }

  start(): void {
    if (this.#timer || this.#containers.length === 0) {
      return;
    }

    this.#sampleOnce();
    this.#timer = setInterval(() => {
      this.#sampleOnce();
    }, this.#intervalMs);
  }

  stop(): Record<string, DockerServiceUsageMetrics> {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }

    this.#sampleOnce();

    const metrics: Record<string, DockerServiceUsageMetrics> = {};
    for (const { label } of this.#containers) {
      const samples = this.#samples.get(label) ?? [];
      if (samples.length === 0) {
        metrics[label] = {
          avgCpuPct: 0,
          peakCpuPct: 0,
          avgMemoryMb: 0,
          peakMemoryMb: 0,
          rxNetworkMb: 0,
          txNetworkMb: 0,
        };
        continue;
      }

      const cpuValues = samples.map((sample) => sample.cpuPct);
      const memoryValues = samples.map((sample) => sample.memoryMb);
      const firstSample = samples[0];
      const lastSample = samples.at(-1) ?? firstSample;

      metrics[label] = {
        avgCpuPct: average(cpuValues),
        peakCpuPct: round(Math.max(...cpuValues)),
        avgMemoryMb: average(memoryValues),
        peakMemoryMb: round(Math.max(...memoryValues)),
        rxNetworkMb: round(
          Math.max(0, lastSample.rxBytes - firstSample.rxBytes) / (1024 * 1024)
        ),
        txNetworkMb: round(
          Math.max(0, lastSample.txBytes - firstSample.txBytes) / (1024 * 1024)
        ),
      };
    }

    return metrics;
  }

  #sampleOnce(): void {
    if (this.#containers.length === 0) {
      return;
    }

    const result = Bun.spawnSync(
      [
        'docker',
        'stats',
        '--no-stream',
        '--format',
        '{{.Container}}|{{.CPUPerc}}|{{.MemUsage}}|{{.NetIO}}',
        ...this.#containers.map((container) => container.id),
      ],
      {
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );

    if (result.exitCode !== 0) {
      return;
    }

    const output = new TextDecoder().decode(result.stdout).trim();
    if (!output) {
      return;
    }

    const labelByContainerId = new Map(
      this.#containers.map((container) => [container.id, container.label])
    );

    for (const line of output.split('\n')) {
      const [containerId, cpuRaw, memoryRaw, networkRaw] = line.split('|');
      if (!containerId || !cpuRaw || !memoryRaw || !networkRaw) {
        continue;
      }

      const label = labelByContainerId.get(containerId.trim());
      if (!label) {
        continue;
      }

      const memoryMb = parseDockerMemoryUsageMb(memoryRaw);
      const [rxBytes, txBytes] = parseDockerIoBytes(networkRaw);
      const sample: DockerServiceSample = {
        cpuPct: parseDockerPercent(cpuRaw),
        memoryMb,
        rxBytes,
        txBytes,
      };

      const samples = this.#samples.get(label) ?? [];
      samples.push(sample);
      this.#samples.set(label, samples);
    }
  }
}

function parseDockerPercent(value: string): number {
  return round(Number.parseFloat(value.replace('%', '').trim()) || 0);
}

function parseDockerMemoryUsageMb(value: string): number {
  const usedValue = value.split('/')[0]?.trim() ?? '0B';
  return round(parseDockerByteValue(usedValue) / (1024 * 1024));
}

function parseDockerIoBytes(value: string): [number, number] {
  const [rxValue, txValue] = value.split('/').map((part) => part.trim());
  return [parseDockerByteValue(rxValue ?? '0B'), parseDockerByteValue(txValue ?? '0B')];
}

function parseDockerByteValue(value: string): number {
  const normalized = value.replace(/\s+/g, '');
  const match = normalized.match(/^([0-9]+(?:\.[0-9]+)?)([A-Za-z]+)$/);
  if (!match) {
    return 0;
  }

  const numericValue = Number.parseFloat(match[1] ?? '0');
  const unit = (match[2] ?? 'B').toUpperCase();
  const scale =
    unit === 'B'
      ? 1
      : unit === 'KB' || unit === 'KIB'
        ? 1024
        : unit === 'MB' || unit === 'MIB'
          ? 1024 ** 2
          : unit === 'GB' || unit === 'GIB'
            ? 1024 ** 3
            : unit === 'TB' || unit === 'TIB'
              ? 1024 ** 4
              : 1;

  return numericValue * scale;
}
