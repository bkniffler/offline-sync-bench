"""Check the large-file table against independent processes, byte receipts and archived inputs."""
from pathlib import Path
import hashlib, json, re, tarfile
sha = lambda b: hashlib.sha256(b).hexdigest()
config = json.loads(Path('SUMMARY.json').read_text())
binding = config['largeFiles']; raw = Path(binding['path']).read_bytes(); root = Path(binding['path']).parent
assert sha(raw) == binding['sha256']
assert sha(Path('scripts/large-file-renderer.ts').read_bytes()) == binding['rendererSha256']
data = json.loads(raw)
assert data['kind'] == 'large-native-attachments' and data['sourceUnchanged'] and data['trials'] == 1
fixture = data['fixture']; assert fixture['bytes'] == 500_000_000 and re.fullmatch('[0-9a-f]{64}', fixture['sha256'])
def verify_source(report, folder):
    source_raw = (folder / report['source']['path']).read_bytes()
    assert sha(source_raw) == report['source']['sha256']
    source = json.loads(source_raw)
    archive = (folder / source['archive']).read_bytes()
    assert sha(archive) == source['sha256']
    with tarfile.open(folder / source['archive']) as tar:
        for entry in source['files']:
            assert sha(tar.extractfile(entry['path']).read()) == entry['sha256']
        version = report.get('versions', {}).get('syncularClient')
        if version in ['0.18.0', '0.19.0']:
            package = json.loads(tar.extractfile('package.json').read())
            assert package['dependencies']['@syncular/client'] == version
            driver = tar.extractfile('drivers/syncular-rust/src/main.rs').read().decode()
            assert '?.fetch_blob_bytes(transport, blob)?' in driver and '?.fetch_blob(transport, blob)?' not in driver
            lock = tar.extractfile('drivers/syncular-rust/Cargo.lock').read().decode()
            for crate in ['syncular-client', 'syncular-command', 'syncular-ffi']:
                assert f'name = "{crate}"\nversion = "{version}"' in lock
            if version == '0.19.0':
                assert report['server'] == {'core': version, 'server': version}
                compare_raw = Path(report['comparison']['repositoryPath']).read_bytes()
                assert sha(compare_raw) == report['comparison']['sha256']
                paired = json.loads(compare_raw)
                assert paired['source'] == report['source'] and paired['sourceUnchanged']
                assert paired['candidate'] == version and paired['serverVersion'] == version
                assert paired['publicationSelection'].startswith('First candidate attempt per client (pair 1)')
                assert len(paired['rows']) == 12
                assert [(r['pair'],r['client'],r['version']) for r in paired['rows']] == [(r['pair'],r['client'],r['version']) for r in paired['plan']]
                baseline = paired.get('baseline', '0.17.0')
                assert baseline in ['0.17.0','0.18.0']
                for client in ['syncular','syncular-rust']:
                    for release in [baseline,version]:
                        assert {r['pair'] for r in paired['rows'] if r['client']==client and r['version']==release} == {1,2,3}
                    first = next(r['result'] for r in paired['rows'] if r['client']==client and r['version']==version and r['pair']==1)
                    assert next(r for r in report['rows'] if r['stackId']==client) == first

if data.get('collections'):
    selected = set()
    for collection in data['collections']:
        collection_path = root / collection['path']
        collection_raw = collection_path.read_bytes()
        assert sha(collection_raw) == collection['sha256']
        report = json.loads(collection_raw)
        assert report['sourceUnchanged'] and report['trials'] == 1
        assert report['fixture']['sha256'] == fixture['sha256'] and report['fixture']['bytes'] == fixture['bytes']
        verify_source(report, collection_path.parent)
        for stack in collection['selectedStacks']:
            assert stack not in selected
            selected.add(stack)
            assert next(r for r in data['rows'] if r['stackId'] == stack) == next(r for r in report['rows'] if r['stackId'] == stack)
    assert selected == set(data['plan']['stacks'])
else:
    verify_source(data, root)
