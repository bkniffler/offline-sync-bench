"""Independently recompute mixed-design headline rows from complete receipts and archived inputs."""
from pathlib import Path
import hashlib, json, re, tarfile, statistics
sha = lambda b: hashlib.sha256(b).hexdigest()
config = json.loads(Path('SUMMARY.json').read_text())
binding = config['largeFiles']; raw = Path(binding['path']).read_bytes(); root = Path(binding['path']).parent
assert sha(raw) == binding['sha256']
assert sha(Path('scripts/large-file-renderer.ts').read_bytes()) == binding['rendererSha256']
data = json.loads(raw)
assert data['kind'] == 'large-native-attachments' and data['sourceUnchanged']
assert data['version'] == 3 and 'trials' not in data, 'Mixed sampling cannot have one global n'
assert data['aggregation']['path'] == 'src/attachments/large-publication.ts'
assert sha(Path(data['aggregation']['path']).read_bytes()) == data['aggregation']['sha256']
fixture = data['fixture']; assert fixture['bytes'] == 500_000_000 and re.fullmatch('[0-9a-f]{64}', fixture['sha256'])

def verify_source(report, folder, version=None):
    source_raw = (folder / report['source']['path']).read_bytes()
    assert sha(source_raw) == report['source']['sha256']
    source = json.loads(source_raw)
    assert sha((folder / source['archive']).read_bytes()) == source['sha256']
    with tarfile.open(folder / source['archive']) as tar:
        for entry in source['files']:
            assert sha(tar.extractfile(entry['path']).read()) == entry['sha256']
        if version:
            package = json.loads(tar.extractfile('package.json').read())
            assert package['dependencies']['@syncular/client'] == package['dependencies']['@syncular/core'] == version
            driver = tar.extractfile('drivers/syncular-rust/src/main.rs').read().decode()
            assert '?.fetch_blob_bytes(transport, blob)?' in driver and '?.fetch_blob(transport, blob)?' not in driver
            lock = tar.extractfile('drivers/syncular-rust/Cargo.lock').read().decode()
            for crate in ['syncular-client', 'syncular-command', 'syncular-ffi']:
                assert f'name = "{crate}"\nversion = "{version}"' in lock
            for runtime in report['runtime']:
                version = runtime['version']; prefix = f'.tmp/blob-pairs/{version}/'
                assert runtime['package']['version'] == runtime['core'] == version
                assert sha(tar.extractfile(prefix+'bun.lock').read()) == runtime['lockSha256']
                assert sha(tar.extractfile(prefix+'drivers/syncular-rust/Cargo.lock').read()) == runtime['cargoLockSha256']
                assert re.fullmatch('[0-9a-f]{64}', runtime['binarySha256'])

def verify_receipt(result):
    assert result['status'] == 'completed'
    writer, fresh = result['phases']; id = result['stackId']
    assert writer['phase'] == 'writer' and fresh['phase'] == 'fresh'
    assert writer['pid'] != fresh['pid'] and writer['store'] != fresh['store']
    assert all(p['storeWasAbsent'] and p['taskCount'] == 50 for p in [writer, fresh])
    file = writer.get('file') or writer['files'][0]
    assert (file['bytes'], file['sha256']) == (fixture['bytes'], fixture['sha256'])
    assert (fresh['complete']['bytes'], fresh['complete']['sha256']) == (fixture['bytes'], fixture['sha256'])
    assert fresh['link']['task_id'] == file['taskId']
    if id == 'jazz-v2':
        assert fresh['before'] == {'fileCount': 0, 'partCount': 0}
        assert sum(file['partSizes']) == fixture['bytes'] and len(set(file['partIds'])) == len(file['partSizes'])
        assert fresh['link']['file_id'] == file['id']
    else:
        if id == 'powersync':
            assert fresh['before'] == {'queue': None, 'files': []}
            assert file['complete']['state'] == fresh['complete']['native']['state'] == 3
            assert file['complete']['hasSynced'] and fresh['complete']['native']['hasSynced']
        else:
            assert fresh['initialCacheCount'] == 0 and file['commitId'] in file['applied']
            assert file['ref']['blobId'] == 'sha256:' + fixture['sha256']
            assert json.loads(fresh['link']['blob']) == file['ref']
        transfer, = fresh['transfers']['attempts']
        assert transfer['status'] == 200 and transfer['completed'] and not transfer['interrupted']
        assert transfer['contentLength'] == transfer['forwardedBodyBytes'] == fixture['bytes']
    assert result['uploadMs'] == writer.get('stageMs', file.get('stageMs', 0)) + writer.get('uploadMs', file.get('uploadMs'))
    assert result['downloadMs'] == fresh['downloadMs']

