import assert from 'node:assert/strict';
import { suites } from '../src/suites.ts';
import { stacks } from '../src/stacks.ts';
/** Derive displayed counts from attempts, never from precomputed display labels. */
export function renderPublicationCoverage(coverage:any):string {
 const records=new Map<string,any>();let current=0,retained=0;
 for(const input of coverage.cases){
  const key=`${input.stack}/${input.scenario}`;assert(!records.has(key),'Duplicate coverage slot');
  const replacement=coverage.supersededCases?.some((c:any)=>c.stack===input.stack&&c.scenario===input.scenario);
  const expected=replacement?'coverage-fixes':input.stack==='powersync'&&coverage.sources.some((s:any)=>s.id==='powersync-maintained')?'powersync-maintained':['syncular','syncular-rust','powersync','turso'].includes(input.stack)?'tuned-sql':input.stack==='zero'&&['local-query','deep-relationship-query'].includes(input.scenario)?'tuned-zero':'retained-history';
  assert.equal(input.source,expected,'Unexpected source for coverage slot');
  const attempts=[...input.attempts].sort((a:any,b:any)=>a.trial-b.trial);const historical=expected==='retained-history';
  const last=attempts.at(-1);const failedAttempts=attempts.filter(a=>['failed','invalid','timed-out'].includes(a.outcome)).length;
  let display='pending';
  if(historical||attempts.length===input.plannedAttempts)display=last?.outcome==='completed'?'passed':last?.outcome==='unsupported'?last.coverage?.status==='unsupported-tested-configuration'?'unsupported':last.coverage?.status==='not-implemented'?'not implemented':'unavailable':last?.outcome??'pending';
  if(input.exclusion)display=input.exclusion.label;
  records.set(key,{historical,display,failedAttempts:input.exclusion?0:failedAttempts});
  if(historical)retained+=attempts.length;else current+=attempts.length;
 }
 const expected=stacks.flatMap(s=>suites.flatMap(suite=>suite.cases.map(c=>`${s.id}/${c}`))).sort();
 assert.deepEqual([...records.keys()].sort(),expected);assert.equal(current,coverage.currentAttempts);assert.equal(retained,coverage.retainedAttempts);
 const lines=['## Coverage and outcomes','',`Replacement collection: **${current}/${coverage.currentPlannedAttempts} attempts**. H marks retained historical coverage from the stopped campaign.`, '', '| Suite | '+stacks.map(s=>s.title).join(' | ')+' |','| --- | '+stacks.map(()=>'---').join(' | ')+' |'];
 for(const suite of suites){
  const cells=stacks.map(s=>{
   const items=suite.cases.map(c=>records.get(`${s.id}/${c}`));const counts=new Map<string,number>();
   for(const item of items)counts.set(item.display,(counts.get(item.display)??0)+1);
   const failed=items.reduce((n,item)=>n+item.failedAttempts,0);
   return [...counts].map(([label,n])=>`${n} ${label}`).join('; ')+(items.every(i=>i.historical)?' H':'')+(failed?`; ${failed} failed attempt${failed===1?'':'s'}`:'');
  });lines.push(`| ${suite.title} | ${cells.join(' | ')} |`);
 }
 lines.push('','Cells summarize the latest outcome per case; replacement cases remain pending until their declared attempts are recorded. Failed-attempt counts include earlier failures. H cases retain their original attempts and are not new tuned comparisons. Jazz v2 remains experimental. Unavailable coverage makes no claim about product capabilities.','', 'Excluded client-write workflows are marked Not supported; old attempts remain retained for audit, not displayed as product timings. This combines coverage only. Timings, annotations and uncertainty stay with their source campaign. [Source and trial identities](./COVERAGE.json).','');
 return lines.join('\n');
}
