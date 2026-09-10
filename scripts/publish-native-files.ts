/** Package the two native attachment implementations without pooling old attempts. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { hash } from '../src/contracts/screens.ts';
import { validateManifest, type Annotation } from '../src/campaign-report.ts';
import type { CampaignManifest } from '../src/campaign.ts';
const campaignPath=resolve(process.argv[2]!);
const m=JSON.parse(await readFile(campaignPath,'utf8')) as CampaignManifest;
validateManifest(m);
assert.deepEqual(m.config,JSON.parse(await readFile('campaigns/publication-native-files.json','utf8')));
assert.equal(m.attempts.length,2);
assert(m.attempts.every(a=>a.result.status==='completed'));
assert(m.attempts.every(a=>(a.result.metadata.profile as any)?.eligible === true), 'Native file profiles must be eligible before packaging');
const assets=resolve('.tmp/native-files-assets');
await mkdir(join(assets,'docs'),{recursive:true}); await mkdir(join(assets,'evidence'),{recursive:true});
await mkdir(join(assets,'results/history/2026-09-05'),{recursive:true});
await writeFile(join(assets,'docs/methodology.md'),'# Native attachments\n\nOne predeclared run per SDK (n=1), sequentially on local services. Each uploads two deterministic 2 MiB files linked to tasks and verifies their SHA-256 hashes after download. New processes and empty native stores serve the fresh and interrupted downloads. These are native file features, with different timing boundaries: PowerSync stages prepared bytes before timing its experimental native queue and streaming transport; Jazz times its native file helper including chunk creation and edge durability. PowerSync uses the same MinIO backend as Syncular and cuts a download after 64 KiB. Jazz drops its native connection after delivering a 256 KiB chunk, cancels the read, verifies an incomplete local file, then retries using the retained native cache. Both measure SDK calls and local materialization; hash validation follows the clock.\n\nThis is not a transport-only ranking. Run-to-run variability is unknown. Development runs and the campaign invalidated by a source change are excluded. All native state, interruption receipts and [provenance](../RESULTS.json) remain inspectable.\n\n[Results](../RESULTS.md)\n');
await writeFile(join(assets,'results/history/2026-09-05/README.md'),'# Earlier measurements\n\nEarlier attempts are retained in their original archives and are not pooled with these native attachment measurements.\n');
const observations=[
 {id:'powersync-native-files',stack:'powersync',status:'confirmed',question:'Does PowerSync’s own attachment queue complete the file workflow?',observation:'Both 2 MiB objects upload and independent fresh and interrupted clients download the expected complete bytes.',explanation:'The SDK AttachmentQueue owns persistence, state transitions and retries. Its NodeFileSystemTransportAdapter streams bytes directly to the same MinIO service used by Syncular. The harness supplies signed URLs and task metadata integration. A truncated HTTP response leaves QUEUED_DOWNLOAD with hasSynced false; restoration produces SYNCED and the correct hash. Setup verifies active sync rules and fixture-history maintenance before timing.',implication:'PowerSync has a measured native attachment path. The queue and Node file transport are experimental; upload excludes staging and includes queue startup.'},
 {id:'jazz-native-files',stack:'jazz-v2',status:'confirmed',question:'Can Jazz’s native chunked files recover after interruption?',observation:'The native file helpers create eight 256 KiB parts per object, and both independent download processes reconstruct the correct 2 MiB hash.',explanation:'The public backend context uses the native local-tier runtime. createFileFromBlob waits for edge durability; loadFileAsBlob queries the native parts. After the first delivered chunk, the TCP connection is blocked and the stream cancelled. An offline native read rejects the incomplete file before restoration. The retry retains SDK-cached parts and includes native reconnection delay.',implication:'Jazz has a measured native file path. Its upload includes chunk creation and persistence; its retry is chunked sync, so these timings have different boundaries from object-store clients.'},
 {id:'native-file-comparison',stack:null,status:'unexplained',question:'What explains the timing difference between these native file paths?',observation:'The two SDKs expose different upload and retry operations despite transferring the same deterministic payloads.',explanation:'PowerSync runs an object-store queue; Jazz persists and syncs file-part rows. The receipts establish their executed paths and correctness, but do not isolate chunking, local persistence, scheduling, HTTP transport or native sync costs.',implication:'Use the numbers to understand these integrations, with the table caveats. One run cannot establish a stable product speed ratio.',nextExperiment:'Instrument native staging, persistence, transport and reconnection separately while preserving complete byte validation.'},
] as const;
m.annotations=[];
for(const o of observations){
 const attempts=m.attempts, path=`evidence/${o.id}.json`;
 await writeFile(join(assets,path),JSON.stringify({sourceHash:m.source.sourceHash,explanation:o.explanation,results:attempts.map(a=>({stack:a.stackId,resultId:a.result.resultId,resultDigest:hash(a.result),metrics:a.result.metrics,contract:a.result.metadata.workloadContract,profile:a.result.metadata.profile}))},null,2)+'\n');
 const annotation:Annotation={id:o.id,resultIds:attempts.map(a=>a.result.resultId),sourceHash:String(m.source.sourceHash),resultDigests:Object.fromEntries(attempts.map(a=>[a.result.resultId,hash(a.result)])),status:o.status,question:o.question,observation:o.observation,explanation:o.explanation,implication:o.implication,...('nextExperiment' in o?{nextExperiment:o.nextExperiment}:{}),table:{scenarioId:'blob-flow',metrics:[{key:'initial_upload_ms',label:'Upload'},{key:'fresh_download_ms',label:'Fresh download'},{key:'download_interruption_recovery_ms',label:'Download retry'}]},evidence:[{path,description:'Native result identities, metrics, profiles and interpretation',kind:'direct-accounting'}]};
 m.annotations.push(annotation);
}
m.report={findingIds:observations.map(o=>o.id)};
await writeFile(campaignPath,JSON.stringify(m,null,2)+'\n');
const child=Bun.spawn(['bun','scripts/publish-results.ts','--campaign',campaignPath,'--assets',assets,'--output',resolve('results/reports/native-files')],{stdout:'inherit',stderr:'inherit'});
process.exitCode=await child.exited;
