"""Independently check README table values against current and retained raw trials."""
from pathlib import Path
import gzip
import hashlib
import json
import re
import statistics
import tarfile

sha = lambda b: hashlib.sha256(b).hexdigest()
config = json.loads(Path('SUMMARY.json').read_text())
coverage = json.loads(Path('COVERAGE.json').read_text())
metrics = [
 ('local-query', ['list_query_p50_ms', 'search_query_p50_ms', 'aggregate_query_p50_ms']),
 ('deep-relationship-query', ['detail_join_query_p50_ms', 'dashboard_query_p50_ms']),
 ('bootstrap', ['startup_warm_100000_first_screen_ms', 'startup_warm_100000_full_data_ms']),
 ('replica-reopen', ['reopen_first_screen_ms', 'reopen_all_rows_ms']),
 ('online-propagation', ['local_commit_p50_ms', 'server_accepted_p50_ms', 'mirror_visible_p50_ms']),
 ('offline-replay', ['queue_10_drain_ms', 'queue_10_mirror_visible_ms']),
 ('large-offline-queue', ['queue_100_mirror_visible_ms', 'queue_500_mirror_visible_ms', 'queue_1000_mirror_visible_ms']),
 ('offline-restart', ['queue_1000_reopen_local_ms', 'queue_1000_drain_ms', 'queue_1000_mirror_visible_ms']),
 ('conflict-update-update', ['all_clients_converged_ms']),
 ('conflict-update-delete', ['all_clients_converged_ms']),
 ('connected-fanout', ['clients_5_all_converged_ms', 'clients_25_all_converged_ms']),
 ('reconnect-storm', ['clients_5_all_converged_ms', 'clients_25_all_converged_ms']),
 ('permission-change', ['online_convergence_ms', 'offline_reconnect_convergence_ms']),
 ('blob-flow', ['initial_upload_ms', 'fresh_download_ms', 'download_interruption_recovery_ms']),
]
labels = {'Syncular JS': 'syncular', 'Syncular Rust': 'syncular-rust', 'PowerSync': 'powersync', 'Turso': 'turso',
          'Zero': 'zero', 'Electric': 'electric',
          'Electric + TanStack DB': 'electric-tanstack', 'Jazz v2 (experimental)': 'jazz-v2'}
exclusions={(e['stack'],e['scenario']):e for e in config['exclusions']}
assert set(exclusions)=={('electric',s) for s in ['online-propagation','offline-replay','large-offline-queue','offline-restart','conflict-update-update','conflict-update-delete','connected-fanout','reconnect-storm','blob-flow']} | {(s,'blob-flow') for s in ['turso','zero','electric-tanstack']}
groups = {}
selected_sources = {(c['stack'], c['scenario']): c['source'] for c in coverage['cases']}
for source in config['sources']:
    raw = gzip.decompress(Path(source['manifest']).read_bytes())
    assert sha(raw) == source['manifestSha256']
    for a in json.loads(raw)['attempts']:
        if selected_sources[a['stackId'], a['scenarioId']] != source['id']:
            continue
        groups.setdefault((a['stackId'], a['scenarioId']), []).append((a['trial'], a['result']))
history = next(s for s in coverage['sources'] if s['id'] == 'retained-history')
assert sha(Path(history['archive']).read_bytes()) == history['archiveSha256']
with tarfile.open(history['archive']) as archive:
    for c in coverage['cases']:
        if c['source'] != 'retained-history':
            continue
        key = (c['stack'], c['scenario'])
        assert key not in groups, 'Historical cases must never replace fresh cases'
        groups[key] = []
        for a in c['attempts']:
            raw = archive.extractfile(a['archiveMember']).read()
            assert sha(raw) == a['sha256']
            result = json.loads(raw)
            assert (result['resultId'], result['status']) == (a['resultId'], a['outcome'])
            groups[key].append((a['trial'], result))
timeout_review = json.loads(Path('results/diagnostics/final-publication/TIMEOUT-REVIEW.json').read_text())
assert timeout_review['coverageSha256'] == sha(Path('COVERAGE.json').read_bytes())
timeout_labels = {
    'cold-startup-deadline-confirmed; displayed-warm-case-not-reached': 'Not reached',
    'convergence-deadline-confirmed-with-divergent-client-snapshots': 'Did not converge',
    'native-cache-purge-deadline-confirmed': 'Purge timed out',
    'native-sync-deadline-during-setup; no-transfer-attempted': 'Setup timed out',
}
reviewed_labels = {r['resultId']: timeout_labels[r['classification']] for r in timeout_review['reviews']}
gap_bytes = Path(config['coverageReview']).read_bytes()
assert sha(gap_bytes) == config['coverageReviewSha256']
gap_review = json.loads(gap_bytes)
assert gap_review['coverageSha256'] == sha(Path('COVERAGE.json').read_bytes())
gap_labels = {(c['stack'], c['scenario']): c for c in gap_review['cases']}
page = Path('README.md').read_text()
sections = re.split(r'^### ', page, flags=re.M)[1:]
assert len(sections) == len(metrics) + (1 if config.get('clientSize') else 0)
latency_sections = sections[:len(metrics)]
if config.get('clientSize'):
    assert sections[-1].startswith('Client JavaScript size\n')
