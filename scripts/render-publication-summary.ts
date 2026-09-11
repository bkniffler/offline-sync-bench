import { renderLargeFiles } from './large-file-renderer.ts';
import { renderClientSize } from './client-size-renderer.ts';
import { nativeFeatureExclusions } from '../src/native-support.ts';
/** Assemble separately published campaigns; do not combine their samples.
 * Input paths are relative to the summary configuration. Output is Markdown.
 * bun scripts/render-publication-summary.ts SUMMARY.json OUTPUT.md
 */
import { renderPublicationCoverage } from './publication-coverage-renderer.ts';
import { publicationLinkMap, rebasePublishedLinks } from './publication-links.ts';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve, posix } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { validateManifest, validateAnnotations, renderCampaign, summarizeCase, groupAttempts, type Annotation } from '../src/campaign-report.ts';
import type { CampaignManifest, CampaignAttempt } from '../src/campaign.ts';
import { reportDetailsPath } from '../src/report-editorial.ts';
const [configPath, outputPath]=process.argv.slice(2);
assert(configPath&&outputPath,'Supply SUMMARY.json OUTPUT.md');
const config=JSON.parse(await readFile(configPath,'utf8'));
assert.equal(config.version,1);assert.equal(config.kind,'source-separated-publication-summary');
assert(Array.isArray(config.sources)&&[2,3,4,5].includes(config.sources.length));
assert(Array.isArray(config.findings)&&config.findings.length>=3&&config.findings.length<=5);
const expectedExclusions=nativeFeatureExclusions;
assert.deepEqual(config.exclusions,expectedExclusions,'Declare every read-only exclusion');
const excluded=(stack:string,scenario:string)=>config.exclusions.find((e:any)=>e.stack===stack&&e.scenario===scenario);
const base=dirname(resolve(configPath));
assert.equal(dirname(resolve(outputPath)),base,'Write the report beside its summary configuration');
const sha=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
const escape=(s:string)=>s.replaceAll('|','\\|').replaceAll('\n',' ');
type Source={manifest:CampaignManifest;annotations:Annotation[];root:string;label:string;links:Map<string,string>};
const sources=new Map<string,Source>();
for(const source of config.sources){
 assert(['tuned-sql','tuned-zero','powersync-maintained','coverage-fixes','native-files'].includes(source.id)&&!sources.has(source.id));
 assert(typeof source.label==='string'&&source.label.trim());
 assert(typeof source.root==='string'&&!source.root.startsWith('/')&&!source.root.includes('..'));
 const bytes=await readFile(resolve(base,source.manifest));const raw=source.manifest.endsWith('.gz')?gunzipSync(bytes):bytes;
 assert.equal(sha(raw),source.manifestSha256,'Stale manifest binding');
 const manifest=JSON.parse(raw.toString()) as CampaignManifest;validateManifest(manifest);
 assert.equal(manifest.config.trials,['coverage-fixes','native-files'].includes(source.id)?1:3,'Respect the declared collection size');
 if(source.id==='tuned-sql'){
  assert.deepEqual([...manifest.config.stacks].sort(),['powersync','syncular','syncular-rust','turso']);
  assert.equal(manifest.config.scenarios.length,14);
 }else if(source.id==='powersync-maintained'){
  assert.deepEqual(manifest.config.stacks,['powersync']);
  assert.equal(manifest.config.scenarios.length,14);
  for (const attempt of manifest.attempts.filter(a=>a.result.status==='completed')) {
   const preparations=attempt.result.metadata.fixturePreparation as any[];
   assert(preparations?.length && preparations.every(p=>p.status==='completed'&&p.policy==='replication-checkpoint-then-native-compaction-v1'));
  }
 }else if(['coverage-fixes','native-files'].includes(source.id)){
  assert.equal(manifest.config.replication,'single-run');
  assert.deepEqual(manifest.config,JSON.parse(await readFile(resolve(base,`campaigns/publication-${source.id}.json`),'utf8')));
 }else{
  assert.deepEqual(manifest.config.stacks,['zero']);
  assert.deepEqual([...manifest.config.scenarios].sort(),['deep-relationship-query','local-query']);
 }
 for(const a of manifest.attempts)if(a.stackId.startsWith('syncular')&&(a.result.status==='completed'||a.result.metadata.frameworkVersion!==undefined))assert.equal(a.result.metadata.frameworkVersion,'0.17.0');
 const archiveBytes=await readFile(resolve(base,source.root,'ARCHIVE.json'));
 assert.equal(sha(archiveBytes),source.archiveSha256,'Stale archive-index binding');
 const archive=JSON.parse(archiveBytes.toString());assert.equal(archive.campaignId,manifest.id);
 const links=publicationLinkMap(archive);
 const entry=archive.files.find((f:any)=>f.path==='RESULTS.json');assert(entry);
 assert.equal(entry.sha256,source.manifestSha256,'Manifest differs from packaged archive');
 assert.equal(resolve(base,source.manifest),resolve(base,source.root,entry.archive),'Use the packaged manifest');
 assert.equal(bytes.length,entry.compressedBytes);assert.equal(sha(bytes),entry.compressedSha256);
 assert(links.has(reportDetailsPath(manifest.id)),'Missing packaged companion report');
 sources.set(source.id,{manifest,annotations:validateAnnotations(manifest),root:source.root,label:source.label,links});
}
assert(sources.has('tuned-sql')&&sources.has('tuned-zero'));
assert.equal(resolve(base,config.coverage),resolve(base,'COVERAGE.json'),'Keep the coverage inventory beside the report');
const coverageBytes=await readFile(resolve(base,config.coverage));assert.equal(sha(coverageBytes),config.coverageSha256,'Stale coverage binding');
const coverage=JSON.parse(coverageBytes.toString());
for(const c of coverage.cases)assert.deepEqual(c.exclusion,excluded(c.stack,c.scenario));assert.equal(coverage.status,'replacement-collection-complete');
assert.equal(coverage.currentAttempts,coverage.cases.filter((c:any)=>!c.historical).reduce((n:number,c:any)=>n+c.attempts.length,0));assert.equal(coverage.cases.length,112);
for(const [id,source] of sources){
 const record=coverage.sources.find((s:any)=>s.id===id);assert(record);
 assert.equal(record.campaignId,source.manifest.id);assert.equal(record.sourceHash,source.manifest.source.sourceHash);
 // Packaged manifests relocate result paths and can add reviewed annotations.
 // Bind the actual trial identities/outcomes, not the pre-packaging file hash.
 const cells=coverage.cases.filter((c:any)=>c.source===id);
 const expected=source.manifest.attempts.filter(a=>coverage.cases.some((c:any)=>c.stack===a.stackId&&c.scenario===a.scenarioId&&c.source===id)).map(a=>[a.stackId,a.scenarioId,a.trial,a.result.resultId,a.result.status,sha(Buffer.from(JSON.stringify(a.result,null,2)+'\n'))].join('|')).sort();
 const observed=cells.flatMap((c:any)=>c.attempts.map((a:any)=>[c.stack,c.scenario,a.trial,a.resultId,a.outcome,a.sha256].join('|'))).sort();
 assert.deepEqual(observed,expected,'Coverage differs from published attempts');
}
const coverageMd=await readFile(resolve(base,config.coverageMarkdown),'utf8');
assert.equal(sha(Buffer.from(coverageMd)),config.coverageMarkdownSha256,'Stale coverage Markdown');
assert.equal(coverageMd,renderPublicationCoverage(coverage),'Coverage Markdown differs from its recorded outcomes');
const selected:Array<{source:Source;annotation:Annotation}>=[];
const seen=new Set<string>();
for(const ref of config.findings){
 const identity=`${ref.source}/${ref.annotation}`;assert(!seen.has(identity));seen.add(identity);
 const source=sources.get(ref.source);assert(source,'Unknown finding source');
 const annotation=source.annotations.find(a=>a.id===ref.annotation);assert(annotation,'Unknown finding');
 assert(source.manifest.report?.findingIds.includes(annotation.id),'Finding was not selected in its reviewed campaign');
 selected.push({source,annotation});
}
const lead=selected[0].annotation;
if (config.presentation === 'readme-benchmarks-v1') {
 const sql=sources.get('tuned-sql')!,zero=sources.get('tuned-zero')!;
 const powerSync=sources.get('powersync-maintained'), fixes=sources.get('coverage-fixes'), nativeFiles=sources.get('native-files');
 const replacementSource=(stack:string,scenario:string)=>{const id=coverage.cases.find((c:any)=>c.stack===stack&&c.scenario===scenario)?.source;return ['coverage-fixes','native-files'].includes(id)?sources.get(id):undefined;};
 const fixedCase=(stack:string,scenario:string)=>Boolean(replacementSource(stack,scenario));
 const labels:Record<string,string>={syncular:'Syncular JS','syncular-rust':'Syncular Rust',powersync:'PowerSync',turso:'Turso',zero:'Zero'};
 const details=(s:Source,anchor:string)=>posix.join(s.root,reportDetailsPath(s.manifest.id))+'#'+anchor;
 type Section={id:string;title:string;description:string;columns:Array<[string,string]>;anchor:string;definition:string;caveat?:string;zero?:boolean;conflict?:boolean};
 const sections:Section[]=[
  {id:'local-query',title:'Local task queries',description:'Filter a task list, search titles and count tasks by group across 100,000 already-loaded tasks. Each run measures 25 operations after five warmups.',columns:[['Task list','list_query_p50_ms'],['Prefix search','search_query_p50_ms'],['Grouped counts','aggregate_query_p50_ms']],anchor:'task-screens',definition:'local-screens',zero:true,caveat:'A controlled test confirmed that matching SQL indexes remove an avoidable sort. Syncular uses in-memory SQL here; PowerSync and Turso use file-backed stores. Sub-millisecond gaps are small in practice. [Index investigation](./docs/investigations/screen-index-effect.md).'},
  {id:'deep-relationship-query',title:'Queries across related records',description:'Query 100,000 tasks across four projects. **Project detail** returns the first 100 tasks in one project, with each task’s title, project name and organization name. **Organization dashboard** summarizes all four projects with total, completed and open task counts, ordered by most open tasks.',columns:[['Project detail','detail_join_query_p50_ms'],['Organization dashboard','dashboard_query_p50_ms']],anchor:'relationship-screens',definition:'local-screens',zero:true,caveat:'Storage matches the local-query case. Zero uses native relationships with JavaScript aggregation; their separate costs have not been measured.'},
  {id:'bootstrap',title:'Starting with an empty client',description:'Download data into a fresh client. These results use 100,000 tasks and warm services; details also cover 1,000/10,000 tasks and restarted services.',columns:[['First correct screen','startup_warm_100000_first_screen_ms'],['Complete local dataset','startup_warm_100000_full_data_ms']],anchor:'initial-startup-100000-tasks',definition:'startup',caveat:'PowerSync timed out at the initial 1,000-task stage and never reached this size. Screen and complete-dataset milestones are observed independently. Server storage and OS caches are retained.'},
  {id:'replica-reopen',title:'Reopening an offline replica',description:'Open an existing 2,000-task store in a new process with the network blocked. Measure when the first screen and all expected rows become available.',columns:[['First correct screen','reopen_first_screen_ms'],['All rows available','reopen_all_rows_ms']],anchor:'persisted-replica-startup',definition:'startup',caveat:'PowerSync timed out during setup. The OS file cache remains warm.'},
  {id:'online-propagation',title:'Sharing an edit',description:'Make 50 title edits with 200 tasks loaded on independent writer and reader clients. Measure local commit, observed server acceptance and visibility on the reader.',columns:[['Local commit','local_commit_p50_ms'],['Server accepted','server_accepted_p50_ms'],['Reader visible','mirror_visible_p50_ms']],anchor:'collaboration',definition:'collaboration',caveat:'These milestones overlap; local commit does not prove crash durability. PowerSync’s default 1,000 ms upload throttle may contribute to its delay, but that cause remains unproven. [Investigation](./docs/investigations/powersync-collaboration.md).'},
  {id:'offline-replay',title:'Syncing edits after an outage',description:'Queue ten writes against 2,000 tasks during a 20-second writer outage. Time queue completion and correct reader data after connectivity returns.',columns:[['Queue completed','queue_10_drain_ms'],['Reader visible','queue_10_mirror_visible_ms']],anchor:'offline-replay',definition:'offline-recovery',caveat:'PowerSync failed initial readiness before the outage. Queue completion and reader visibility have independent observers.'},
  {id:'large-offline-queue',title:'Syncing a larger offline queue',description:'Repeat recovery with 100, 500 and 1,000 queued writes. Each column measures time from reconnection until the reader has the correct data.',columns:[['100 writes','queue_100_mirror_visible_ms'],['500 writes','queue_500_mirror_visible_ms'],['1,000 writes','queue_1000_mirror_visible_ms']],anchor:'replay-scaling',definition:'offline-recovery',caveat:'PowerSync failed setup. The cause of the large Turso/Syncular gap remains unmeasured.'},
  {id:'offline-restart',title:'Recovering queued edits after a crash',description:'Queue 1,000 writes, kill the writer process, reopen the same store offline, then reconnect. Verify every pending edit survives and reaches the reader.',columns:[['Reopen offline','queue_1000_reopen_local_ms'],['Queue completed','queue_1000_drain_ms'],['Reader visible','queue_1000_mirror_visible_ms']],anchor:'offline-process-recovery',definition:'offline-recovery',caveat:'PowerSync failed setup before the crash test. Reopen time starts at process launch; recovery times start at network restoration.'},
  {id:'conflict-update-update',title:'Two clients editing the same task',description:'A queues an offline edit; B edits the same task online. Reconnect A and verify all three clients agree with the configured conflict policy.',columns:[['All clients agree','all_clients_converged_ms']],anchor:'conflicting-edits',definition:'conflicting-edits',conflict:true,caveat:'The timings describe different conflict policies. Syncular rejects stale versions; Turso replays A’s title update. PowerSync failed setup.'},
  {id:'conflict-update-delete',title:'An offline edit racing with deletion',description:'A queues an offline edit; B deletes that task online. Reconnect A and check that the deleted task stays deleted on all three clients.',columns:[['All clients agree','all_clients_converged_ms']],anchor:'conflicting-edits',definition:'conflicting-edits',conflict:true,caveat:'Syncular rejects the stale write; Turso’s SQL UPDATE leaves the missing row deleted. This tests one ordered race, not every conflict interleaving. PowerSync failed setup.'},
  {id:'connected-fanout',title:'Sending one edit to many clients',description:'With 2,000 tasks on each reader, measure one live edit reaching every connected client. The columns show time until the slowest reader is correct.',columns:[['5 readers','clients_5_all_converged_ms'],['25 readers','clients_25_all_converged_ms']],anchor:'connected-client-fanout',definition:'connected-clients-and-reconnecting-clients',caveat:'PowerSync failed setup before reader creation.'},
  {id:'reconnect-storm',title:'Many clients reconnecting together',description:'Disconnect five or 25 readers, accumulate 100 updates, then restore their connections together. Measure time until every reader has the complete correct dataset.',columns:[['5 readers','clients_5_all_converged_ms'],['25 readers','clients_25_all_converged_ms']],anchor:'reconnect-with-backlog',definition:'connected-clients-and-reconnecting-clients',caveat:'PowerSync failed setup. Retained storage and the maintenance pause affect the environment.'},
  {id:'permission-change',title:'Removing access to a project',description:'Revoke access to one of two 500-task projects. Measure removal of unauthorized rows while preserving the allowed project, both online and after reconnecting.',columns:[['Online removal','online_convergence_ms'],['Removal after reconnect','offline_reconnect_convergence_ms']],anchor:'access-revocation-native-purge',definition:'access-revocation',caveat:'Syncular uses explicit synchronization; PowerSync uses continuous synchronization. Local removal cannot erase previously copied data.'},
  {id:'blob-flow',title:'Uploading and downloading attachments',description:'Transfer two 2 MiB objects linked to tasks. Measure upload, an uncached download and recovery after an interrupted download; verify the complete object hashes.',columns:[['Upload','initial_upload_ms'],['Fresh download','fresh_download_ms'],['Download retry','download_interruption_recovery_ms']],anchor:'attachments',definition:'attachments',caveat:'Syncular and PowerSync retry object-store downloads; Jazz reads native synced chunks. The footnotes explain the different upload and retry boundaries.'},
 ];
 if (powerSync) {
  const revised:Record<string,string>={
   bootstrap:'Screen and complete-dataset milestones are observed independently. Server storage and OS caches are retained. PowerSync compacts fixture history before timing; the earlier setup failures came from missing maintenance in this harness. [Explanation](./docs/investigations/tuned-publication-failures.md).',
   'replica-reopen':'The OS file cache remains warm.',
   'offline-replay':'Queue completion and reader visibility have independent observers.',
   'large-offline-queue':'The cause of the large Turso/Syncular gap remains unmeasured.',
   'offline-restart':'Reopen time starts at process launch; recovery times start at network restoration.',
   'conflict-update-update':'The timings describe different conflict policies. Syncular rejects stale versions; PowerSync and Turso replay A’s title update.',
   'conflict-update-delete':'Syncular rejects the stale write; PowerSync and Turso’s SQL UPDATE leaves the missing row deleted. This tests one ordered race, not every conflict interleaving.',
   'connected-fanout':'PowerSync’s observed ranges overlap at five and 25 readers; the lower 25-reader median does not establish a speedup.',
   'reconnect-storm':'Retained storage and the maintenance pause affect the environment.'
  };
  for (const section of sections) if (revised[section.id]) {
   section.caveat=revised[section.id];
   const latest=powerSync.manifest.attempts.filter(a=>a.scenarioId===section.id).sort((a,b)=>a.trial-b.trial).at(-1)!;
   if (latest.result.status!=='completed') section.caveat+=' PowerSync’s latest attempt failed; its details retain the evidence.';
  }
 }
 assert.deepEqual(sections.map(s=>s.id).sort(),[...sql.manifest.config.scenarios].sort());
 for(const source of [sql,zero])for(const scenario of ['local-query','deep-relationship-query']) {
  const keys=new Set(source.manifest.attempts.filter(a=>a.scenarioId===scenario).map(a=>JSON.stringify((a.result.metadata.profile as any).comparisonKey)));
  assert.equal(keys.size,1,'Incompatible screen profiles');
 }
 const groups=new Map([...sources.values()].map(s=>[s,groupAttempts(s.manifest.attempts)]));
 const attemptsFor=(s:Source,stack:string,scenario:string)=>{
  const found=[...groups.get(s)!.values()].filter(g=>g[0]!.stackId===stack&&g[0]!.scenarioId===scenario);
  assert.equal(found.length,1,'Expected one compatible profile per client/case');return found[0]!;
 };
 const reviewBytes=await readFile(resolve(base,config.coverageReview));
 assert.equal(sha(reviewBytes),config.coverageReviewSha256,'Stale missing-coverage review');
 const coverageReview=JSON.parse(reviewBytes.toString());
 assert.equal(coverageReview.coverageSha256,config.coverageSha256);
 const gapReviews=new Map<string,any>(coverageReview.cases.map((c:any)=>[`${c.stack}/${c.scenario}`,c]));
 // A scenario-wide failure does not mean every displayed subcase timed out.
 const missingCell=(attempts:CampaignAttempt[],status:string,metric:string)=>{
  const latest=attempts.at(-1)!.result;
  const evidence=latest.metadata.evidence as any;
  if(status==='timed-out'){
   if(latest.scenarioId==='bootstrap'&&metric.startsWith('startup_warm_100000_')&&evidence?.stage==='process-cold-100000')return 'Not reached';
   if(latest.scenarioId==='blob-flow'&&evidence?.cases?.length===0&&!evidence.initial)return 'Setup timed out';
   if(latest.scenarioId==='conflict-update-delete'&&evidence?.stage==='resolution'&&evidence.failureSnapshots?.length===3)return 'Did not converge';
   if(latest.scenarioId==='permission-change'&&(latest.metadata.cases as any[])?.every(c=>c.purgeFailure?.reason==='Error: Jazz native access purge timed out'))return 'Purge timed out';
   return 'Timed out';
  }
  if(status==='unsupported'||status==='not-measured'){
   const review=gapReviews.get(`${latest.stackId}/${latest.scenarioId}`);
   assert(review&&(!review.metric||review.metric===metric),'Review every missing result before publication');
   return review.label;
  }
  return status==='invalid'||status==='failed'?'Failed':'—';
 };
 const cell=(s:Source,stack:string,scenario:string,metric:string)=>{
  if(excluded(stack,scenario))return 'Not supported';
  const result=summarizeCase(attemptsFor(s,stack,scenario),metric);
  if(!result.summary)return missingCell(attemptsFor(s,stack,scenario),result.status,metric);
  assert.equal(result.summary.trials,s.manifest.config.trials-result.failures,'Disclose every independent run');
  const n=result.summary.median;
  const roundedBelowResolution=n===0&&metric.endsWith('_query_p50_ms');
  if(roundedBelowResolution)for(const a of attemptsFor(s,stack,scenario)){const samples=(a.result.metadata.samples as any)?.[metric.replace('_query_p50_ms','')];assert(samples?.length&&samples.every((v:number)=>v>=0));assert([...samples].sort((a:number,b:number)=>a-b)[Math.ceil(samples.length/2)-1]<0.005);}
  return (roundedBelowResolution?'<0.005':n<1?n.toFixed(3):n.toFixed(2))+' ms'+(result.failures||s.manifest.config.trials===1?' *':'');
 };
 // Read only the retained cases from the immutable archive; never revive replaced SQL/Zero screens.
 const historicalSource=coverage.sources.find((s:any)=>s.id==='retained-history');assert(historicalSource);
 assert.equal(sha(await readFile(resolve(base,historicalSource.path))),historicalSource.sha256);
 assert.equal(sha(await readFile(resolve(base,historicalSource.archive))),historicalSource.archiveSha256);
 const rawHistory:Record<string,string>=JSON.parse(execFileSync('python3',['-c',`
import json,sys,tarfile,gzip,base64
from pathlib import Path
base=Path(sys.argv[1]); coverage=json.loads((base/'COVERAGE.json').read_text())
source=next(s for s in coverage['sources'] if s['id']=='retained-history')
with tarfile.open(base/source['archive']) as archive:
 print(json.dumps({a['archiveMember']:base64.b64encode(gzip.compress(archive.extractfile(a['archiveMember']).read())).decode() for c in coverage['cases'] if c['source']=='retained-history' for a in c['attempts']}))
 `,base],{encoding:'utf8',maxBuffer:64*1024*1024}));
 const historyAttempts:CampaignAttempt[]=[];
 for(const c of coverage.cases.filter((c:any)=>c.source==='retained-history'))for(const a of c.attempts){
  const encoded=rawHistory[a.archiveMember];assert(encoded);
  const raw=gunzipSync(Buffer.from(encoded,'base64')).toString();assert.equal(sha(Buffer.from(raw)),a.sha256);
  const result=JSON.parse(raw);assert.equal(result.resultId,a.resultId);assert.equal(result.status,a.outcome);
  assert.equal(result.stackId,c.stack);assert.equal(result.scenarioId,c.scenario);
  assert.equal(result.metadata.profile.sourceHash,historicalSource.sourceHash);
  historyAttempts.push({stackId:c.stack,scenarioId:c.scenario,trial:a.trial,resultFile:a.archiveMember,result});
 }
 assert.equal(historyAttempts.length,coverage.retainedAttempts);
 const historyGroups=groupAttempts(historyAttempts);
 const historyLabels:Record<string,string>={electric:'Electric','electric-tanstack':'Electric + TanStack DB','jazz-v2':'Jazz v2 (experimental)',zero:'Zero'};
 const historyDetailsPath='results/history/2026-09-07-withdrawn-campaign/RETAINED-RESULTS.md';
 const formatMs=(n:number)=>(n<1?n.toFixed(3):n.toFixed(2))+' ms';
 const historyCell=(attempts:CampaignAttempt[],metric:string,range=false)=>{
  if(excluded(attempts[0]!.stackId,attempts[0]!.scenarioId))return 'Not supported';
  const result=summarizeCase(attempts,metric);
  if(!result.summary)return missingCell(attempts,result.status,metric);
  const value=formatMs(result.summary.median)+(result.failures?' *':'');
  if(!range)return value;
  const values=attempts.filter(a=>a.result.status==='completed').map(a=>a.result.metrics[metric] as number);
  return `${value} (${formatMs(Math.min(...values))}–${formatMs(Math.max(...values))}; n=${values.length})`;
 };
 const clientIds=Object.fromEntries(Object.entries({...labels,...historyLabels}).map(([id,label])=>[label,id]));
 const earlierFailureNotes:Record<string,string>={
  'replica-reopen':'One earlier attempt lost its connection during initial sync; these medians use the two successful runs. The cause remains unknown.',
  'connected-fanout':'One earlier attempt ran out of disk space during 25-reader setup; these medians use the two successful runs.',
  'reconnect-storm':'One earlier attempt ran out of disk space during 25-reader setup; these medians use the two successful runs.'
 };
 const singleRunNotes:Record<string,string>={
  'electric/deep-relationship-query':'One run (n=1); run-to-run variability is unknown. Electric uses application lookup/order indexes over native shapes; dashboard counts are computed per query. “<0.005 ms” is below the saved p50’s 0.01 ms rounding precision; raw operation samples remain available.',
  'jazz-v2/deep-relationship-query':'One run (n=1); run-to-run variability is unknown. Jazz uses native relationship includes for detail and materializes rows for JavaScript dashboard aggregation. Their separate costs are not isolated.',
  'electric/replica-reopen':'One run (n=1); run-to-run variability is unknown. Electric reopens an application-owned SQLite cache.',
  'zero/replica-reopen':'One run (n=1); run-to-run variability is unknown. Zero reopens its native SQLite store. A two-second preparation wait lets scheduled persistence finish before close; it is outside the timing.',
  'electric-tanstack/offline-restart':'One run (n=1); run-to-run variability is unknown. The native executor restores all 1,000 transactions from an application-supplied SQLite storage adapter.',
  'powersync/blob-flow':'One run (n=1). Uses PowerSync’s experimental native attachment queue and streaming transport with MinIO. Upload excludes file staging; download retry follows an HTTP cut after 64 KiB.',
  'jazz-v2/blob-flow':'One run (n=1). Uses Jazz’s native 256 KiB file chunks. Upload includes chunk creation and edge persistence; retry follows a disconnect after the first chunk and reuses the native cache. These boundaries differ from the object-store clients.',
  'syncular-rust/blob-flow':'One run (n=1); run-to-run variability is unknown. Early WebSocket frames are now buffered while the server session opens; upload and interrupted-download checks pass.'
 };
 const annotateRows=(scenario:string,rows:string[])=>{
  const notes:string[]=[];
  const annotated=rows.map(row=>{
   const cells=row.split('|');const label=cells[1]!.trim();
   for(let i=2;i<cells.length-1;i++){
    const value=cells[i]!.trim();
    if(!/^(Not supported|Unavailable|Unsupported|Not implemented|Needs persistent test|No equivalent|Not applicable|Timed out|Setup timed out|Purge timed out|Did not converge|Not reached|Setup failed|Failed|Not established|Not measured|—)$/.test(value)&&!value.includes(' ms *'))continue;
    const review=gapReviews.get(`${clientIds[label]}/${scenario}`);
    const reason=excluded(clientIds[label]!,scenario)?.reason??(value.includes(' ms *')?(fixedCase(clientIds[label]!,scenario)?singleRunNotes[`${clientIds[label]}/${scenario}`]:earlierFailureNotes[scenario]):review?.reason);
    assert(reason,`Add a short result footnote for ${scenario}/${label}: ${value}`);
    if(!notes.includes(reason))notes.push(reason);
    const marker='\\*'.repeat(notes.indexOf(reason)+1);
    cells[i]=' '+value.replace(' ms *',' ms')+' '+marker+' ';
   }
   return cells.join('|');
  });
  return {rows:annotated,notes:notes.flatMap((reason,i)=>['\\*'.repeat(i+1)+' '+reason,''])};
 };
 const historicalCaveats:Record<string,string>={
  'local-query':'Electric filters/sorts arrays; TanStack uses indexed native queries; Jazz combines indexed search with JavaScript grouping.',
  'bootstrap':'Electric and Zero load memory caches, so their “Complete local dataset” does not establish a persistent offline copy.',

  'conflict-update-update':'TanStack and Zero apply A’s arriving title update; Jazz retains B’s later-written field.',
  'permission-change':'Electric and TanStack rebuild the application cache; Zero invalidates its native memory cache. These provide different guarantees from persistent native purge.'
 };
 const historicalLines=['# Retained September 7 results','','Generated from the unchanged cases in the stopped, withdrawn September 7 campaign. These are historical estimates, not a newly completed campaign. Each cell shows its own successful-trial median, observed range and sample size; a failed latest trial has no timing. No samples are pooled with September 9.','','[Archive and restoration](./README.md) · [Raw campaign archive](./campaign.tar.gz) · [Selected trial identities and hashes](../../diagnostics/publication-index-review/RETAINED-HISTORY.json) · [Current README](../../../README.md)','','Source hash: `'+historicalSource.sourceHash+'`. Jazz uses the experimental runtime. Exact profiles, configurations, operation samples and logs remain in the archive. Plain Electric write workflows are excluded from current tables; their archived custom-outbox results are not product write benchmarks.',''];
 const lines=['# offline-sync-bench','',
  'Compare offline-first sync stacks using the same task app. The suite measures local queries, startup, edit delivery, offline recovery, conflicts, client scaling, access changes and attachments, and checks the returned data for correctness.','',
  'Includes Syncular JS/Rust, PowerSync, Turso, Zero, Electric, Electric + TanStack DB and experimental Jazz. Results describe each tested application and its guarantees.','',
  '## Latest results','',
  '**Latest available measurements · Apple M4 · local services · Syncular JS/Rust 0.18.0 for the 500 MB file test; 0.17.0 for other results.** Latency is shown in **milliseconds; lower is faster**. Browser client sizes use **KiB**. Latency values are medians; query/edit timings summarize each run’s p50. Starred entries are explained below each table. “Not supported” means the library lacks the native feature required by that test. Benchmark implementation gaps are work to fix, not product limitations.','',
  'Collection dates, configurations, sample sizes and ranges are in the linked details. [Methods](./docs/methodology.md) · [Missing-case review](./docs/investigations/missing-coverage.md) · [Failure explanations](./docs/investigations/tuned-publication-failures.md)',''];
 const clientOrder=['Syncular JS','Syncular Rust','PowerSync','Turso','Zero','Electric','Electric + TanStack DB','Jazz v2 (experimental)'];
 for(const section of sections){
  const tableRows:string[]=[];
  lines.push(`### ${section.title}`,'',section.description,'',`| Client | ${section.conflict?'Verified outcome | ':''}${section.columns.map(c=>c[0]).join(' | ')} |`,`| --- | ${section.conflict?'--- | ':''}${section.columns.map(()=>'---:').join(' | ')} |`);
  for(const originalSource of section.zero?[sql,zero]:[sql])for(const stack of originalSource.manifest.config.stacks){
   const source=fixedCase(stack,section.id)?replacementSource(stack,section.id)!:stack==='powersync'&&powerSync?powerSync:originalSource;
   let outcome='';
   if(section.conflict){
    const attempts=attemptsFor(source,stack,section.id);
    const policy=attempts.at(-1)!.result.metadata.policy as {outcome?:string}|undefined;
    const outcomes:Record<string,string>={'reject-stale-update':'B’s edit retained','last-arriving-patch':'A’s replayed edit retained','delete-retained':'Deletion retained'};
    if(attempts.at(-1)!.result.status==='completed')assert(policy?.outcome&&outcomes[policy.outcome],'Unknown verified conflict outcome');
    outcome=(policy?.outcome?outcomes[policy.outcome]:'Not measured')+' | ';
   }
   tableRows.push(`| ${labels[stack]} | ${outcome}${section.columns.map(([,metric])=>cell(source,stack,section.id,metric)).join(' | ')} |`);
  }
  const historicalStacks=['electric','electric-tanstack','jazz-v2',...(section.zero?[]:['zero'])];
  historicalLines.push(`## ${section.id}`,'',section.description,'',`| Client | ${section.conflict?'Verified outcome | ':''}${section.columns.map(c=>c[0]).join(' | ')} |`,`| --- | ${section.conflict?'--- | ':''}${section.columns.map(()=>'---:').join(' | ')} |`);
  const historicalTableStart=historicalLines.length;
  for(const stack of historicalStacks){
   if(fixedCase(stack,section.id)){tableRows.push(`| ${historyLabels[stack]} | ${section.columns.map(([,metric])=>cell(replacementSource(stack,section.id)!,stack,section.id,metric)).join(' | ')} |`);continue;}
   const attempts=historyGroups.get(`${stack}/${section.id}`);assert(attempts);
   const latest=attempts.at(-1)!.result;
   let outcome='';
   if(section.conflict){
    const policy=latest.metadata.policy as {outcome?:string}|undefined;
    const outcomes:Record<string,string>={'last-arriving-patch':'A’s replayed edit retained','last-written-field':'B’s edit retained','delete-retained':'Deletion retained'};
    if(latest.status==='completed')assert(policy?.outcome&&outcomes[policy.outcome]);
    outcome=(excluded(stack,section.id)?'Not supported':latest.status==='completed'?outcomes[policy!.outcome!]:'Not established')+' | ';
   }
   tableRows.push(`| ${historyLabels[stack]} | ${outcome}${section.columns.map(([,metric])=>historyCell(attempts,metric)).join(' | ')} |`);
   historicalLines.push(`| ${historyLabels[stack]} | ${outcome}${section.columns.map(([,metric])=>historyCell(attempts,metric,true)).join(' | ')} |`);
  }
  const historicalTable=annotateRows(section.id,historicalLines.splice(historicalTableStart));
  historicalLines.push(...historicalTable.rows,'',...historicalTable.notes,historicalCaveats[section.id]??'','');
  for(const stack of historicalStacks){
   if(fixedCase(stack,section.id))continue;
   const attempts=historyGroups.get(`${stack}/${section.id}`)!;
   const profile=attempts.at(-1)!.result.metadata.profile as any;
   historicalLines.push(`- **${historyLabels[stack]}**: ${escape(String(profile.storage??'undeclared storage'))}; ${escape(String(profile.execution??'undeclared execution'))}. Outcomes: ${attempts.map(a=>`trial ${a.trial}: ${a.result.status}`).join(', ')}.`);
  }
  historicalLines.push('');
  tableRows.sort((a,b)=>clientOrder.indexOf(a.split('|')[1]!.trim())-clientOrder.indexOf(b.split('|')[1]!.trim()));
  assert.deepEqual(tableRows.map(row=>row.split('|')[1]!.trim()),clientOrder);
  const table=annotateRows(section.id,tableRows);
  lines.push(...table.rows,'',...table.notes);
  if(nativeFiles&&section.id==='blob-flow'){
   lines.push(section.caveat!, '', `[Workload details](./docs/benchmarks.md#attachments) · [Syncular JS details](${details(sql,section.anchor)}) · [Syncular Rust details](${details(fixes!,section.anchor)}) · [PowerSync and Jazz details](${details(nativeFiles,section.anchor)})`, '');
   continue;
  }
  lines.push([section.caveat,historicalCaveats[section.id]].filter(Boolean).join(' '), '',`[Workload details](./docs/benchmarks.md#${section.definition}) · [${powerSync?'Syncular/Turso':'SQL'} details](${details(sql,section.anchor)})${powerSync?` · [PowerSync details](${details(powerSync,section.anchor)})`:''}${section.zero?` · [Zero details](${details(zero,section.anchor)})`:''} · [Other client details](${historyDetailsPath}#${section.id})${fixes&&fixes.manifest.config.scenarios.includes(section.id as any)?` · [Repaired case details](${details(fixes,section.anchor)})`:''}${nativeFiles&&section.id==='blob-flow'?` · [Native attachment details](${details(nativeFiles,section.anchor)})`:''}`,'');
 }
 if(config.largeFiles)lines.push(...await renderLargeFiles(config.largeFiles,base));
 if(config.clientSize)lines.push(...await renderClientSize(config.clientSize,base));
 lines.push('## Run a benchmark','','Install Bun and start Docker, then:','','```sh','bun install --frozen-lockfile','bun run bench:run -- --stack syncular --scenario local-query','```','','The harness resets the selected stack’s benchmark fixtures. [Running campaigns and publishing results](./docs/reporting.md) · [Benchmark definitions](./docs/benchmarks.md)','');
 await writeFile(resolve(base,historyDetailsPath),historicalLines.join('\n'));
 await writeFile(outputPath,lines.join('\n'));
 console.log('Rendered README benchmark tables from validated result packages.');
} else
if (config.presentation === 'essential-v1' || config.presentation === 'readme-v1') {
 const sql=sources.get('tuned-sql')!,zero=sources.get('tuned-zero')!;
 const details=(s:Source)=>posix.join(s.root,reportDetailsPath(s.manifest.id));
 const labels:Record<string,string>={syncular:'Syncular JS','syncular-rust':'Syncular Rust',powersync:'PowerSync',turso:'Turso',zero:'Zero'};
 const rows=(s:Source,columns:Array<[string,string]>)=>s.manifest.config.stacks.map(stack=>{
  const values=columns.map(([scenario,metric])=>{
   const attempts=s.manifest.attempts.filter(a=>a.stackId===stack&&a.scenarioId===scenario);
   const result=summarizeCase(attempts,metric);
   if(!result.summary)return '—';
   assert.equal(result.summary.trials,3,'Headline cells require all three successful trials');
   const n=result.summary.median;return n<1?n.toFixed(3):n.toFixed(2);
  });
  return `| ${labels[stack]} | ${values.join(' | ')} |`;
 });
 const screens:Array<[string,string]>=[['local-query','list_query_p50_ms'],['local-query','aggregate_query_p50_ms'],['deep-relationship-query','dashboard_query_p50_ms']];
 // Different campaign configurations retain distinct comparison groups.
 for(const source of [sql,zero])for(const scenario of ['local-query','deep-relationship-query']) {
  const keys=new Set(source.manifest.attempts.filter(a=>a.scenarioId===scenario).map(a=>JSON.stringify((a.result.metadata.profile as any).comparisonKey)));
  assert.equal(keys.size,1,'Do not put incompatible screen profiles in one table');
 }
 const zeroValues=rows(zero,screens)[0]!.split('|').slice(2,5).map(s=>s.trim());
 if(config.presentation==='readme-v1'){
  const columns:Array<[string,string]>=[...screens,['online-propagation','mirror_visible_p50_ms'],['bootstrap','startup_warm_100000_first_screen_ms'],['bootstrap','startup_warm_100000_full_data_ms']];
  const comparison=rows(sql,columns);
  // Show the separately collected configuration explicitly, without pooling trials.
  comparison.push(`| Zero † | ${zeroValues.join(' | ')} | — | — | — |`);
  const page=['# offline-sync-bench','',
   'How quickly can an offline task app query data, share edits and become usable? We run the same workloads and check the returned data.','',
   '## Latest results','',
   '**Milliseconds, lower is faster.** September 9, 2026 · Apple M4 · local services · Syncular JS/Rust 0.17.0. Values are medians across three runs; query and edit timings summarize each run’s p50.','',
   '| Client | Task list | Grouped counts | Dashboard | Edit visible on another client | First screen | Full offline copy |',
   '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',...comparison,'',
   'Queries use 100,000 already-loaded tasks. Edits use 200 tasks and 50 writes. Startup loads 100,000 tasks into a fresh client from warm services.','',
   '- SQL indexes match the queries. Syncular uses in-memory SQL for queries/edits; PowerSync and Turso use file-backed stores. All SQL clients use persistent stores for startup. Differences below 1 ms are small in practice.',
   '- † Zero’s screens were collected separately, using native queries plus JavaScript aggregation. Its edit/startup cases were not rerun. These numbers describe each application implementation, not an isolated query engine.',
   '- PowerSync timed out during initial startup; its dashes are missing measurements, not zero. Its default upload throttle may explain some edit delay, but that cause is unproven.',
   '- Startup milestones are observed independently. Retained server data, warm caches and recorded interruptions affect results. Three runs provide limited evidence about variability.','',
   '[Full SQL results and ranges]('+details(sql)+') · [Zero details]('+details(zero)+') · [Failures and caveats](./docs/investigations/tuned-publication-failures.md)','',
   'The full suite also covers offline queues, crash recovery, conflicting edits, reconnecting clients, access revocation and attachments. Electric, Electric + TanStack DB and experimental Jazz retain [historical results and coverage](./COVERAGE.md); they are not part of this fresh comparison.','',
   '## Run a benchmark','',
   'Install Bun and start Docker, then:','',
   '```sh','bun install --frozen-lockfile','bun run bench:run -- --stack syncular --scenario local-query','```','',
   'The harness resets the selected stack’s benchmark fixtures. [Methods](./docs/methodology.md) · [Campaigns and publishing](./docs/reporting.md)',''];
  await writeFile(outputPath,page.join('\n'));
  console.log('Rendered README with one latest-results table from validated source campaigns.');
 }else{
 const lines=['# Benchmark results','',
 'We test a task app: opening local screens, syncing edits to another client, and loading data for offline use. The full suite also checks offline recovery, conflicting edits, reconnecting clients, access changes and attachments.','',
 '**September 9, 2026 · Apple M4 · local services · Syncular JS/Rust 0.17.0.** Each case gets three attempts, including failures. The tables show milliseconds; lower is faster. Screen and edit values are medians of each trial’s p50. Startup values are medians of three elapsed times. Ranges and individual trials are linked below; three trials do not establish statistical significance.','',
 '## Local screens','',
 'All 100,000 tasks are already loaded. SQL clients have indexes matching the queries; outputs are checked for identical rows, ordering and totals.','',
 '| Client | Task list | Grouped counts | Organization dashboard |','| --- | ---: | ---: | ---: |',
 ...rows(sql,screens),'',
 `**Zero, measured separately:** task list ${zeroValues[0]} ms, grouped counts ${zeroValues[1]} ms, dashboard ${zeroValues[2]} ms. It uses native filtering and relationships, then JavaScript aggregation.`,'',
 '**Caveats:** The SQL list differences are below our 1 ms practical threshold. SQL runs in memory for Syncular and in file-backed stores for PowerSync/Turso. These are application paths, not isolated engine comparisons.','',
 '**Why:** A controlled SQLite test confirms that matching indexes removed a costly sort. It does not explain the remaining product gaps. Zero’s materialization versus grouping cost is still unmeasured. [Index investigation](./docs/investigations/screen-index-effect.md) · [SQL details]('+details(sql)+') · [Zero details]('+details(zero)+')','',
 '## Sharing an edit','',
 '200 tasks, 50 measured edits per trial. Local commit means the writer has applied the edit; reader visibility means another client can see it.','',
 '| Client | Local commit | Server accepted | Reader visible |','| --- | ---: | ---: | ---: |',
 ...rows(sql,[['online-propagation','local_commit_p50_ms'],['online-propagation','server_accepted_p50_ms'],['online-propagation','mirror_visible_p50_ms']]),'',
 '**Caveat:** PowerSync’s default 1,000 ms upload throttle may contribute to its reader delay. This is a hypothesis, not a measured breakdown. The milestones can overlap; local commit does not prove crash durability. [Investigation and next experiment](./docs/investigations/powersync-collaboration.md)','',
 '## Starting with an empty client','',
 '100,000 tasks, fresh local stores, warm services. “Offline copy” means the complete expected dataset is available locally.','',
 '| Client | First correct screen | Complete offline copy |','| --- | ---: | ---: |',
 ...rows(sql,[['bootstrap','startup_warm_100000_first_screen_ms'],['bootstrap','startup_warm_100000_full_data_ms']]),'',
 '**Caveats:** PowerSync timed out in all three startup attempts at the initial 1,000-task stage; it never reached this 100,000-task case. The cause remains unexplained. Screen and full-copy milestones are observed independently. Retained server storage and OS caches affect these measurements. [Startup details]('+details(sql)+')','',
 '## Failures and further results','',
 '**174 attempts: 132 passed, 33 failed/invalid/timed out, nine unavailable.** PowerSync also had repeated recovery setup failures. Rust attachment preparation timed out in all three attempts; a WebSocket-readiness race is suspected but unproven. Turso’s earlier disk and connection failures remain counted even where later trials passed. A dash is no eligible timing, never zero. [Failure explanations](./docs/investigations/tuned-publication-failures.md)','',
 'Electric, Electric + TanStack DB, experimental Jazz and Zero’s other cases retain separately labeled historical results. They are not fresh tuned comparisons.','',
 '[All cases and outcomes](./COVERAGE.md) · [Complete SQL tables]('+details(sql)+') · [Complete Zero tables]('+details(zero)+') · [Methods](./docs/methodology.md)',''];
 await writeFile(outputPath,lines.join('\n'));
 console.log('Rendered essential results from validated campaign summaries; detailed reports remain linked.');
 }
} else {
const lines=['# Benchmark results','',`**${lead.observation}**`,'',lead.implication,'',
 'The corrected collection contains 174 attempts: three per case for Syncular JS/Rust 0.17.0, PowerSync and Turso across fourteen cases, plus Zero’s two screen cases. The 230 retained historical attempts remain separate. Each finding below uses one campaign; samples and uncertainty are never pooled across sources.','',
 '| Current campaign | Attempts | Host | Complete report |','| --- | --- | --- | --- |'];
for(const source of sources.values())lines.push(`| ${escape(source.label)} | ${source.manifest.attempts.length} | ${escape(String(source.manifest.machine.cpuModel))} | [Data, profiles and explanations](${posix.join(source.root,reportDetailsPath(source.manifest.id))}) |`);
lines.push('',coverageMd.trim(),'','## Findings','');
for(const {source,annotation} of selected){
 const view={...source.manifest,report:{...source.manifest.report,findingIds:[annotation.id]}};
 const rendered=renderCampaign(view);
 let body=rendered.split('\n## Findings\n')[1]?.split('\n## Reading these results\n')[0];assert(body,'Renderer did not return the expected finding section');
 assert(!body.includes(' (interval unavailable)'), 'Apply the prepared observed-range formatting fix before final rendering');
 body=body.replace(/\n\d+ additional reviewed annotations?[^\n]*\n/g,'\n');
 lines.push(rebasePublishedLinks(body.trim(),source.root,source.links),'');
}
lines.push('## Reading these results','',
 'Three independent attempts give a median and an observed range, not a confidence interval. Operation percentiles are not additional independent trials. A failed latest attempt supplies no speed estimate; all earlier failures remain visible. Profile differences and experimental configurations stay explicit.','',
 'Server storage retains its recorded physical history. Fixture resets do not establish fresh storage. Native query plans, exact output checks, operation samples and failure evidence remain attached to their original results. Historical coverage is not a new tuned comparison.','',
 `[Methodology](./docs/methodology.md) · [Summary inputs and source bindings](./${basename(configPath)}) · [Complete coverage inventory](./COVERAGE.json)`,'');
await writeFile(outputPath,lines.join('\n'));
console.log(`Rendered ${selected.length} source-bound findings across ${sources.size} campaigns; artifact packaging and visual review remain separate gates.`);
}
