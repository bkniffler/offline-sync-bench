/** Read-only audit of the completed source-separated publication. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { validateManifest, validateAnnotations, groupAttempts, summarizeCase } from '../src/campaign-report.ts';
import { validateFindingSelection } from '../src/report-editorial.ts';
import { hash } from '../src/contracts/screens.ts';
import { hasScenarioContract } from '../src/contracts/registry.ts';
const sha=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
const read=async(p:string)=>JSON.parse(await readFile(p,'utf8'));
const config=await read('SUMMARY.json'), coverage=await read('COVERAGE.json');
const records:any[]=[], charts:any[]=[], outcomes:Record<string,number>={};
let metricSummaries=0, artifacts=0;
for(const source of config.sources){
 const root=source.root, archive=await read(join(root,'ARCHIVE.json'));
 assert.equal(sha(await readFile(join(root,'ARCHIVE.json'))),source.archiveSha256);
 const originals=new Map<string,Buffer>();
 for(const item of archive.files){
  const bytes=await readFile(join(root,item.archive));assert.equal(bytes.length,item.compressedBytes);assert.equal(sha(bytes),item.compressedSha256);
  const raw=gunzipSync(bytes);assert.equal(raw.length,item.bytes);assert.equal(sha(raw),item.sha256);originals.set(item.path,raw);artifacts++;
 }
 const m=JSON.parse(originals.get('RESULTS.json')!.toString());
 assert.equal(sha(originals.get('RESULTS.json')!),source.manifestSha256);
 validateManifest(m);const annotations=validateAnnotations(m);validateFindingSelection(m,annotations,true);
 assert(m.config.trials===3||(m.config.trials===1&&m.config.replication==='single-run'));
 const groups=groupAttempts(m.attempts);
 for(const attempts of groups.values()){
  assert.deepEqual(attempts.map(a=>a.trial).sort(),Array.from({length:m.config.trials},(_,i)=>i+1));
  for(const key of new Set(attempts.flatMap(a=>Object.keys(a.result.metrics)))){
   const actual=summarizeCase(attempts,key), latest=attempts.at(-1)!.result;
   if(latest.status!=='completed')assert.equal(actual.summary,null);
   if(!actual.summary)continue;
   const values=attempts.filter(a=>a.result.status==='completed').map(a=>a.result.metrics[key] as number).sort((a,b)=>a-b);
   const median=values.length%2?values[Math.floor(values.length/2)]!:(values[values.length/2-1]!+values[values.length/2]!)/2;
   assert.deepEqual(actual.summary,{trials:values.length,median,min:values[0],max:values.at(-1),confidence95:null});metricSummaries++;
  }
 }
 const caseOutcomes:Record<string,Record<string,number>>={};
 for(const a of m.attempts){
  assert.deepEqual(JSON.parse(originals.get(a.resultFile)!.toString()),a.result);assert(originals.has(a.resultFile+'.log'));
  assert(Number.isFinite(a.result.durationMs)&&a.result.durationMs>=0);
  outcomes[a.result.status]=(outcomes[a.result.status]??0)+1;
  const cell=caseOutcomes[a.scenarioId]??={};cell[a.result.status]=(cell[a.result.status]??0)+1;
  if(a.result.status==='completed'){
   assert(hasScenarioContract(a.result.metadata.workloadContract,a.scenarioId));
   assert.equal(a.result.metadata.profile.eligible,true);
  }
 }
 for(const a of annotations){
  const attempts=m.attempts.filter((x:any)=>x.scenarioId===a.table!.scenarioId);
  assert.deepEqual([...a.resultIds].sort(),attempts.map((x:any)=>x.result.resultId).sort());
  if(!a.chart)continue;
  const dataPath=a.chart.path.replace(/\.svg$/,'-data.json'),data=JSON.parse(originals.get(dataPath)!.toString());
  assert.equal(data.sourceHash,m.source.sourceHash);
  assert.deepEqual(data.resultBindings.map((x:any)=>[x.resultId,x.resultDigest,x.trial,x.status]),attempts.map((x:any)=>[x.result.resultId,hash(x.result),x.trial,x.result.status]));
  for(const group of data.groups)for(const row of group.rows)for(const metric of row.metrics){
   const trials=attempts.filter((x:any)=>x.stackId===row.stack);
   assert.deepEqual(metric.summary,summarizeCase(trials,metric.key).summary);
   assert.deepEqual(metric.values,metric.summary?trials.filter((x:any)=>x.result.status==='completed').map((x:any)=>x.result.metrics[metric.key]):[]);
  }
  const receipt=JSON.parse(originals.get(a.chart.path.replace(/\.svg$/,'.json'))!.toString());
  assert.equal(receipt.inputSha256,sha(originals.get(dataPath)!));
  const name=a.chart.path.split('/').at(-1)!;
  assert.equal(receipt.outputs[name],sha(originals.get(a.chart.path)!));
  charts.push({id:a.id,resultCount:attempts.length,svgSha256:receipt.outputs[name],dataSha256:receipt.inputSha256});
 }
 records.push({campaignId:m.id,sourceHash:m.source.sourceHash,attempts:m.attempts.length,groups:groups.size,annotations:annotations.length,caseOutcomes,artifactCount:archive.files.length});
}
assert.equal(Object.values(outcomes).reduce((sum,n)=>sum+n,0),records.reduce((sum,r)=>sum+r.attempts,0));
assert.equal(coverage.currentAttempts,coverage.cases.filter((c:any)=>!c.historical).reduce((n:number,c:any)=>n+c.attempts.length,0));assert.equal(coverage.cases.length,112);
assert.equal(records.reduce((sum,r)=>sum+r.attempts,0),coverage.currentAttempts+(coverage.supersededAttempts??0));
const reportPath=['readme-v1','readme-benchmarks-v1'].includes(config.presentation)?'README.md':'RESULTS.md';
const page=await readFile(reportPath,'utf8');
const wordCount=page.trim().split(/\s+/).length;
if(config.presentation==='readme-benchmarks-v1'){
 const sections=page.split(/^### /m).slice(1);
 assert.equal(sections.length,config.clientSize?15:14);
 assert.equal((page.match(/^\| Client \|/gm)??[]).length,config.clientSize?15:14);
 for(const section of sections){
  if(section.startsWith('Client JavaScript size')){assert(config.clientSize);assert(section.includes('| Minified JS | Gzip JS |'));assert.equal((section.match(/^\| /gm)??[]).length,10);continue;}
  const nativeAttachments=section.startsWith('Uploading and downloading attachments')&&config.sources.some((s:any)=>s.id==='native-files');
  assert(section.includes('[Workload details]('));
  if(nativeAttachments)for(const label of ['Syncular JS details','Syncular Rust details','PowerSync and Jazz details'])assert(section.includes(`[${label}](`));
  else assert(section.includes('[SQL details](')||section.includes('[Syncular/Turso details]('));
  for(const label of ['Syncular JS','Syncular Rust','PowerSync','Turso','Electric','Electric + TanStack DB','Jazz v2 (experimental)'])assert(section.includes(`| ${label} |`));
  assert(section.includes('| Zero |'));
  if(!nativeAttachments)assert(section.includes('[Other client details]('));
 }
 assert.equal((page.match(/^\| Zero \|/gm)??[]).length,config.clientSize?15:14);
 assert(!page.includes('‡')&&!page.includes('†'));
 assert(page.includes('## Latest results'));
 assert(!page.includes('| Attempts |')&&!page.includes('| Passed / attempted |'));
 assert((await readFile('RESULTS.md','utf8')).includes('./README.md#latest-results'));
}else if(config.presentation==='readme-v1'){
 assert(wordCount<=500);
 assert.equal((page.match(/^\| Client \|/gm)??[]).length,1);
 for(const label of ['Syncular JS','Syncular Rust','PowerSync','Turso','Zero †'])assert(page.includes(`| ${label} |`));
 assert(page.includes('## Latest results'));
 assert(!page.includes('| Attempts |')&&!page.includes('| Passed / attempted |'));
 assert((await readFile('RESULTS.md','utf8')).includes('./README.md#latest-results'));
}else if(config.presentation==='essential-v1'){
 assert(wordCount>=300&&wordCount<=800);
 assert.equal((page.match(/^\| Client \|/gm)??[]).length,3);
 assert.equal((page.match(/^!\[/gm)??[]).length,0);
 for(const heading of ['Local screens','Sharing an edit','Starting with an empty client','Failures and further results'])assert(page.includes(`## ${heading}`));
 assert(page.includes('132 passed, 33 failed/invalid/timed out, nine unavailable'));
 assert(page.includes('[All cases and outcomes](./COVERAGE.md)'));
}else{
 assert.equal((page.match(/^### /gm)??[]).length,4);assert.equal((page.match(/^## Coverage and outcomes/gm)??[]).length,1);
 assert(wordCount>=1000&&wordCount<=1500);
}
assert(!page.includes(' (interval unavailable)'));assert(!page.includes('| Stack / client path |'));
const result={status:'verified',scope:'All published manifests, all compressed/original archive bytes, raw trials/logs, full publication contracts, annotations, independent-trial summaries, chart values and main-report structure. Outcomes below include superseded samples; the coverage index selects current samples. Link/Git reviews have separate receipts.',records,outcomes,metricSummaries,artifacts,charts,main:{wordCount,sha256:sha(Buffer.from(page)),presentation:config.presentation??'findings',reviewedAnnotations:config.findings.length},auditorSha256:sha(await readFile(import.meta.path))};
await writeFile('results/diagnostics/final-publication/RESULT-AUDIT.json',JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({status:result.status,artifacts,metricSummaries,wordCount,attempts:records.reduce((sum,r)=>sum+r.attempts,0)}));
