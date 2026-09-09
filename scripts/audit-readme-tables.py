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
groups = {}
for source in config['sources']:
    raw = gzip.decompress(Path(source['manifest']).read_bytes())
    assert sha(raw) == source['manifestSha256']
    for a in json.loads(raw)['attempts']:
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
page = Path('README.md').read_text()
sections = re.split(r'^### ', page, flags=re.M)[1:]
assert len(sections) == len(metrics)
cells = timings = 0
for section, (scenario, keys) in zip(sections, metrics):
    rows = [line for line in section.splitlines() if line.startswith('| ')][2:]
    assert len(rows) == 8
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
            if eligible:
                assert values[1] == outcome[latest['metadata']['policy']['outcome']]
        for metric, displayed in zip(keys, values[-len(keys):]):
            samples = [r['metrics'].get(metric) for r in passed]
            if eligible and samples and all(isinstance(v, (int, float)) for v in samples):
                median = statistics.median(samples)
                expected = f'{median:.3f}' if median < 1 else f'{median:.2f}'
                failed = any(r['status'] in ('failed', 'timed-out', 'invalid') for r in trials)
                assert displayed == expected + ' ms' + (' *' if failed else ''), (stack, scenario, metric, displayed, expected)
                timings += 1
            else:
                assert not re.match(r'^\d', displayed), (stack, scenario, metric, displayed)
            cells += 1
receipt = {'status': 'verified', 'sections': len(sections), 'clientRows': 112, 'cells': cells, 'numericalTimings': timings,
           'currentAttempts': 174, 'historicalAttempts': 230, 'readmeSha256': sha(page.encode()), 'auditorSha256': sha(Path(__file__).read_bytes())}
Path('results/diagnostics/final-publication/README-TABLE-AUDIT.json').write_text(json.dumps(receipt, indent=2) + '\n')
print(json.dumps(receipt))
