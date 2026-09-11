"""Three alternating hash-only pairs. Build both binaries before running this."""
from pathlib import Path
import json,subprocess,hashlib,datetime,statistics
output=Path('.results/blob-pairs-diagnostic-2026-09-11/HASH-PAIRS.json')
assert not output.exists(),'Never overwrite a collection'
fixture=Path('.cache/attachments/500000000-2464173771ab7092.bin').resolve()
rows=[]
binaries={key:Path(f'.tmp/blob-pairs-hash-{key}/release/syncular-sha256-probe').resolve() for key in ['soft','accelerated']}
for pair in range(3):
 for variant in (['soft','accelerated'] if pair%2==0 else ['accelerated','soft']):
  row=json.loads(subprocess.check_output([str(binaries[variant]),str(fixture)]))
  rows.append(dict(pair=pair+1,variant=variant,**row));print(rows[-1],flush=True)
report=dict(kind='isolated-sha256-feature-comparison',finishedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),
 scope='Same sha2 0.10.9 algorithm/crate/input, default vs asm feature; file input outside timer, complete expected digest asserted on every run. Not an SDK or end-to-end benchmark.',
 binaries={k:dict(path=str(v),sha256=hashlib.sha256(v.read_bytes()).hexdigest()) for k,v in binaries.items()},
 lockSha256=hashlib.sha256(Path('scripts/blob-pairs/hash-probe/Cargo.lock').read_bytes()).hexdigest(),rows=rows)
output.write_text(json.dumps(report,indent=2)+'\n')
