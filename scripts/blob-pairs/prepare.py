"""Build two isolated harnesses against exact registry releases; no SDK source edits."""
from pathlib import Path
import subprocess, json, shutil, os
root=Path.cwd(); base=root/'.tmp/blob-pairs'
files=subprocess.check_output(['git','ls-files','src','services','stacks','drivers'],text=True).splitlines()
candidate=json.loads((root/'package.json').read_text())['dependencies']['@syncular/client']
baseline=os.environ.get('BLOB_PAIR_BASELINE','0.17.0')
baseline_ref={'0.17.0':'e55012a','0.18.0':'ab758ec'}[baseline]
assert candidate != baseline, 'Choose distinct client releases'
for version in [baseline,candidate]:
 dest=base/version;dest.mkdir(parents=True,exist_ok=True)
 for name in files:
  p=dest/name;p.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(root/name,p)
 for name in ['package.json','bun.lock']:
  (dest/name).write_bytes(subprocess.check_output(['git','show',f'{baseline_ref}:{name}']) if version==baseline else (root/name).read_bytes())
 if version==baseline:
  for name in ['drivers/syncular-rust/Cargo.toml','drivers/syncular-rust/Cargo.lock','drivers/syncular-rust/src/main.rs']:
   (dest/name).write_bytes(subprocess.check_output(['git','show',f'{baseline_ref}:{name}']))
 if version=='0.17.0':
  worker=dest/'src/attachments/large-syncular-worker.ts'
  worker.write_text(worker.read_text().replace("'fetch_blob_bytes'", "'fetch_blob'"))
 # Same candidate-version server is controlled by the parent harness. These package copies
 # are used only for client execution and are never used to rebuild services.
 subprocess.run(['bun','install','--frozen-lockfile'],cwd=dest,check=True)
 subprocess.run(['cargo','build','--release','--locked'],cwd=dest/'drivers/syncular-rust',check=True)
 print('Prepared',version,flush=True)
