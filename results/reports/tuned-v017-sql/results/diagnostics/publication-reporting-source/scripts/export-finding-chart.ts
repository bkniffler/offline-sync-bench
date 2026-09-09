/** Export a reviewed finding using the table renderer's comparison rules.
 * bun scripts/export-finding-chart.ts CAMPAIGN.json ANNOTATION_ID OUTPUT.json
 */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { validateManifest, validateAnnotations, summarizeCase, groupAttempts } from '../src/campaign-report.ts';
import { validateFindingSelection, findingGroups, profileLabel, metricUnit, workloadLabel } from '../src/report-editorial.ts';
import { hash } from '../src/contracts/screens.ts';
import type { CampaignManifest } from '../src/campaign.ts';
const [path, id, output] = process.argv.slice(2);
assert(path && id && output, 'Supply CAMPAIGN.json ANNOTATION_ID OUTPUT.json');
const bytes = await readFile(path), manifest = JSON.parse(bytes.toString()) as CampaignManifest;
validateManifest(manifest); groupAttempts(manifest.attempts);
assert.equal(manifest.config.trials, 3, 'This chart format is for the three-attempt replacement collection');
const annotation = validateFindingSelection(manifest, validateAnnotations(manifest), true).find(a => a.id === id);
assert(annotation?.table?.metrics.length, 'Select a reviewed finding with measured metrics');
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const groups = findingGroups(manifest, annotation).map(({ profile, attempts }) => ({
  profile: profileLabel(profile), comparisonKey: profile.comparisonKey,
  rows: attempts.map(group => {
    const latest = group.at(-1)!.result;
    return { stack: latest.stackId, storage: (latest.metadata.profile as any).storage,
      execution: (latest.metadata.profile as any).execution, latestOutcome: latest.status,
      passed: group.filter(a => a.result.status === 'completed').length, attempted: group.length,
      metrics: annotation.table!.metrics.map(metric => {
        const summary = summarizeCase(group, metric.key);
        return { ...metric, unit: metricUnit(metric.key), ...summary,
          // Match the tables: do not rescue a failed latest attempt with old timings.
          values: summary.summary ? group.filter(a => a.result.status === 'completed').map(a => a.result.metrics[metric.key]) : [] };
      }) };
  }) }));
await writeFile(output, JSON.stringify({ version: 1, kind: 'reviewed-three-attempt-chart',
  campaignId: manifest.id, sourceHash: manifest.source.sourceHash, manifestSha256: sha(bytes),
  exporterSha256: sha(await readFile(import.meta.path)), annotationId: annotation.id,
  question: annotation.question, workload: workloadLabel(annotation.table.scenarioId, manifest.config.parameters?.startupSizes),
  host: manifest.machine.cpuModel, network: manifest.config.network,
  resultBindings: manifest.attempts.filter(a => annotation.resultIds.includes(a.result.resultId)).map(a => ({
    resultId: a.result.resultId, resultDigest: hash(a.result), trial: a.trial, status: a.result.status })),
  groups, scope: 'Each dot is one successful independent trial summary; lines show observed min–max and diamonds show medians. No confidence interval. Failed latest attempts have no timing estimate. Profiles and configured stack order are preserved.'
}, null, 2) + '\n', { flag: 'wx' });
