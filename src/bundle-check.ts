import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { analyzeTarget, buildAnalysisMarkdown, type BundleAnalysisRow } from './bundle-analyze';
import { cleanupBundleTemp, getBundleTargetsByIds, resultsRoot } from './bundle-size';

interface BundleBudgetTarget {
  id: string;
  label: string;
  baselineRawKb: number;
  baselineGzipKb: number;
  maxRawKb: number;
  maxGzipKb: number;
}

interface BundleBudgetFile {
  targets: BundleBudgetTarget[];
}

interface BundleCheckRow {
  target: BundleBudgetTarget;
  measured: BundleAnalysisRow;
  rawDeltaKb: number;
  gzipDeltaKb: number;
  passed: boolean;
  reasons: string[];
}

function roundKb(value: number): number {
  return Math.round(value * 100) / 100;
}

async function main(): Promise<void> {
  const budgetPath = join(
    '/Users/bkniffler/GitHub/sync/offline-sync-bench',
    'config',
    'bundle-budget.json'
  );
  const budget = JSON.parse(
    await readFile(budgetPath, 'utf8')
  ) as BundleBudgetFile;
  const selectedTargets = getBundleTargetsByIds(
    budget.targets.map((target) => target.id)
  );
  const measuredRows = await Promise.all(
    selectedTargets.map((target) => analyzeTarget(target))
  );
  await Bun.write(
    join(resultsRoot, 'BUNDLE_CHECK_ANALYSIS.json'),
    `${JSON.stringify(measuredRows, null, 2)}\n`
  );
  await Bun.write(
    join(resultsRoot, 'BUNDLE_CHECK_ANALYSIS.md'),
    `${buildAnalysisMarkdown(measuredRows)}\n`
  );

  const checks: BundleCheckRow[] = budget.targets.map((target) => {
    const measured = measuredRows.find((row) => row.targetId === target.id);
    if (!measured) {
      throw new Error(`Missing measured bundle row for ${target.id}`);
    }
    const reasons: string[] = [];
    const rawKb = measured.rawKb;
    const gzipKb = measured.gzipKb;
    if (rawKb > target.maxRawKb) {
      reasons.push(`raw size ${rawKb}KB exceeds max ${target.maxRawKb}KB`);
    }
    if (gzipKb > target.maxGzipKb) {
      reasons.push(`gzip size ${gzipKb}KB exceeds max ${target.maxGzipKb}KB`);
    }
    return {
      target,
      measured,
      rawDeltaKb: roundKb(rawKb - target.baselineRawKb),
      gzipDeltaKb: roundKb(gzipKb - target.baselineGzipKb),
      passed: reasons.length === 0,
      reasons,
    };
  });

  const markdown = [
    '# Bundle Guard',
    '',
    '| Target | Status | Raw KB | Baseline Raw KB | Delta Raw KB | Max Raw KB | Gzip KB | Baseline Gzip KB | Delta Gzip KB | Max Gzip KB | Notes |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
    ...checks.map((check) => {
      const rawKb = check.measured.rawKb ?? 'n/a';
      const gzipKb = check.measured.gzipKb ?? 'n/a';
      return `| \`${check.target.id}\` | ${check.passed ? 'pass' : 'fail'} | ${rawKb} | ${check.target.baselineRawKb} | ${check.rawDeltaKb} | ${check.target.maxRawKb} | ${gzipKb} | ${check.target.baselineGzipKb} | ${check.gzipDeltaKb} | ${check.target.maxGzipKb} | ${check.reasons.join('; ')} |`;
    }),
    '',
    'Latest measured compiled bundle analysis:',
    '',
    buildAnalysisMarkdown(measuredRows),
    '',
  ].join('\n');

  await Bun.write(join(resultsRoot, 'BUNDLE_CHECK.md'), `${markdown}\n`);
  console.log(markdown);
  await cleanupBundleTemp();

  const failed = checks.filter((check) => !check.passed);
  if (failed.length > 0) {
    throw new Error(
      `Bundle guard failed for ${failed.map((item) => item.target.id).join(', ')}`
    );
  }
}

if (import.meta.main) {
  await main();
}
