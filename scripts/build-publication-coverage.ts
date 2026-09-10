/** Outcome-only catalog across separately sourced campaigns. Never pools timings.
 * bun scripts/build-publication-coverage.ts SQL_MANIFEST OUTPUT_DIRECTORY [ZERO_MANIFEST] [POWERSYNC_MANIFEST] [FIXES_MANIFEST]
 */
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { renderPublicationCoverage } from './publication-coverage-renderer.ts';
import { planCampaign } from '../src/campaign.ts';
import { suites } from '../src/suites.ts';
import { stacks } from '../src/stacks.ts';
const [sqlPath, output, zeroPath, powerSyncPath, fixesPath] = process.argv.slice(2);
assert(sqlPath && output, 'Supply SQL_MANIFEST OUTPUT_DIRECTORY [ZERO_MANIFEST] [POWERSYNC_MANIFEST] [FIXES_MANIFEST]');
const sha = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex');
const historyPath='results/diagnostics/publication-index-review/RETAINED-HISTORY.json';
const historyBytes=await readFile(historyPath);const history=JSON.parse(historyBytes.toString());
assert.equal(history.status,'retained-history-not-current-comparison');
const roster=stacks.map(s=>s.id);const scenarios=suites.flatMap(s=>[...s.cases]);
assert.equal(roster.length,8);assert.equal(new Set(scenarios).size,14);
const records=new Map<string,any>();const sources:any[]=[];
const key=(s:string,c:string)=>`${s}/${c}`;
const historic=(s:string,c:string)=>['electric','electric-tanstack','jazz-v2'].includes(s)||(s==='zero'&&!['local-query','deep-relationship-query'].includes(c));
for(const c of history.cases){
 assert(historic(c.stack,c.scenario));assert(!records.has(key(c.stack,c.scenario)));
 assert.equal(c.attemptCount,c.attempts.length);
 records.set(key(c.stack,c.scenario),{stack:c.stack,scenario:c.scenario,source:'retained-history',historical:true,plannedAttempts:null,attempts:c.attempts});
}
assert.equal(records.size,54);
sources.push({id:'retained-history',path:historyPath,sha256:sha(historyBytes),sourceHash:history.sourceHash,status:history.status,archive:history.archive,archiveSha256:history.archiveSha256});
let newAttempts=0;let currentComplete=true;const supersededCases:any[]=[];
for(const [id,path,configPath] of [['tuned-sql',sqlPath,'campaigns/publication-tuned-sql.json'],['tuned-zero',zeroPath,'campaigns/publication-tuned-zero.json'],...(powerSyncPath ? [['powersync-maintained',powerSyncPath,'campaigns/publication-powersync-maintained.json']] : []),...(fixesPath ? [['coverage-fixes',fixesPath,'campaigns/publication-coverage-fixes.json']] : [])]){
 const config=JSON.parse(await readFile(configPath,'utf8'));assert(config.trials===3||(config.trials===1&&config.replication==='single-run'));
 for(const {stackId:s,scenarioId:c} of planCampaign(config).filter(a=>a.trial===1)){
  if (powerSyncPath && id === 'tuned-sql' && s === 'powersync') continue;
  if(id==='coverage-fixes') { const previous=records.get(key(s,c));assert(previous,'Replacement requires an existing slot');supersededCases.push(previous); }
  else assert(!records.has(key(s,c))&&!historic(s,c),'Sources overlap');
  records.set(key(s,c),{stack:s,scenario:c,source:id,historical:false,plannedAttempts:config.trials,attempts:[]});
 }
 if(!path){currentComplete=false;sources.push({id,status:'not-started',configPath});continue;}
 const bytes=await readFile(path);const m=JSON.parse(bytes.toString());assert.deepEqual(m.config,config);
 assert(['running','complete','invalid'].includes(m.status));currentComplete&&=m.status==='complete';
 const seen=new Set<string>();
 for(const a of m.attempts){
  const r=a.result;const identity=`${a.stackId}/${a.scenarioId}/${a.trial}`;assert(!seen.has(identity));seen.add(identity);
  if (powerSyncPath && id === 'tuned-sql' && a.stackId === 'powersync') continue;
  const record=records.get(key(a.stackId,a.scenarioId));assert(record?.source===id);
  assert(Number.isInteger(a.trial)&&a.trial>=1&&a.trial<=config.trials);assert.equal(r.stackId,a.stackId);assert.equal(r.scenarioId,a.scenarioId);assert.equal(r.runId,m.id);
  assert.equal(r.metadata.profile.sourceHash,m.source.sourceHash);
  const rawPath=resolve(dirname(path),a.resultFile);assert(rawPath.startsWith(resolve(dirname(path))+'/'));
  const raw=await readFile(rawPath);assert.deepEqual(JSON.parse(raw.toString()),r);
  record.attempts.push({trial:a.trial,resultId:r.resultId,outcome:r.status,coverage:r.metadata.coverage,resultFile:rawPath,sha256:sha(raw)});newAttempts++;
 }
 if(m.status==='complete')assert.equal(m.attempts.length,planCampaign(config).length);
 sources.push({id,path:resolve(path),sha256:sha(bytes),campaignId:m.id,sourceHash:m.source.sourceHash,status:m.status,attempts:m.attempts.length,error:m.error??null});
}
assert.equal(records.size,112);
const failures=new Set(['failed','invalid','timed-out']);
for(const record of records.values()){
 record.attempts.sort((a:any,b:any)=>a.trial-b.trial);
 record.attempted=record.attempts.length;record.failedAttempts=record.attempts.filter((a:any)=>failures.has(a.outcome)).length;
 const last=record.attempts.at(-1);record.latestOutcome=last?.outcome??'not-run';
 record.display=record.historical||record.attempted===record.plannedAttempts ? last?.outcome==='completed'?'passed':last?.outcome==='unsupported'?last.coverage?.status==='unsupported-tested-configuration'?'unsupported':last.coverage?.status==='not-implemented'?'not implemented':'unavailable':last?.outcome??'pending':'pending';
}
await mkdir(output,{recursive:true});
newAttempts=[...records.values()].filter(c=>!c.historical).reduce((n,c)=>n+c.attempts.length,0);
const currentPlannedAttempts=[...records.values()].filter(c=>!c.historical).reduce((n,c)=>n+c.plannedAttempts,0);
const retainedAttempts=[...records.values()].filter(c=>c.historical).reduce((n,c)=>n+c.attempts.length,0);
const supersededAttempts=(powerSyncPath?42:0)+supersededCases.filter(c=>!c.historical).reduce((n,c)=>n+c.attempts.length,0);
const coverage={version:1,status:currentComplete?'replacement-collection-complete':'replacement-collection-incomplete',scope:'Outcome inventory only; not a publication acceptance gate or a mixed-source performance aggregate.',currentAttempts:newAttempts,currentPlannedAttempts,supersededAttempts,retainedAttempts,supersededCases,sources,cases:[...records.values()]};
await writeFile(join(output,'COVERAGE.json'),JSON.stringify(coverage,null,2)+'\n');
await writeFile(join(output,'COVERAGE.md'),renderPublicationCoverage(coverage));
await writeFile(join(output,'BUILD.json'),JSON.stringify({generatedAt:new Date().toISOString(),scope:'Outcome inventory with source and raw-trial checks; not a performance aggregate or publication gate.',currentAttempts:newAttempts,retainedAttempts,cases:records.size,coverageSha256:sha(await readFile(join(output,'COVERAGE.json'))),markdownSha256:sha(await readFile(join(output,'COVERAGE.md'))),builderSha256:sha(await readFile(import.meta.path)),rendererSha256:sha(await readFile(new URL('./publication-coverage-renderer.ts',import.meta.url)))},null,2)+'\n');
console.log(`${newAttempts}/${currentPlannedAttempts} replacement attempts; ${records.size} distinct cases; historical attempts remain separate`);
