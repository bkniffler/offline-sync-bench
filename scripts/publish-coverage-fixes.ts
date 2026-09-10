/** Review and package the six-case, single-run coverage campaign. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { hash } from '../src/contracts/screens.ts';
import { validateManifest, type Annotation } from '../src/campaign-report.ts';
import type { CampaignManifest } from '../src/campaign.ts';
const campaignPath=resolve(process.argv[2]!);
const m=JSON.parse(await readFile(campaignPath,'utf8')) as CampaignManifest;
validateManifest(m);
assert.deepEqual(m.config,JSON.parse(await readFile('campaigns/publication-coverage-fixes.json','utf8')));
assert.equal(m.attempts.length,6);
assert(m.attempts.every(a=>a.result.status==='completed'),'Review any failed outcome before changing publication annotations');
const assets=resolve('.tmp/coverage-fixes-assets');
await mkdir(join(assets,'docs'),{recursive:true});
await mkdir(join(assets,'evidence'),{recursive:true});
await mkdir(join(assets,'results/history/2026-09-05'),{recursive:true});
await writeFile(join(assets,'docs/methodology.md'),'# Methodology\n\nSix repaired client/case pairs, one predeclared independent run each (n=1), randomized and sequential on the recorded Apple M4 host with local services. No selective retries or development samples enter this campaign. Run-to-run variability is unknown. Query operations use five warmups and 25 samples; their p50 is an operation statistic, not 25 independent trials. Full records and output hashes are validated. Server volumes and OS caches remain warm. Exact runtime, dependencies, source, service configuration, preparation and timing boundaries are recorded in the [manifest](../RESULTS.json).\n\n[Results and explanations](../RESULTS.md)\n');
await writeFile(join(assets,'results/history/2026-09-05/README.md'),'# Earlier measurements\n\nEarlier campaigns are not pooled with this publication. The repository coverage index selects one source per client/case; replaced raw evidence remains in its original archive.\n');
const observations=[
 {id:'related-records',scenario:'deep-relationship-query',question:'What work produces the two relationship screens?',metrics:[['detail_join_query_p50_ms','Project detail'],['dashboard_query_p50_ms','Organization dashboard']],status:'unexplained',observation:'Electric and Jazz now both return the required project detail and organization totals for the complete 100,000-task fixture.',explanation:'Electric prepares application lookup and ordering indexes over native shapes. Jazz uses indexed native UUID references and nested includes for detail, then materializes native rows for JavaScript dashboard aggregation. These are different application execution paths; the individual costs have not been isolated. Query p50 metrics are rounded to 0.01 ms: a recorded zero means below 0.005 ms, and the raw operation samples retain higher precision.',implication:'The measured gap describes these implementations. One run does not establish a stable ratio or an inherent product limit.',nextExperiment:'Measure native query, row materialization and JavaScript aggregation separately with identical output checks.'},
 {id:'offline-reopen',scenario:'replica-reopen',question:'Can the complete replica reopen without a network?',metrics:[['reopen_first_screen_ms','First screen'],['reopen_all_rows_ms','All rows']],status:'confirmed',observation:'Electric and Zero reopen the complete 2,000-task replica and correct screen in a fresh process with both network routes blocked.',explanation:'Electric uses the application SQLite cache with lazy shape transport. Zero uses its public native SQLiteStore through a Bun platform delegate. Zero preparation waits two seconds for scheduled persistence before closing the client; that wait is outside the reopened-process timing. This is a clean-close read test, not a pending-write crash test.',implication:'Both paths support the tested offline reads. Application-owned and SDK-owned persistence are identified separately; n=1 leaves timing variability unknown.'},
 {id:'queued-crash-recovery',scenario:'offline-restart',question:'Do queued TanStack edits survive process death?',metrics:[['queue_1000_reopen_local_ms','Offline reopen'],['queue_1000_drain_ms','Queue completed'],['queue_1000_mirror_visible_ms','Reader visible']],status:'confirmed',observation:'All 1,000 TanStack edits survive SIGKILL and reach the independent reader after reconnecting.',explanation:'An application-provided SQLite StorageAdapter persists opaque native executor records using WAL and synchronous FULL. The SDK restores and replays original transaction identities and idempotency keys; validation checks queue identity, payloads and final receipts. The harness does not reconstruct transactions.',implication:'This establishes the tested durable executor configuration in one run, not durability of the previous memory-only setup or a variability estimate.'},
 {id:'rust-attachments',scenario:'blob-flow',question:'Does the Rust client complete the attachment workflow?',metrics:[['initial_upload_ms','Upload'],['fresh_download_ms','Fresh download'],['download_interruption_recovery_ms','Download retry']],status:'confirmed',observation:'The Rust client completes upload, metadata delivery, retained upload retry, fresh download and interrupted-download recovery with exact byte hashes.',explanation:'The server now buffers early WebSocket frames while asynchronous session setup completes. Regression tests verify ordering, close-before-ready and a bounded buffer. The previous timeout has no frame trace, so this passing run does not prove the cause of every historical failure.',implication:'The table now has validated attachment timings for this configuration. Download recovery retries the full object; n=1 leaves run-to-run variability unknown.'},
] as const;
m.annotations=[];
for(const o of observations){
 const attempts=m.attempts.filter(a=>a.scenarioId===o.scenario);
 const path=`evidence/${o.id}.json`;
 const implementationPaths:Record<string,string[]>={
  'related-records':['src/contracts/related-screen-index.ts','src/adapters/jazz-related-runner.ts','src/adapters/jazz-native.ts'],
  'offline-reopen':['src/recovery/electric-driver.ts','src/recovery/zero-sqlite-store.ts','src/recovery/reopen.ts'],
  'queued-crash-recovery':['src/recovery/sqlite-outbox.ts','src/recovery/tanstack-driver.ts','src/contracts/recovery-validation.ts'],
  'rust-attachments':['stacks/syncular/syncular-app/src/realtime-session.ts','src/realtime-session.test.ts']
 };
 const implementationFiles=Object.fromEntries(implementationPaths[o.id]!.map(path=>{const entry=(m.source.files as any)[path];assert(entry);return [path,entry];}));
 await writeFile(join(assets,path),JSON.stringify({scope:'Direct result accounting; implementation paths and bytes are retained in the source snapshot. Raw results retain complete validation evidence.',implementationFiles,sourceHash:m.source.sourceHash,results:attempts.map(a=>({stack:a.stackId,resultId:a.result.resultId,resultDigest:hash(a.result),status:a.result.status,metrics:a.result.metrics,contract:a.result.metadata.workloadContract})),explanation:o.explanation},null,2)+'\n');
 const annotation:Annotation={id:o.id,resultIds:attempts.map(a=>a.result.resultId),sourceHash:String(m.source.sourceHash),resultDigests:Object.fromEntries(attempts.map(a=>[a.result.resultId,hash(a.result)])),status:o.status,question:o.question,observation:o.observation,explanation:o.explanation,implication:o.implication,...('nextExperiment' in o?{nextExperiment:o.nextExperiment}:{}),table:{scenarioId:o.scenario,metrics:o.metrics.map(([key,label])=>({key,label}))},evidence:[{path,description:'Validated result identities, metrics and implementation accounting',kind:'direct-accounting'}]};
 m.annotations.push(annotation);
}
m.report={findingIds:observations.map(o=>o.id)};
await writeFile(campaignPath,JSON.stringify(m,null,2)+'\n');
const child=Bun.spawn(['bun','scripts/publish-results.ts','--campaign',campaignPath,'--assets',assets,'--output',resolve('results/reports/coverage-fixes')],{stdout:'inherit',stderr:'inherit'});
process.exitCode=await child.exited;
