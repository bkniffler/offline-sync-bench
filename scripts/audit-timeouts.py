"""Review every timed-out attempt selected for the README, without rerunning workloads."""
from pathlib import Path
import base64
import gzip
import hashlib
import json
import tarfile

sha = lambda b: hashlib.sha256(b).hexdigest()
coverage = json.loads(Path('COVERAGE.json').read_text())
config = json.loads(Path('SUMMARY.json').read_text())
history = next(s for s in coverage['sources'] if s['id'] == 'retained-history')
assert sha(Path(history['archive']).read_bytes()) == history['archiveSha256']
selected = {(c['stack'], c['scenario']): c['source'] for c in coverage['cases']}
inputs = []
source_checks = []

def check_source(snapshot, path, fragments):
    raw = base64.b64decode(snapshot['contents'][path])
    assert sha(raw) == snapshot['files'][path]['sha256']
    text = raw.decode()
    assert all(fragment in text for fragment in fragments), path
    source_checks.append({'sourceHash': snapshot['sourceHash'], 'path': path, 'sha256': sha(raw)})

with tarfile.open(history['archive']) as archive:
    manifest = json.load(archive.extractfile(next(n for n in archive.getnames() if n.endswith('/CAMPAIGN.json'))))
    raw = archive.extractfile(next(n for n in archive.getnames() if n.endswith('/SOURCE.json'))).read()
    assert sha(raw) == manifest['source']['snapshot']['sha256']
    snapshot = json.loads(raw)
    check_source(snapshot, 'src/recovery/startup-observer.ts', ['at() >= timeoutMs', 'Startup observation timed out'])
    check_source(snapshot, 'src/recovery/worker.ts', ['performance.now() + 90_000', 'Recovery reader observation timed out'])
    check_source(snapshot, 'src/access/jazz-run.ts', ['performance.now()+60_000', 'Jazz native access purge timed out'])
    check_source(snapshot, 'src/recovery/conflicts.ts', ['gate.restore()', 'evidence.failureSnapshots ='])
    for c in coverage['cases']:
        if c['source'] != 'retained-history':
            continue
        for a in c['attempts']:
            if a['outcome'] != 'timed-out':
                continue
            raw = archive.extractfile(a['archiveMember']).read()
            assert sha(raw) == a['sha256']
            log = archive.extractfile(a['archiveMember'] + '.log').read()
            inputs.append((a['trial'], json.loads(raw), {'archive': history['archive'], 'member': a['archiveMember'], 'sha256': sha(raw), 'logBytes': len(log), 'logSha256': sha(log)}))

for source in config['sources']:
    manifest_raw = gzip.decompress(Path(source['manifest']).read_bytes())
    assert sha(manifest_raw) == source['manifestSha256']
    manifest = json.loads(manifest_raw)
    index = json.loads((Path(source['root']) / 'ARCHIVE.json').read_text())
    files = {f['path']: f for f in index['files']}
    for a in manifest['attempts']:
        r = a['result']
        if selected[a['stackId'], a['scenarioId']] != source['id'] or r['status'] != 'timed-out':
            continue
        item = files[a['resultFile']]
        raw = gzip.decompress((Path(source['root']) / item['archive']).read_bytes())
        assert sha(raw) == item['sha256'] and json.loads(raw) == r
        log_item = files[a['resultFile'] + '.log']
        log = gzip.decompress((Path(source['root']) / log_item['archive']).read_bytes())
        assert sha(log) == log_item['sha256']
        inputs.append((a['trial'], r, {'archive': str(Path(source['root']) / item['archive']), 'sha256': sha(raw), 'logBytes': len(log), 'logSha256': sha(log)}))

