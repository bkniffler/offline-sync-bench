/** Provisional observations; collection completion is distinct from publication acceptance. */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { groupAttempts, summarizeCase } from '../src/campaign-report.ts';
import { profileLabel } from '../src/report-editorial.ts';
import { validateResult } from '../src/execution.ts';
import { resultProfile } from '../src/profiles.ts';
import { hash } from '../src/contracts/screens.ts';
import type { CampaignManifest } from '../src/campaign.ts';
const [input, output, landingFlag] = process.argv.slice(2); assert(input && output, 'Supply CAMPAIGN.json OUTPUT_DIRECTORY [--update-landing]');
assert(landingFlag === undefined || landingFlag === '--update-landing');
const bytes = await readFile(input), m = JSON.parse(bytes.toString()) as CampaignManifest;
assert(['running', 'complete'].includes(m.status)); assert.equal(m.config.trials, 3);
assert(!landingFlag || m.status==='running', 'The SQL-only landing update cannot replace the combined completed SQL and Zero collection summary.');
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const bindings=[];
for (const [i,a] of m.attempts.entries()) {
 assert.deepEqual({stackId:a.stackId,scenarioId:a.scenarioId,trial:a.trial},m.plan[i]);
 const raw=await readFile(resolve(dirname(input),a.resultFile)); assert.deepEqual(JSON.parse(raw.toString()),a.result);
 validateResult(a.result);
 assert.deepEqual(resultProfile(a.result,{...m,network:m.config.network}),a.result.metadata.profile);
 assert.equal(a.result.metadata.profile.sourceHash,m.source.sourceHash);
 bindings.push({index:i+1,resultId:a.result.resultId,resultDigest:hash(a.result),rawSha256:sha(raw),resultFile:a.resultFile});
}
const groups=groupAttempts(m.attempts), esc=(s:unknown)=>String(s).replaceAll('|','\\|').replaceAll('\n',' ');
const fmt=(n:number)=>n===0?'0':n<.01?n.toFixed(4):n<1?n.toFixed(3):n<100?n.toFixed(2):n.toFixed(1);
const sections: Array<[string,string,Array<[string,string]>]> = [
 ['local-query','Task screens · 100,000 tasks',[['list_query_p50_ms','List p50'],['search_query_p50_ms','Search p50'],['aggregate_query_p50_ms','Aggregate p50']]],
 ['deep-relationship-query','Relationship screens · 100,000 tasks',[['dashboard_query_p50_ms','Dashboard p50'],['detail_join_query_p50_ms','Detail p50']]],
 ['online-propagation','Collaboration · 200 tasks, 50 measured writes',[['local_commit_p50_ms','Local commit p50'],['server_accepted_p50_ms','Server accepted p50'],['mirror_visible_p50_ms','Reader visible p50']]],
 ...[1000,10000,100000].map(n=>['bootstrap',`Startup · ${n.toLocaleString('en-US')} tasks`,[[`startup_process_cold_${n}_first_screen_ms`,'First screen (cold service)'],[`startup_process_cold_${n}_full_data_ms`,'Full data (cold service)'],[`startup_warm_${n}_first_screen_ms`,'First screen (warm service)'],[`startup_warm_${n}_full_data_ms`,'Full data (warm service)']]] as [string,string,Array<[string,string]>]),
 ['replica-reopen','Offline replica reopen · 2,000 tasks',[['reopen_process_ms','Initialized'],['reopen_first_screen_ms','First screen'],['reopen_all_rows_ms','All rows']]],
 ['offline-replay','Offline replay · 10 queued writes',[['queue_10_drain_ms','Queue drained'],['queue_10_mirror_visible_ms','Reader converged']]],
 ['large-offline-queue','Replay scaling · reader convergence',[['queue_100_mirror_visible_ms','100 writes'],['queue_500_mirror_visible_ms','500 writes'],['queue_1000_mirror_visible_ms','1,000 writes']]],
 ['offline-restart','Process crash and offline reopen · 1,000 queued writes',[['queue_1000_reopen_local_ms','Offline reopen'],['queue_1000_drain_ms','Queue drained'],['queue_1000_mirror_visible_ms','Reader converged']]],
 ['connected-fanout','Connected delivery · 2,000 tasks per reader',[['clients_5_all_converged_ms','5 readers'],['clients_25_all_converged_ms','25 readers']]],
 ['reconnect-storm','Reconnect · 100 updates accumulated behind blocked routes',[['clients_5_all_converged_ms','5 readers'],['clients_25_all_converged_ms','25 readers']]],
 ['permission-change','Access revocation · separate guarantee profiles',[['online_convergence_ms','Online removal'],['offline_reconnect_convergence_ms','After reconnect']]],
 ['blob-flow','Attachments · two 2 MiB objects',[['initial_upload_ms','Upload'],['initial_metadata_visible_ms','Metadata visible'],['fresh_download_ms','Fresh download'],['download_interruption_recovery_ms','Interrupted download recovery']]],
 ['conflict-update-update','Update/update conflict · policy and outcome check',[]],
 ['conflict-update-delete','Update/delete conflict · policy and outcome check',[]],
];
const at=new Date().toISOString();
const campaignLabel=m.config.stacks.length===1 && m.config.stacks[0]==='zero'?'Zero native-screen':'SQL';
const lines=['# Current measurements — provisional','',`Snapshot: **${m.attempts.length}/${m.plan.length} ${campaignLabel} attempts**, captured ${at}. Collection status: **${m.status}**. Three attempts maximum per case. ${campaignLabel==='SQL'?'Syncular JS/Rust 0.17.0. [Zero replacement screen measurements](../tuned-v017-zero-current/RESULTS.md) are recorded separately.':'Native queries handle filtering, ordering and relationships; aggregation materializes rows and groups them in JavaScript. [SQL measurements](../tuned-v017-current/RESULTS.md) are recorded separately.'}`, '',
 '**Every timing below is milliseconds: median [observed minimum–maximum] across successful independent trials.** The pass/attempt column gives the actual count; incomplete cases are marked. These are observations, not the final reviewed findings or a confidence interval. Operation p50 values are summarized across trials, not pooled.', '',
 'A dash means no eligible timing measurement, never zero. Failed latest attempts supply no timing estimate, even if an older attempt passed. Earlier failures remain counted. Distinct guarantee profiles have separate tables. Workload setup time is excluded from operation metrics where the contract specifies it; whole-attempt elapsed time is not operation latency.', '',
 '[Full raw snapshot, including every saved result and its metadata](./CAMPAIGN.json.gz) · [Snapshot checks and hashes](./CHECKS.json) · [Full-roster coverage](../../diagnostics/publication-coverage/COVERAGE.md) · [Methodology](../../../docs/methodology.md) · [Failure explanations](../../../docs/investigations/tuned-publication-failures.md)', ''];
