"""Archive investigation evidence without editing the published n=1 collection."""
from pathlib import Path
import subprocess,json,hashlib,tarfile,datetime,shutil
root=Path.cwd();out=root/'results/investigations/syncular-018-blobs';out.mkdir(parents=True,exist_ok=True)
def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()
primary=root/'.results/blob-pairs-2026-09-11';diagnostic=root/'.results/blob-pairs-diagnostic-2026-09-11'
p=json.loads((primary/'RESULTS.json').read_text());d=json.loads((diagnostic/'RESULTS.json').read_text())
assert p.get('finishedAt') and d.get('finishedAt')
assert len(p['rows'])==12 and len(d['rows'])==4
assert sha(root/'results/large-files/RESULTS.json')==p['publishedManifestSha256']==d['publishedManifestSha256']
for data in [p,d]:
 for runtime in data['runtime']:
  cwd=Path(runtime['cwd'])
  for path,field in [('bun.lock','lockSha256'),('drivers/syncular-rust/Cargo.lock','cargoLockSha256'),('drivers/syncular-rust/target/release/syncular-bench','binarySha256')]:
   assert sha(cwd/path)==runtime[field],(cwd,path,'changed since collection')
 for row in data['rows']:
  assert row['result']['status']=='completed'
for name,source in [('PAIRS.json',primary/'RESULTS.json'),('PLAN.json',primary/'PLAN.json'),('DIAGNOSTICS.json',diagnostic/'RESULTS.json'),('HASH-PAIRS.json',diagnostic/'HASH-PAIRS.json')]:
 shutil.copyfile(source,out/name)
features=subprocess.check_output(['cargo','tree','--manifest-path',str(root/'.tmp/blob-pairs/0.18.0/drivers/syncular-rust/Cargo.toml'),'--locked','-e','features','-i','sha2@0.10.9'],text=True)
(out/'RUST-HASH-FEATURES.txt').write_text(features)
tracked=subprocess.check_output(['git','ls-files','src','services','stacks','drivers'],text=True).splitlines()
entries={}
def add(path,name):
 assert path.is_file(),path
 entries[name]=path
for name in tracked+['package.json','bun.lock']:
 add(root/name,'harness/'+name)
for path in (root/'scripts/blob-pairs').rglob('*'):
 if path.is_file() and '__pycache__' not in path.parts: add(path,'harness/'+str(path.relative_to(root)))
for kind,base in [('primary',root/'.tmp/blob-pairs'),('diagnostic',root/'.tmp/blob-pairs-diagnostics')]:
 for version in ['0.17.0','0.18.0']:
  env=base/version
  for name in tracked+['package.json','bun.lock']:
   add(env/name,f'{kind}/{version}/{name}')
  if kind=='diagnostic':
   for name in ['src/attachments/blob-probe.ts','sdk-timers.patch','instrumented-client/Cargo.toml']:
    add(env/name,f'{kind}/{version}/{name}')
   for path in (env/'instrumented-client/src').rglob('*'):
    if path.is_file():add(path,f'{kind}/{version}/'+str(path.relative_to(env)))
  else:
   package=env/'node_modules/@syncular/client'
   add(package/'package.json',f'released-js/{version}/package.json')
   for path in (package/'src').rglob('*'):
    if path.is_file():add(path,f'released-js/{version}/'+str(path.relative_to(package)))
registry=Path.home()/'.cargo/registry/src/index.crates.io-1949cf8c6b5b557f'
for version in ['0.17.0','0.18.0']:
 package=registry/f'syncular-client-{version}'
 for path in (package/'src').rglob('*'):
  if path.is_file():add(path,f'released-rust/{version}/'+str(path.relative_to(package)))
 add(package/'Cargo.toml',f'released-rust/{version}/Cargo.toml')
for name in ['Cargo.toml','src/sha256.rs','src/sha256/aarch64.rs']:
 add(registry/'sha2-0.10.9'/name,'sha2-0.10.9/'+name)
manifest={name:sha(path) for name,path in sorted(entries.items())}
with tarfile.open(out/'SOURCE.tar.gz','w:gz') as archive:
 for name,path in sorted(entries.items()):archive.add(path,arcname=name,recursive=False)
report=dict(capturedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),
 capture='Source capture after collection. Recorded release binary and lock hashes rechecked against pre-collection provenance; published manifest unchanged.',
 baseCommit=subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),baselineCommit='e55012a',
 publishedManifestSha256=p['publishedManifestSha256'],sourceArchiveSha256=sha(out/'SOURCE.tar.gz'),files=manifest,
 results={name:sha(out/name) for name in ['PAIRS.json','PLAN.json','DIAGNOSTICS.json','HASH-PAIRS.json','RUST-HASH-FEATURES.txt']})
(out/'SOURCE.json').write_text(json.dumps(report,indent=2)+'\n')
print('Archived',len(entries),'source files;', (out/'SOURCE.tar.gz').stat().st_size,'compressed bytes')
