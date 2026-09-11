import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { summarizeLargeFilePairs, validateLargeFilePublication } from './large-publication.ts';
const report = JSON.parse(await readFile('results/investigations/syncular-018-019-blobs/PAIRS.json', 'utf8'));

test('controlled publication uses all three actual total-upload samples, not one run or summed phase medians', () => {
 const { rows, sampling } = summarizeLargeFilePairs(report);
 expect(rows.map(r => [r.uploadMs, r.downloadMs])).toEqual([[3006.240458, 1890.0206249999999], [3765.503332, 2202.146375]]);
 expect(sampling.syncular.trials).toBe(3);
 expect(sampling['syncular-rust'].pairs).toEqual([1, 2, 3]);
 const synthetic = structuredClone(report);
 const native = synthetic.rows.filter((r: any) => r.client === 'syncular-rust' && r.version === '0.19.0');
 native.forEach((row: any, i: number) => {
  row.result.phases[0].stageMs = [1, 2, 100][i];
  row.result.phases[0].uploadMs = [100, 2, 1][i];
  row.result.uploadMs = row.result.phases[0].stageMs + row.result.phases[0].uploadMs;
 });
 expect(summarizeLargeFilePairs(synthetic).rows[1]!.uploadMs).toBe(101); // Sum of phase medians would incorrectly give 4.

});

test('missing, duplicated or invalid baseline/candidate receipts cannot become published medians', () => {
 for (const corrupt of [
  (r: any) => r.rows.pop(),
  (r: any) => { r.rows[1] = r.rows[0]; },
  (r: any) => { r.rows[0].result.phases[1].complete.sha256 = '0'.repeat(64); },
  (r: any) => { r.rows[1].result.status = 'failed'; },
  (r: any) => { r.server.server = '0.18.0'; },
 ]) { const clone = structuredClone(report); corrupt(clone); expect(() => summarizeLargeFilePairs(clone)).toThrow(); }
});

test('publication rejects tampered medians and sample-design claims', async () => {
 const { rows, sampling } = summarizeLargeFilePairs(report);
 const { digest, singleRunSampling } = await import('./large-publication.ts');
 const prior = JSON.parse(await readFile('results/large-files/RESULTS.json', 'utf8'));
 const old = prior.collections.find((c: any) => c.selectedStacks.includes('powersync'));
 const raw = await readFile('results/investigations/syncular-018-019-blobs/PAIRS.json');
 const data = { version: 3, aggregation: { path: 'src/attachments/large-publication.ts', sha256: digest(await readFile('src/attachments/large-publication.ts')) }, kind: 'large-native-attachments', fixture: report.fixture, sourceUnchanged: true,
  plan: { stacks: ['syncular', 'syncular-rust', 'powersync', 'jazz-v2'] },
  rows: [...rows, ...prior.rows.filter((r: any) => ['powersync', 'jazz-v2'].includes(r.stackId))],
  sampling: { ...sampling, powersync: singleRunSampling, 'jazz-v2': singleRunSampling },
  collections: [{ ...old, selectedStacks: ['powersync', 'jazz-v2'] }, { kind: 'controlled-client-release-pairs', path: '../investigations/syncular-018-019-blobs/PAIRS.json', sha256: digest(raw), selectedStacks: ['syncular', 'syncular-rust'] }],
 };
 await validateLargeFilePublication(data, 'results/large-files');
 const wrongNumber = structuredClone(data); wrongNumber.rows[0].uploadMs -= 1;
 await expect(validateLargeFilePublication(wrongNumber, 'results/large-files')).rejects.toThrow();
 const wrongDesign = structuredClone(data); wrongDesign.sampling.powersync.trials = 3;
 await expect(validateLargeFilePublication(wrongDesign, 'results/large-files')).rejects.toThrow();
});
