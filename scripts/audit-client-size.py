"""Verify bundle bytes and README size cells independently of the TypeScript renderer."""
from pathlib import Path
import gzip,hashlib,json,re
sha=lambda b:hashlib.sha256(b).hexdigest()
config=json.loads(Path('SUMMARY.json').read_text()); binding=config['clientSize']; path=Path(binding['path'])
assert sha(Path('scripts/client-size-renderer.ts').read_bytes())==binding['rendererSha256']
raw=path.read_bytes();assert sha(raw)==binding['sha256']; m=json.loads(raw);root=path.parent
assert m['kind']=='browser-client-javascript-size'
assert m['settings']==dict(target='browser',format='esm',minify=True,splitting=True,sourcemap='none',gzipLevel=9,unitBytes=1024)
expected={'Syncular JS':'syncular-client-root-named','Syncular Rust':None,'PowerSync':'powersync-minimal','Turso':None,'Zero':'zero-minimal','Electric':'electric-minimal','Electric + TanStack DB':'electric-tanstack-combo','Jazz v2 (experimental)':'jazz-v2-minimal'}
assert {r['id'] for r in m['rows']}=={v for v in expected.values() if v}
seen=set()
for a in m['artifacts']:
 assert a['path'] not in seen;seen.add(a['path'])
 zipped=(root/a['path']).read_bytes();data=gzip.decompress(zipped)
 assert [len(zipped),sha(zipped),len(data),sha(data)]==[a['gzipBytes'],a['gzipSha256'],a['bytes'],a['sha256']]
 # Validate the actual downloadable bytes above. Python and Bun can produce
 # different valid DEFLATE streams at level 9, so recompression is not canonical.
for i in m['inputs']:assert sha(gzip.decompress((root/i['archive']).read_bytes()))==i['sha256']
for e in m['entries']:assert 'export {' in e['source'] and '.length' not in e['source']
for r in m['rows']:
 assert r['status']=='completed' and r['profile']=='named-import'
 artifacts=[a for a in m['artifacts'] if a['target']==r['id']]
 assert [sum(a['bytes'] for a in artifacts),sum(a['gzipBytes'] for a in artifacts),len(artifacts)]==[r['rawBytes'],r['gzipBytes'],r['artifactCount']]
section=Path('README.md').read_text().split('### Client JavaScript size\n')[1].split('\n## ')[0]
rows=[line for line in section.splitlines() if line.startswith('| ')][2:]
assert [r.split('|')[1].strip() for r in rows]==list(expected)
for row in rows:
 label,minified,zipped=[v.strip() for v in row.split('|')[1:-1]];id=expected[label]
 if id:
  r=next(r for r in m['rows'] if r['id']==id)
  assert [minified,zipped]==[f"{r[k]/1024:.2f} KiB" for k in ['rawBytes','gzipBytes']]
 else:assert minified==zipped=='Not applicable \\*'
assert '\\* Syncular Rust and Turso use native clients' in section
assert 'JavaScript only' in section and 'WASM' in section
result=dict(status='verified',clientsBuilt=len(m['rows']),artifacts=len(seen),readmeCells=16,manifestSha256=sha(raw),auditorSha256=sha(Path(__file__).read_bytes()))
Path('results/diagnostics/final-publication/CLIENT-SIZE-AUDIT.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result))