labels = {'syncular':'Syncular JS','syncular-rust':'Syncular Rust','powersync':'PowerSync','turso':'Turso','zero':'Zero','electric':'Electric','electric-tanstack':'Electric + TanStack DB','jazz-v2':'Jazz v2 (experimental)'}
assert set(data['plan']['stacks']) == {'syncular','syncular-rust','powersync','jazz-v2'}
assert set(r['stackId'] for r in data['rows']) == set(data['plan']['stacks']) and len(data['rows']) == 4
section = Path('README.md').read_text().split('### Uploading and downloading a 500 MB file\n')[1].split('\n### ')[0]
rows = [line for line in section.splitlines() if line.startswith('| ')][2:]
assert [r.split('|')[1].strip() for r in rows] == list(labels.values())
completed = 0
for row in rows:
    label, up, down = [v.strip() for v in row.split('|')[1:-1]]
    id = next(k for k,v in labels.items() if v == label)
    result = next((r for r in data['rows'] if r['stackId'] == id), None)
    cells = [up, down]
    if result is None:
        assert all(c.startswith('Not supported \\*') for c in cells)
    elif result['status'] == 'completed':
        completed += 1
        writer, fresh = result['phases']
        assert writer['phase'] == 'writer' and fresh['phase'] == 'fresh'
        assert writer['pid'] != fresh['pid'] and writer['store'] != fresh['store']
        assert all(p['storeWasAbsent'] and p['taskCount'] == 50 for p in [writer,fresh])
        file = writer.get('file') or writer['files'][0]
        assert (file['bytes'], file['sha256']) == (fixture['bytes'], fixture['sha256'])
        assert (fresh['complete']['bytes'], fresh['complete']['sha256']) == (fixture['bytes'], fixture['sha256'])
        assert fresh['link']['task_id'] == file['taskId']
        if id == 'jazz-v2':
            assert fresh['before'] == {'fileCount':0,'partCount':0}
            assert sum(file['partSizes']) == fixture['bytes'] and len(set(file['partIds'])) == len(file['partSizes'])
            assert fresh['link']['file_id'] == file['id']
        else:
            if id == 'powersync':
                assert fresh['before'] == {'queue':None,'files':[]}
                assert file['complete']['state'] == fresh['complete']['native']['state'] == 3
                assert file['complete']['hasSynced'] and fresh['complete']['native']['hasSynced']
            else:
                assert fresh['initialCacheCount'] == 0 and file['commitId'] in file['applied']
                assert file['ref']['blobId'] == 'sha256:' + fixture['sha256']
                assert json.loads(fresh['link']['blob']) == file['ref']
            transfer, = fresh['transfers']['attempts']
            assert transfer['status'] == 200 and transfer['completed'] and not transfer['interrupted']
            assert transfer['contentLength'] == transfer['forwardedBodyBytes'] == fixture['bytes']
        assert result['uploadMs'] == writer.get('stageMs',file.get('stageMs',0)) + writer.get('uploadMs',file.get('uploadMs'))
        assert result['downloadMs'] == fresh['downloadMs']
        assert [re.sub(r' (\\\*)+$', '', c) for c in cells] == [f"{result[k]:.2f} ms" for k in ['uploadMs','downloadMs']]
    else:
        assert result['status'] in ['failed','timed-out'] and result.get('error')
        label = 'Timed out' if result['status'] == 'timed-out' else 'Failed'
        assert all(c.startswith(label + ' \\*') for c in cells)
        if result['status'] == 'timed-out':
            assert result['phases'][-1]['phaseElapsedMs'] >= result['phaseTimeoutMs']
    for cell in cells:
        star = re.search(r'(?:\\\*)+$', cell)
        if star:
            assert any(line.startswith(star.group() + ' ') for line in section.splitlines())
receipt = dict(status='verified', clientsAttempted=4, clientsCompleted=completed, readmeCells=16, bytesPerFile=fixture['bytes'], sha256=fixture['sha256'], resultSha256=sha(raw), auditorSha256=sha(Path(__file__).read_bytes()))
Path('results/diagnostics/final-publication/LARGE-FILE-AUDIT.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps(receipt))