cells = timings = footnoted_cells = 0
for section, (scenario, keys) in zip(latency_sections, metrics):
    rows = [line for line in section.splitlines() if line.startswith('| ')][2:]
    assert [row.split('|')[1].strip() for row in rows] == list(labels)
    footnotes = dict(re.findall(r'^((?:\\\*)+) (.+)$', section, flags=re.M))
    used_markers = set()
    stacks = set()
    for row in rows:
        values = [v.strip() for v in row.split('|')[1:-1]]
        stack = labels[values[0]]
        assert stack not in stacks
        stacks.add(stack)
        trials = [r for _, r in sorted(groups[stack, scenario])]
        latest = trials[-1]
        eligible = latest['status'] == 'completed' and latest['metadata']['profile']['eligible']
        passed = [r for r in trials if r['status'] == 'completed']
        assert len({r['metadata']['profile']['comparisonKey'] for r in passed}) <= 1
        if scenario.startswith('conflict'):
            outcome = {'last-arriving-patch': 'A’s replayed edit retained', 'last-written-field': 'B’s edit retained',
                       'reject-stale-update': 'B’s edit retained', 'delete-retained': 'Deletion retained'}
            if (stack,scenario) in exclusions:
                assert values[1].startswith('Not supported')
            elif eligible:
                assert values[1] == outcome[latest['metadata']['policy']['outcome']]
        for metric, displayed in zip(keys, values[-len(keys):]):
            marker = re.search(r' ((?:\\\*)+)$', displayed)
            if marker:
                assert marker[1] in footnotes, (scenario, stack, 'Missing footnote', displayed)
                used_markers.add(marker[1])
                footnoted_cells += 1
                displayed = displayed[:marker.start()]
            if (stack,scenario) in exclusions:
                assert marker and displayed=='Not supported'
                assert footnotes[marker[1]]==exclusions[stack,scenario]['reason']
                cells+=1
                continue
            samples = [r['metrics'].get(metric) for r in passed]
            if eligible and samples and all(isinstance(v, (int, float)) for v in samples):
                median = statistics.median(samples)
                expected = f'{median:.3f}' if median < 1 else f'{median:.2f}'
                if median == 0 and metric.endswith('_query_p50_ms'):
                    for r in passed:
                        operations=sorted(r['metadata']['samples'][metric.removesuffix('_query_p50_ms')])
                        assert 0 <= operations[(len(operations)-1)//2] < 0.005
                    expected='<0.005'
                failed = any(r['status'] in ('failed', 'timed-out', 'invalid') for r in trials)
                single_run = selected_sources[stack, scenario] in ['coverage-fixes','native-files']
                if single_run:
                    assert len(trials) == 1 and 'n=1' in footnotes.get(marker[1] if marker else '', '')
                assert bool(marker) == (failed or single_run), (stack, scenario, 'Earlier failure needs a footnote')
                assert displayed == expected + ' ms', (stack, scenario, metric, displayed, expected)
                timings += 1
            else:
                assert marker, (stack, scenario, 'Missing result needs a footnote')
                if latest['status'] == 'timed-out':
                    assert displayed == reviewed_labels[latest['resultId']], (stack, scenario, displayed)
                elif latest['status'] == 'unsupported':
                    assert displayed == gap_labels[stack, scenario]['label'], (stack, scenario, displayed)
                elif latest['status'] == 'completed':
                    assert gap_labels[stack, scenario]['metric'] == metric
                    assert displayed == gap_labels[stack, scenario]['label'], (stack, scenario, displayed)
                assert not re.match(r'^\d', displayed), (stack, scenario, metric, displayed)
            cells += 1
    assert used_markers == set(footnotes), (scenario, 'Unused footnote')
receipt = {'status': 'verified', 'sections': len(sections), 'clientRows': 112, 'clientSizeRows': 8 if config.get('clientSize') else 0, 'cells': cells, 'numericalTimings': timings, 'footnotedCells': footnoted_cells,
           'currentAttempts': coverage['currentAttempts'], 'historicalAttempts': coverage['retainedAttempts'], 'readmeSha256': sha(page.encode()), 'auditorSha256': sha(Path(__file__).read_bytes())}
Path('results/diagnostics/final-publication/README-TABLE-AUDIT.json').write_text(json.dumps(receipt, indent=2) + '\n')
print(json.dumps(receipt))
