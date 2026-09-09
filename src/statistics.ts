export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state += 0x6d2b79f5; let t = state; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
export function shuffled<T>(items: readonly T[], seed: number): T[] {
  const result = [...items], random = seededRandom(seed);
  for (let i = result.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [result[i], result[j]] = [result[j], result[i]]; }
  return result;
}
export function median(values: number[]): number {
  if (!values.length || values.some(v => !Number.isFinite(v))) throw new Error('Median requires finite samples');
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
/** Resamples independent trial summaries, never pooled operations. */
export function trialSummary(values: number[], seed = 1) {
  const center = median(values);
  if (values.length < 5) return { trials: values.length, median: center, min: Math.min(...values), max: Math.max(...values), confidence95: null };
  const random = seededRandom(seed);
  const bootstrap = Array.from({ length: 2000 }, () => median(values.map(() => values[Math.floor(random() * values.length)]))).sort((a, b) => a - b);
  return { trials: values.length, median: center, min: Math.min(...values), max: Math.max(...values), confidence95: [bootstrap[49], bootstrap[1949]] };
}
