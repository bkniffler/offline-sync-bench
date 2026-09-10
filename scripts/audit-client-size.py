"""Independently verify runtime receipts, captured assets and README size cells."""
from pathlib import Path
from urllib.parse import urlsplit
from decimal import Decimal, ROUND_HALF_UP
import base64
import gzip
import hashlib
import json
import re
import tarfile


def sha(data):
    return hashlib.sha256(data).hexdigest()


binding = json.loads(Path('SUMMARY.json').read_text())['clientSize']
assert sha(Path('scripts/client-size-renderer.ts').read_bytes()) == binding['rendererSha256']
path = Path(binding['path'])
raw = path.read_bytes()
assert sha(raw) == binding['sha256']
m = json.loads(raw)
root = path.parent
assert m['version'] == 2 and m['kind'] == 'browser-client-runtime-footprint'
for key, value in dict(builder='esbuild', target='es2022', format='esm', splitting=True,
                       minify=True, gzipLevel=9, unitBytes=1024).items():
    assert m['settings'][key] == value
expected = {'Syncular JS': 'syncular', 'Syncular Rust': None, 'PowerSync': 'powersync',
            'Turso': None, 'Zero': 'zero', 'Electric': 'electric',
            'Electric + TanStack DB': 'electric-tanstack', 'Jazz v2 (experimental)': 'jazz'}
assert {c['id'] for c in m['clients']} == {v for v in expected.values() if v}
assert len(m['clients']) == 6
source = m['source']
archive = (root / source['archive']).read_bytes()
assert [len(archive), sha(archive)] == [source['bytes'], source['sha256']]
with tarfile.open(root / source['archive']) as tar:
    members = [member for member in tar.getmembers() if member.isfile()]
    assert {member.name for member in members} == {i['path'] for i in source['inputs']}
    assert len(members) == len(source['inputs'])
    for item in source['inputs']:
        data = tar.extractfile(item['path']).read()
        assert [len(data), sha(data)] == [item['bytes'], item['sha256']]


def unpack(item):
    compressed = (root / item['archive']).read_bytes()
    data = gzip.decompress(compressed)
    # Different compressors can produce different valid streams; verify archived bytes.
    assert [len(compressed), sha(compressed), len(data), sha(data)] == [
        item['gzipBytes'], item['gzipSha256'], item['bytes'], item['sha256']]
    return data


asset_count = 0
for client in m['clients']:
    assert client['status'] == 'completed'
    assert client['persistent'] == (client['id'] != 'electric')
    assets = client['assets']
    paths = {a['path'] for a in assets}
    assert len(paths) == len(assets) == client['assetCount']
    assert all(a['category'] in ('core', 'storage') for a in assets)
    for category, field in [('core', 'core'), ('storage', 'storageAssets')]:
        selected = [a for a in assets if a['category'] == category]
        assert client[field] == dict(rawBytes=sum(a['bytes'] for a in selected), gzipBytes=sum(a['gzipBytes'] for a in selected))
    wasm_count = 0
    for asset in assets:
        data = unpack(asset)
        embedded = []
        assert asset['type'] == ('wasm' if asset['path'].endswith('.wasm') else 'javascript')
        if asset['type'] == 'wasm':
            assert data[:8] == b'\0asm\x01\0\0\0'
            wasm_count += 1
        else:
            assert asset['path'].endswith('.js')
            for encoded in re.findall(rb'data:application/wasm;base64,([A-Za-z0-9+/=]+)', data):
                wasm = base64.b64decode(encoded, validate=True)
                assert wasm[:8] == b'\0asm\x01\0\0\0'
                embedded.append(dict(bytes=len(wasm), sha256=sha(wasm)))
        assert embedded == asset['embeddedWasm']
        wasm_count += len(embedded)
    if client['id'] not in ('electric', 'zero'):
        assert wasm_count > 0
    if client['id'] == 'powersync':
        assert [a['path'] for a in assets if a['type'] == 'wasm'] == ['/wa-sqlite.wasm']
    assert [sum(a['bytes'] for a in assets), sum(a['gzipBytes'] for a in assets)] == [
        client['rawBytes'], client['gzipBytes']]
    receipt = json.loads(unpack(client['evidence']))
    assert receipt['id'] == client['id'] and receipt['status'] == 'completed'
    assert receipt['profileWasEmpty'] and receipt['cleanup']['allObservedAbsent']
    assert receipt['cleanup']['remaining'] == []
    assert receipt['verification'] == client['verification']
    write, reopen = receipt['verification']
    assert [write['phase'], reopen['phase']] == ['write', 'reopen']
    assert write['documentTimeOrigin'] != reopen['documentTimeOrigin']
    assert len(write['rows']) == 1 and write['rows'] == reopen['rows']
    if not client['id'].startswith('electric'):
        assert write['rows'] == [dict(id='task-1', title='footprint')]
    if client['id'] == 'electric-tanstack':
        assert reopen['serverReadsBlocked'] and write['offlineOutbox'] and reopen['offlineOutbox']
    assert receipt['browser']['version']['product'] == client['browserVersion']
    assert all(r['status'] == 200 for r in receipt['requests'])
    assert {r['path'] for r in receipt['requests']} == paths
    for asset in assets:
        captured = next(a for a in receipt['assets'] if a['path'] == asset['path'])
        assert all(captured[key] == asset[key] for key in ('bytes', 'gzipBytes', 'sha256', 'type'))
    network = json.loads(unpack(client['network']))
    urls = {e.get('params', {}).get('url', '') for e in network['events']}
    asset_urls = {u for u in urls if urlsplit(u).scheme in ('http', 'https')
                  and urlsplit(u).path.endswith(('.js', '.wasm'))}
    assert asset_urls == set(receipt['assetUrls'])
    origin = urlsplit(receipt['browser']['origin'])
    assert all((urlsplit(u).scheme, urlsplit(u).netloc) == (origin.scheme, origin.netloc)
               for u in asset_urls)
    assert {urlsplit(u).path for u in asset_urls} == paths
    asset_count += len(assets)

section = Path('README.md').read_text().split('### Browser client size\n')[1].split('\n## ')[0]
rows = [line for line in section.splitlines() if line.startswith('| ')][2:]
assert [re.sub(r' (?:\\\*)+$', '', r.split('|')[1].strip()) for r in rows] == list(expected)
for row in rows:
    label, core, storage, total = [v.strip() for v in row.split('|')[1:-1]]
    label = re.sub(r' (?:\\\*)+$', '', label)
    client_id = expected[label]
    if client_id:
        c = next(c for c in m['clients'] if c['id'] == client_id)
        def cell(value):
            format_kib = lambda n: (Decimal(n) / 1024).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
            return f"{format_kib(value['rawBytes'])}/{format_kib(value['gzipBytes'])} KiB"
        assert [core, storage, total] == [cell(c['core']), cell(c['storageAssets']), cell(c)]
    else:
        assert core == storage == total == 'Not applicable \\*'
assert 'in-memory, read-only' in section and 'embedded WASM' in section
result = dict(status='verified', clientsExecuted=len(m['clients']), artifacts=asset_count,
              readmeCells=24, manifestSha256=sha(raw), auditorSha256=sha(Path(__file__).read_bytes()))
Path('results/diagnostics/final-publication/CLIENT-SIZE-AUDIT.json').write_text(json.dumps(result, indent=2)+'\n')
print(json.dumps(result))