selected = set(); receipts = 0
for collection in data['collections']:
    path = root / collection['path']; collection_raw = path.read_bytes()
    assert sha(collection_raw) == collection['sha256']
    report = json.loads(collection_raw)
    assert report['sourceUnchanged'] and report['fixture']['sha256'] == fixture['sha256'] and report['fixture']['bytes'] == fixture['bytes']
    paired = collection.get('kind') == 'controlled-client-release-pairs'
    verify_source(report, path.parent, report['candidate'] if paired else None)
    if paired:
        assert report['kind'] == 'syncular-blob-client-release-pairs' and report['finishedAt']
        assert report['baseline'] == '0.18.0' and report['candidate'] == report['serverVersion'] == '0.19.0'
        assert report['server'] == {'core': '0.19.0', 'server': '0.19.0'}
        expected = []
        for pair in range(1, 4):
            clients = ['syncular','syncular-rust'] if pair % 2 else ['syncular-rust','syncular']
            for client in clients:
                versions = ['0.19.0','0.18.0'] if (pair-1+(client=='syncular-rust')) % 2 else ['0.18.0','0.19.0']
                expected += [dict(pair=pair, client=client, version=version) for version in versions]
        assert report['plan'] == expected
        assert [{k:r[k] for k in ['pair','client','version']} for r in report['rows']] == expected
        stores = []
        for attempt in report['rows']:
            assert attempt['client'] == attempt['result']['stackId']
            verify_receipt(attempt['result']); receipts += 1
            stores += [p['store'] for p in attempt['result']['phases']]
        assert len(stores) == len(set(stores))
        assert sorted(collection['selectedStacks']) == ['syncular','syncular-rust']
    else:
        assert report['kind'] == 'large-native-attachments' and report['trials'] == 1
    for stack in collection['selectedStacks']:
        assert stack not in selected; selected.add(stack)
        published = next(r for r in data['rows'] if r['stackId'] == stack)
        if paired:
            attempts = [r['result'] for r in report['rows'] if r['client']==stack and r['version']=='0.19.0']
            assert len(attempts) == 3
            assert published == dict(stackId=stack, status='completed', **{metric:statistics.median(r[metric] for r in attempts) for metric in ['uploadMs','downloadMs']})
            assert data['sampling'][stack] == dict(trials=3, statistic='median', design='controlled alternating pairs', clientVersion='0.19.0', baselineVersion='0.18.0', pairs=[1,2,3])
        else:
            assert published == next(r for r in report['rows'] if r['stackId']==stack)
            if published['status'] == 'completed':
                verify_receipt(published); receipts += 1
            else:
                assert published['status'] in ['failed','timed-out'] and published.get('error')
                if published['status'] == 'timed-out': assert published['phases'][-1]['phaseElapsedMs'] >= published['phaseTimeoutMs']
            assert data['sampling'][stack] == dict(trials=1, statistic='single observation', design='retained single run')

assert selected == set(data['plan']['stacks']) == set(data['sampling']) == {'syncular','syncular-rust','powersync','jazz-v2'}
assert {id:design['trials'] for id,design in data['sampling'].items()} == {'syncular':3,'syncular-rust':3,'powersync':1,'jazz-v2':1}
assert len(data['rows']) == 4 and {r['stackId'] for r in data['rows']} == selected
labels = {'syncular':'Syncular JS','syncular-rust':'Syncular Rust','powersync':'PowerSync','turso':'Turso','zero':'Zero','electric':'Electric','electric-tanstack':'Electric + TanStack DB','jazz-v2':'Jazz v2 (experimental)'}
section = Path('README.md').read_text().split('### Uploading and downloading a 500 MB file\n')[1].split('\n### ')[0]
rows = [line for line in section.splitlines() if line.startswith('| ')][2:]
assert [r.split('|')[1].strip() for r in rows] == list(labels.values())
for row in rows:
    label, up, down = [v.strip() for v in row.split('|')[1:-1]]
    id = next(k for k,v in labels.items() if v == label)
    result = next((r for r in data['rows'] if r['stackId']==id), None)
    if result is None:
        assert all(c.startswith('Not supported \\*') for c in [up,down])
    elif result['status'] != 'completed':
        label = 'Timed out' if result['status'] == 'timed-out' else 'Failed'
        assert all(c.startswith(label + ' \\*') for c in [up,down])
    else:
        assert [re.sub(r' (\\\*)+$', '', c) for c in [up,down]] == [f"{result[k]:.2f} ms" for k in ['uploadMs','downloadMs']]
    for cell in [up,down]:
        star = re.search(r'(?:\\\*)+$', cell)
        if star: assert any(line.startswith(star.group()+' ') for line in section.splitlines())
assert 'Syncular JS/Rust 0.19.0' in section and 'medians of all three runs per client (n=3)' in section
assert 'PowerSync and Jazz retain single runs (n=1)' in section
assert 'excludes the final metadata-acceptance wait' in section and 'different stopping point from Syncular' in section
receipt = dict(status='verified', clientsAttempted=4, clientsCompleted=sum(r['status']=='completed' for r in data['rows']), readmeCells=16, rawReceiptsVerified=receipts,
               sampleCounts={id:design['trials'] for id,design in data['sampling'].items()},
               bytesPerFile=fixture['bytes'], sha256=fixture['sha256'], resultSha256=sha(raw), auditorSha256=sha(Path(__file__).read_bytes()))
Path('results/diagnostics/final-publication/LARGE-FILE-AUDIT.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps(receipt))