reviews = []
for trial, result, provenance in inputs:
    stack, scenario = result['stackId'], result['scenarioId']
    evidence = result['metadata'].get('evidence', {})
    review = {'stack': stack, 'scenario': scenario, 'trial': trial, 'resultId': result['resultId'], 'recordedStatus': result['status'], 'durationMs': result['durationMs'], 'provenance': provenance}
    if (stack, scenario) == ('jazz-v2', 'bootstrap'):
        assert evidence['stage'] == 'process-cold-100000'
        observation = evidence['currentCase']['failure']['startupObservation']
        assert observation['timeoutMs'] == 90000 and observation['elapsedMs'] >= 90000
        assert not observation['firstScreen'] and not observation['fullData'] and not observation['syncFinished']
        last_count = observation['countQueries'][-1]
        assert 0 < last_count['rows'] < 100000
        assert [(c['count'], c['condition']) for c in evidence['cases']] == [(1000, 'process-cold'), (1000, 'warm'), (10000, 'process-cold'), (10000, 'warm')]
        review.update(classification='cold-startup-deadline-confirmed; displayed-warm-case-not-reached', deadlineMs=90000, elapsedMs=observation['elapsedMs'], lastCount=last_count, warm100000Attempted=False,
                      limitation='Incomplete materialization is confirmed; the contribution of native transport, query overhead and retained storage is not isolated.')
    elif (stack, scenario) == ('jazz-v2', 'conflict-update-delete'):
        assert result['notes'] == ['Recovery reader observation timed out'] and evidence['stage'] == 'resolution'
        assert evidence['peerAcceptedBeforeReconnect'] and evidence['writerOutcome']['pending'] == 0
        states = {s['role']: s['state'] for s in evidence['failureSnapshots']}
        targets = {}
        for role, state in states.items():
            assert state['pending'] == 0 and state['rejected'] == 0
            targets[role] = [r for r in state['rows'] if r['id'] == 'org-1-project-1-task-000001']
        assert len(targets['writer']) == 1 and targets['writer'][0]['title'] == 'conflict-offline-writer'
        assert not targets['peer'] and not targets['observer']
        receipts = states['writer']['nativeState']['receipts']
        assert all(r['local'] == r['edge'] == 'success' for r in receipts)
        review.update(classification='convergence-deadline-confirmed-with-divergent-client-snapshots', deadlineMs=90000, targetByClient=targets,
                      limitation='Deadline throw site and post-failure snapshots establish disagreement. No per-observation elapsed receipt or transport trace identifies the underlying cause; the expected native deletion policy remains unverified.')
    elif (stack, scenario) == ('jazz-v2', 'permission-change'):
        modes = []
        for c in result['metadata']['cases']:
            assert c['purgeFailure']['reason'] == 'Error: Jazz native access purge timed out'
            assert c['observationMs'] >= 60000
            counts = lambda key: {k: len(c[key][k]) for k in ['cachedRows', 'viewRows', 'subscriptionRows']}
            final = counts('finalCache')
            assert final == {'cachedRows': 1000, 'viewRows': 500 if c['mode'] == 'online' else 1000, 'subscriptionRows': 500 if c['mode'] == 'online' else 1000}
            assert set(counts('freshActorCache').values()) == {500}
            assert set(counts('unaffectedActorCache').values()) == {1000}
            modes.append({'mode': c['mode'], 'elapsedMs': c['observationMs'], 'finalRows': final, 'freshAuthorizedRows': 500, 'unaffectedRows': 1000})
        review.update(classification='native-cache-purge-deadline-confirmed', deadlineMs=60000, modes=modes,
                      limitation='Online scoped queries removed revoked rows, while raw cached rows remained. Reconnected views also remained stale. Fresh-client authorization passed. This establishes failure of the tested purge contract, not failure of all authorization or a proven product root cause.')
    elif (stack, scenario) == ('syncular-rust', 'blob-flow'):
        assert 'realtime sync round timed out' in result['notes'][0]
        assert evidence['cases'] == [] and 'initial' not in evidence and len(evidence['clients']) == 2
        assert evidence['clients'][1]['clientId'] in result['notes'][0]
        assert evidence['metrics'] == {'blob_size_bytes': 2097152}
        review.update(classification='native-sync-deadline-during-setup; no-transfer-attempted', deadlineMs=30000, uploadVariantsStarted=0,
                      limitation='Native deadline error is recorded, but no per-round elapsed receipt or WebSocket frame trace proves the cause. A harness session-readiness race remains possible; this is not a validated attachment performance timeout.')
    else:
        raise AssertionError(f'Unreviewed timeout: {stack}/{scenario}/{trial}')
    reviews.append(review)

assert len(reviews) == sum(a['outcome'] == 'timed-out' for c in coverage['cases'] for a in c['attempts'])
native_source = Path('results/diagnostics/tuned-v017-publication-failures/campaign-2026-09-08T22-58-56-419Z/0030/source-3-native_transport.rs.txt')
inspection = json.loads((native_source.parent / 'INSPECTION.json').read_text())
assert sha(native_source.read_bytes()) == next(s['sha256'] for s in inspection['sourceInspection'] if s['copy'] == native_source.name)
native = native_source.read_text()
assert 'Duration::from_secs(30)' in native and 'if now >= deadline' in native and 'realtime sync round timed out' in native
source_checks.append({'path': str(native_source), 'sha256': sha(native_source.read_bytes())})
receipt = {'scope': f'All {len(reviews)} timed-out attempts selected by current COVERAGE.json, including retained Jazz results; superseded PowerSync attempts remain covered by the existing maintenance investigation.', 'method': 'Archived raw results, captured logs, checksum-verified deadline source and final snapshots; no benchmark reruns or raw status changes.', 'coverageSha256': sha(Path('COVERAGE.json').read_bytes()), 'sourceChecks': source_checks, 'reviews': reviews, 'auditorSha256': sha(Path(__file__).read_bytes())}
Path('results/diagnostics/final-publication/TIMEOUT-REVIEW.json').write_text(json.dumps(receipt, indent=2) + '\n')
print(f'Reviewed {len(reviews)} timeout attempts across selected cases; raw outcomes preserved.')