const compact:Record<string,unknown>={};
for (const [scenario,title,metrics] of sections) {
 const relevant=[...groups.values()].filter(g=>g[0].scenarioId===scenario).sort((a,b)=>m.config.stacks.indexOf(a[0].stackId)-m.config.stacks.indexOf(b[0].stackId));
 if(relevant.length===0)continue;
 const profiles=new Map<string,typeof relevant>();
 for(const g of relevant){const p=g.at(-1)!.result.metadata.profile as any;const key=JSON.stringify([p.lane,p.comparisonKey]);profiles.set(key,[...(profiles.get(key)??[]),g]);}
 lines.push(`## ${title}`,'');
 for(const rows of profiles.values()){
  lines.push(`Profile: ${esc(profileLabel(rows[0].at(-1)!.result.metadata.profile as any))}.`, '');
  const headers=['Client / execution','Passed / attempted','Latest outcome',...metrics.map(([,label])=>label),...(scenario.startsWith('conflict-')?['Declared outcome']:[])];
  lines.push('| '+headers.join(' | ')+' |','| '+headers.map(()=>'---').join(' | ')+' |');
  for(const g of rows){
   const r=g.at(-1)!.result,p=r.metadata.profile as any;const passed=g.filter(a=>a.result.status==='completed').length;
   const vals=metrics.map(([key])=>{const v=summarizeCase(g,key);return v.summary?`${fmt(v.summary.median)} [${fmt(v.summary.min)}–${fmt(v.summary.max)}]`:'—';});
   const cells=[`${r.stackId} / ${p.execution === 'unspecified' ? p.storage : p.execution}`,`${passed}/${g.length}${g.length<3?' (incomplete)':''}`,r.status,...vals];
   if(scenario.startsWith('conflict-'))cells.push(String((r.metadata.policy??(r.metadata.evidence as any)?.policy as any)?.outcome??'unavailable'));
   lines.push('| '+cells.map(esc).join(' | ')+' |');
   compact[`${scenario}/${r.stackId}/${title}`]={passed,attempted:g.length,latest:r.status,metrics:Object.fromEntries(metrics.map(([key])=>[key,summarizeCase(g,key)]))};
  }
  lines.push('');
 }
}
lines.push('## Status and evidence','',`Measured source: \`${m.source.sourceHash}\`. This snapshot verifies the saved plan prefix, raw-result equality, per-result contracts and profile consistency. It does **not** pass the completed-campaign publication gate or replace final source/archive, annotation and chart review. ${m.status==='complete'?'Collection is complete.':'Collection is in progress.'} Final publication review remains pending.`, '');
await mkdir(output,{recursive:true});
const zipped=gzipSync(bytes,{level:6}),md=lines.join('\n');
await writeFile(resolve(output,'CAMPAIGN.json.gz'),zipped);
await writeFile(resolve(output,'RESULTS.md'),md);
await writeFile(resolve(output,'CHECKS.json'),JSON.stringify({at,status:'verified-interim-observations',campaignId:m.id,campaignStatus:m.status,attempts:m.attempts.length,planned:m.plan.length,sourceHash:m.source.sourceHash,manifestSha256:sha(bytes),compressedManifestSha256:sha(zipped),markdownSha256:sha(Buffer.from(md)),rendererSha256:sha(await readFile(import.meta.path)),scope:'Plan prefix, raw-result equality, result contracts, profiles and summary grouping. Not completed-campaign publication acceptance.',bindings},null,2)+'\n');
if (landingFlag) {
 assert.equal(resolve(output),resolve('results/reports/tuned-v017-current'));
 const previous=JSON.parse(await readFile('RESULTS.json','utf8'));
 assert.equal(previous.schema,'benchmark-interim-index-v1','Do not overwrite a final or historical index');
 const labels:Record<string,string>={syncular:'Syncular JS','syncular-rust':'Syncular Rust',powersync:'PowerSync',turso:'Turso'};
 const cols=[['local-query','list_query_p50_ms'],['local-query','aggregate_query_p50_ms'],['deep-relationship-query','dashboard_query_p50_ms'],['online-propagation','mirror_visible_p50_ms']];
 const section=['<!-- current-measurements -->','**[Actual current measurements: all 14 cases, trial counts and observed ranges](./results/reports/tuned-v017-current/RESULTS.md)** · [Raw current snapshot](./results/reports/tuned-v017-current/CAMPAIGN.json.gz)','',
  `Provisional snapshot of ${m.attempts.length} saved SQL attempts. Selected medians below are in **milliseconds**; per-case trial counts and observed ranges are in the linked report. Task screens use 100,000 tasks; collaboration uses 200 tasks and 50 measured writes.`, '',
  '| Client | List p50 | Aggregate p50 | Dashboard p50 | Reader visible p50 |','| --- | --- | --- | --- | --- |'];
 for(const stack of m.config.stacks){
  const values=cols.map(([scenario,metric])=>{const g=[...groups.values()].find(g=>g[0].stackId===stack&&g[0].scenarioId===scenario);const v=g?summarizeCase(g,metric).summary:null;return v?fmt(v.median):'—';});
  section.push('| '+[labels[stack]??stack,...values].join(' | ')+' |');
 }
 section.push('','These observations are not the final findings. Incomplete and failed cases remain visible in the linked tables; three attempts do not support confidence intervals. Zero’s replacement screen results are not included in this SQL snapshot.','<!-- /current-measurements -->');
 const outcomes:Record<string,number>={};for(const a of m.attempts)outcomes[a.result.status]=(outcomes[a.result.status]??0)+1;
 const unsuccessful=['failed','invalid','timed-out'].reduce((n,k)=>n+(outcomes[k]??0),0);
 let landing=await readFile('RESULTS.md','utf8');
 assert(landing.includes('<!-- current-measurements -->')&&landing.includes('<!-- /current-measurements -->'));
 landing=landing.replace(/<!-- current-measurements -->[\s\S]*?<!-- \/current-measurements -->/,()=>section.join('\n'));
 landing=landing.replace(/\*\*As of .*? unavailable\./,`**As of ${at.slice(0,16).replace('T',' ')} UTC: ${m.attempts.length}/174 replacement attempts recorded.** ${outcomes.completed??0} passed, ${unsuccessful} failed, invalid or timed out, and ${outcomes.unsupported??0} unavailable.`);
 await writeFile('RESULTS.md',landing);
 await writeFile('RESULTS.json',JSON.stringify({...previous,attempts:m.attempts.length,outcomes,manifestSha256:sha(bytes),capturedAt:at},null,2)+'\n');
}
console.log(JSON.stringify({output,attempts:m.attempts.length,observations:compact},null,2));
