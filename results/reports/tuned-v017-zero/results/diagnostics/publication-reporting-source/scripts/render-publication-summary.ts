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
import { createHash } from 'node:crypto';
import { validateManifest, validateAnnotations, renderCampaign, type Annotation } from '../src/campaign-report.ts';
import type { CampaignManifest } from '../src/campaign.ts';
import { reportDetailsPath } from '../src/report-editorial.ts';
const [configPath, outputPath]=process.argv.slice(2);
assert(configPath&&outputPath,'Supply SUMMARY.json OUTPUT.md');
const config=JSON.parse(await readFile(configPath,'utf8'));
assert.equal(config.version,1);assert.equal(config.kind,'source-separated-publication-summary');
assert(Array.isArray(config.sources)&&config.sources.length===2);
assert(Array.isArray(config.findings)&&config.findings.length>=3&&config.findings.length<=5);
const base=dirname(resolve(configPath));
assert.equal(dirname(resolve(outputPath)),base,'Write the report beside its summary configuration');
const sha=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
const escape=(s:string)=>s.replaceAll('|','\\|').replaceAll('\n',' ');
type Source={manifest:CampaignManifest;annotations:Annotation[];root:string;label:string;links:Map<string,string>};
const sources=new Map<string,Source>();
for(const source of config.sources){
 assert(['tuned-sql','tuned-zero'].includes(source.id)&&!sources.has(source.id));
 assert(typeof source.label==='string'&&source.label.trim());
 assert(typeof source.root==='string'&&!source.root.startsWith('/')&&!source.root.includes('..'));
 const bytes=await readFile(resolve(base,source.manifest));const raw=source.manifest.endsWith('.gz')?gunzipSync(bytes):bytes;
 assert.equal(sha(raw),source.manifestSha256,'Stale manifest binding');
 const manifest=JSON.parse(raw.toString()) as CampaignManifest;validateManifest(manifest);
 assert.equal(manifest.config.trials,3,'Replacement campaigns must retain the three-attempt cap');
 if(source.id==='tuned-sql'){
  assert.deepEqual([...manifest.config.stacks].sort(),['powersync','syncular','syncular-rust','turso']);
  assert.equal(manifest.config.scenarios.length,14);
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
const coverage=JSON.parse(coverageBytes.toString());assert.equal(coverage.status,'replacement-collection-complete');
assert.equal(coverage.currentAttempts,174);assert.equal(coverage.cases.length,112);assert.equal(coverage.retainedAttempts,230);
for(const [id,source] of sources){
 const record=coverage.sources.find((s:any)=>s.id===id);assert(record);
 assert.equal(record.campaignId,source.manifest.id);assert.equal(record.sourceHash,source.manifest.source.sourceHash);
 // Packaged manifests relocate result paths and can add reviewed annotations.
 // Bind the actual trial identities/outcomes, not the pre-packaging file hash.
 const cells=coverage.cases.filter((c:any)=>c.source===id);
 const expected=source.manifest.attempts.map(a=>[a.stackId,a.scenarioId,a.trial,a.result.resultId,a.result.status,sha(Buffer.from(JSON.stringify(a.result,null,2)+'\n'))].join('|')).sort();
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
