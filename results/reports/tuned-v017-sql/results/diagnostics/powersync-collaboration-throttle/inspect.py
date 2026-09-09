import json, hashlib, shutil
from pathlib import Path
from datetime import datetime, timezone
root=Path.cwd(); campaign=root/'.results/campaign-2026-09-08T22-58-56-419Z'; m=json.loads((campaign/'CAMPAIGN.json').read_text()); depbytes=(campaign/'DEPENDENCIES.json').read_bytes(); deps=json.loads(depbytes)
sha=lambda b:hashlib.sha256(b).hexdigest()
assert sha(depbytes)==m['dependencies']['sha256']
out=root/'results/diagnostics/powersync-collaboration-throttle'; out.mkdir(exist_ok=True)
paths=['src/adapters/powersync-runner.ts']
for package in ['node','shared-internals','common']: paths.append(f'node_modules/@powersync/{package}/package.json')
for suffix in ['src/client/sync/options.ts','src/client/sync/stream/AbstractStreamingSyncImplementation.ts','src/client/BasePowerSyncDatabase.ts','lib/client/sync/options.js','lib/client/sync/stream/AbstractStreamingSyncImplementation.js','lib/client/BasePowerSyncDatabase.js','lib/index.js']:
 paths.append('node_modules/@powersync/shared-internals/'+suffix)
for suffix in ['src/sync/stream/NodeStreamingSyncImplementation.ts','src/db/PowerSyncDatabase.ts','lib/sync/stream/NodeStreamingSyncImplementation.js','lib/db/PowerSyncDatabase.js','lib/index.js']:
 paths.append('node_modules/@powersync/node/'+suffix)
files=[]
for path in paths:
 data=(root/path).read_bytes(); inventory=deps['entries'] if path.startswith('node_modules/') else m['source']['files']; expected=inventory[path]['sha256']; assert sha(data)==expected,path
 dest='source/'+path.replace('node_modules/', 'installed-sdk/')+'.txt'; target=out/dest; target.parent.mkdir(parents=True,exist_ok=True); target.write_bytes(data)
 files.append({'originalPath':path,'copy':dest,'sha256':expected,'bytes':len(data),'inventory':'dependencies' if path.startswith('node_modules/') else 'campaign-source'})
trials=[]
for i,a in enumerate(m['attempts'],1):
 if a['stackId']!='powersync' or a['scenarioId']!='online-propagation':continue
 raw=(campaign/a['resultFile']).read_bytes(); assert json.loads(raw)==a['result']; dest='trials/'+a['resultFile']; target=out/dest; target.parent.mkdir(exist_ok=True); target.write_bytes(raw)
 r=a['result']; trials.append({'attempt':i,'trial':a['trial'],'resultId':r['resultId'],'status':r['status'],'raw':dest,'rawSha256':sha(raw),'metrics':{k:v for k,v in r['metrics'].items() if k.endswith('_p50_ms') or k in ['iterations','warmup_iterations']}})
assert len(trials)==2
inspection={'version':1,'inspectedAt':datetime.now(timezone.utc).isoformat(),'status':'supported-hypothesis','campaignId':m['id'],'sourceHash':m['source']['sourceHash'],'dependencyFingerprint':m['dependencies']['fingerprint'],'dependencyInventorySha256':sha(depbytes),'installedVersions':{p:json.loads((root/f'node_modules/@powersync/{p}/package.json').read_text())['version'] for p in ['node','common','shared-internals']},'observation':'The first two PowerSync collaboration trials report reader-visible p50 values of 1005.13 ms and 982.51 ms.','confirmedFacts':['The benchmark connects without a SyncOptions override.','The installed TypeScript source and emitted JavaScript set crudUploadThrottleMs to 1000 when no override is supplied.','Each outer upload loop awaits both _uploadAllCrud and its throttle delay concurrently, then waits for a CRUD notification.','The upload worker drains queued transactions and updates its local target, using a legacy checkpoint by default.','The benchmark records server acceptance after the successful mutation-backend response; reader visibility is observed independently through 1 ms local SQL polling.'],'explanation':'Upload scheduling may contribute to the measured delay. The configured 1000 ms throttle alone does not establish how much of the reader-visible latency it causes.','limitations':['No timestamped upload-loop, checkpoint or reader-apply trace exists for these trials.','The throttle overlaps upload work; it is not an additive 1000 ms delay per write.','Per-trial p50 milestone differences cannot isolate a pipeline stage.','This is source inspection, not a controlled performance experiment. It does not invalidate or replace the fixed campaign samples.'],'nextExperiment':'After fixed collection, separately instrument queue notification, upload start, backend response, checkpoint receipt and reader apply. Compare the unchanged default with one explicitly declared supported crudUploadThrottleMs override, holding workload, versions, storage preparation and network conditions constant. Preserve original campaign results and profile the diagnostic separately.','trials':trials,'files':files}
(out/'INSPECTION.json').write_text(json.dumps(inspection,indent=2)+'\n')
shutil.copyfile(__file__,out/'inspect.py')
print(json.dumps({'output':str(out),'copiedFiles':len(files),'trials':len(trials),'bytes':sum(f['bytes'] for f in files)}))
