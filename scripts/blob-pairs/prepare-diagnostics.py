"""Separate, explicitly instrumented diagnostic builds; primary release builds stay intact."""
from pathlib import Path
import shutil, subprocess, json, hashlib, difflib
root=Path.cwd();reg=Path.home()/'.cargo/registry/src/index.crates.io-1949cf8c6b5b557f'
files=subprocess.check_output(['git','ls-files','src','services','stacks','drivers'],text=True).splitlines()
def replace(s,a,b):
 assert a in s,a
 return s.replace(a,b,1)
for version in ['0.17.0','0.18.0']:
 primary=root/'.tmp/blob-pairs'/version;dest=root/'.tmp/blob-pairs-diagnostics'/version;dest.mkdir(parents=True,exist_ok=True)
 for name in files+['package.json','bun.lock']:
  p=dest/name;p.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(primary/name,p)
 if not (dest/'node_modules').exists(): (dest/'node_modules').symlink_to(primary/'node_modules',target_is_directory=True)
 # JS uses released sources unchanged, observing public database/crypto/transport seams.
 shutil.copyfile(root/'scripts/blob-pairs/probe.ts',dest/'src/attachments/blob-probe.ts')
 adapter=dest/'src/adapters/syncular.ts';s=adapter.read_text();s="import { transport as probeTransport } from '../attachments/blob-probe.ts';\n"+s
 s=replace(s,'transport: httpSyncTransport(',"transport: probeTransport(httpSyncTransport(")
 s=replace(s,'fetch: meter.fetch,\n    }),\n    segments:',"fetch: meter.fetch,\n    }), 'metadata.'),\n    segments:")
 s=replace(s,'blobs: httpBlobTransport(',"blobs: probeTransport(httpBlobTransport(")
 s=replace(s,'        : blobMeter.fetch,\n    }),','        : blobMeter.fetch,\n    }), \'blob.\'),')
 adapter.write_text(s)
 # Native source copy gets timers only; Cargo registry and primary artifacts untouched.
 sdk=dest/'instrumented-client';shutil.copytree(reg/f'syncular-client-{version}',sdk,dirs_exist_ok=True)
 (sdk/'src/bench_blob_probe.rs').write_text((root/'scripts/blob-pairs/probe.rs').read_text())
 lib=sdk/'src/lib.rs';lib.write_text(lib.read_text()+'\npub mod bench_blob_probe;\n')
 client=sdk/'src/client.rs';original=client.read_text();s=original
 s=replace(s,'fn blob_id_for(bytes: &[u8]) -> String {','fn blob_id_for(bytes: &[u8]) -> String {\n    let _probe_hash = crate::bench_blob_probe::span("sha256");')
 a=s.index('    pub fn upload_blob(');b=s.index('    pub fn fetch_blob',a);stage=s[a:b]
 stage=replace(stage,'        let now = self.clock_now_ms();','        let now = self.clock_now_ms();\n        let _probe_storage = crate::bench_blob_probe::span("stageStorage");')
 stage=replace(stage,'        // §5.9.7 B1:','        drop(_probe_storage);\n        // §5.9.7 B1:')
 if version=='0.18.0': stage=replace(stage,'        transaction.commit().map_err(|e| e.to_string())?;','        { let _probe_commit = crate::bench_blob_probe::span("stageCommit");\n        transaction.commit().map_err(|e| e.to_string())?; }')
 s=s[:a]+stage+s[b:]
 a=s.index('    fn flush_blob_uploads(');b=s.index('    fn upload_one(',a);flush=s[a:b]
 flush=replace(flush,'        for (blob_id, media_type) in pending {','        for (blob_id, media_type) in pending {\n            let _probe_read = crate::bench_blob_probe::span("pendingBodyRead");')
 token='            let Some((SqlValue::Blob(bytes)' if version=='0.18.0' else '            if let Some(bytes) = bytes {'
 flush=replace(flush,token,'            drop(_probe_read);\n'+token)
 s=s[:a]+flush+s[b:];client.write_text(s)
 (dest/'sdk-timers.patch').write_text(''.join(difflib.unified_diff(original.splitlines(True),s.splitlines(True),fromfile='released/src/client.rs',tofile='instrumented/src/client.rs')))
 cargo=dest/'drivers/syncular-rust/Cargo.toml';s=cargo.read_text().replace(f'syncular-client = "={version}"',f'syncular-client = {{ version = "={version}", features = ["bench-internals"] }}')
 s+='\n[patch.crates-io]\nsyncular-client = { path = "../../instrumented-client" }\n';cargo.write_text(s)
 driver=dest/'drivers/syncular-rust/src/main.rs';s=driver.read_text();s=replace(s,'use std::io', 'use syncular_client::bench_blob_probe;\nuse std::io')
 for name in ['sync','realtime_sync','blob_upload','blob_download','fetch_blob_url','blob_upload_grant','blob_put_url']:
  a=s.index('    fn '+name+'(');b=s.index('{',a)
  s=s[:b+1]+f'\n        let _probe_transport = bench_blob_probe::span("transport.{name}");'+s[b+1:]
 s=replace(s,'        "benchStageBlobFile" => {','''        "probeStart" => { bench_blob_probe::reset(); need_client(client)?.benchmark_phases(Some(true),true).map_err(client_err)?; Ok(json!({})) }
        "probeTake" => { Ok(json!({"spans":bench_blob_probe::take(),"builtin":need_client(client)?.benchmark_phases(None,false).map_err(client_err)?})) }
        "benchStageBlobFile" => {''')
 s=replace(s,'            let bytes = std::fs::read(path).map_err(|e| client_err(e.to_string()))?;','            let input = bench_blob_probe::span("inputRead");\n            let bytes = std::fs::read(path).map_err(|e| client_err(e.to_string()))?;\n            drop(input);')
 driver.write_text(s)
 worker=dest/'src/attachments/large-syncular-worker.ts';s=worker.read_text();s="import * as probe from './blob-probe.ts';\n"+s
 s=replace(s,"    if (config.phase === 'writer') {\n      const bytes", "    evidence.profile = {};\n    if (config.phase === 'writer') {\n      probe.start(); const readEnd = probe.span('inputReadAndCopy');\n      const bytes")
 s=replace(s,'      const staging = performance.now();',"      readEnd(); evidence.profile.input = probe.take(); probe.start();\n      const staging = performance.now();")
 s=replace(s,'      evidence.stageMs = performance.now() - staging;','      evidence.stageMs = performance.now() - staging; evidence.profile.stage = probe.take();')
 s=replace(s,'      const started = performance.now(); const report', '      probe.start();\n      const started = performance.now(); const report')
 s=replace(s,'      evidence.uploadMs = performance.now() - started;', '      evidence.uploadMs = performance.now() - started; evidence.profile.upload = probe.take();')
 s=replace(s,'      const started = performance.now(); const { bytes }', '      probe.start();\n      const started = performance.now(); const { bytes }')
 s=replace(s,'      evidence.downloadMs = performance.now() - started;', '      evidence.downloadMs = performance.now() - started; evidence.profile.download = probe.take();')
 s=replace(s,"    if (config.phase === 'writer') {\n      const stage", "    evidence.profile = {};\n    if (config.phase === 'writer') {\n      await client.call('probeStart');\n      const stage")
 s=replace(s,'      assert.deepEqual(stage.ref, expectedRef);',"      evidence.profile.stage = await client.call('probeTake');\n      assert.deepEqual(stage.ref, expectedRef);")
 s=replace(s,'      const started = performance.now(); const result', "      await client.call('probeStart');\n      const started = performance.now(); const result")
 # The native assignment is unique because JS now has a probe.take suffix.
 s=replace(s,'      evidence.uploadMs = performance.now() - started;\n      const report', "      evidence.uploadMs = performance.now() - started;\n      evidence.profile.upload = await client.call('probeTake');\n      const report")
 s=replace(s,"      const result = await client.call('benchFetchBlobDigest'", "      await client.call('probeStart');\n      const result = await client.call('benchFetchBlobDigest'")
 s=replace(s,'      evidence.downloadMs = result.downloadMs;', "      evidence.profile.download = await client.call('probeTake');\n      evidence.downloadMs = result.downloadMs;")
 worker.write_text(s)
 subprocess.run(['cargo','build','--release','--offline'],cwd=dest/'drivers/syncular-rust',check=True)
 print('Prepared diagnostic',version,flush=True)
