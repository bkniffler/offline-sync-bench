import { resolve } from 'node:path';
import { publishCampaign } from './campaign-report.ts';
import { benchmarkRoot } from './paths.ts';
const flag = process.argv.indexOf('--campaign');
if (flag < 0 || !process.argv[flag + 1]) throw new Error('Publication requires --campaign <path-to-CAMPAIGN.json>. Legacy --run-id reports are archived; unscoped history cannot be published.');
await publishCampaign(resolve(process.argv[flag + 1]), benchmarkRoot);
console.log('Published validated findings to RESULTS.md, raw measurements to RESULTS.json, and complete tables to results/reports/<campaign-id>/DETAILS.md');
