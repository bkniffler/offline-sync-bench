"""Independently recompute the README sync-responsiveness cells from raw trials."""
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path
import hashlib
import json
import re
import statistics

sha = lambda b: hashlib.sha256(b).hexdigest()
binding = json.loads(Path('SUMMARY.json').read_text())['syncResponsiveness']
assert sha(Path('scripts/sync-responsiveness-renderer.ts').read_bytes()) == binding['rendererSha256']
raw = Path(binding['path']).read_bytes()
assert sha(raw) == binding['sha256']
report = json.loads(raw)
assert report['kind'] == 'sync-responsiveness' and report['sourceUnchanged'] is True
plan = report['plan']
labels = {'Syncular JS': 'syncular', 'Syncular Rust': None, 'PowerSync': 'powersync', 'Turso': None,
          'Zero': 'zero', 'Electric': 'electric', 'Electric + TanStack DB': 'electric-tanstack', 'Jazz v2 (experimental)': 'jazz'}

measured = [t for t in report['trials'] if t.get('condition') and t['label'] != 'warmup']
assert len(measured) == len(plan['stacks']) * len(plan['conditions']) * plan['trials']
for t in measured:
    if t['status'] != 'completed':
        continue
    v = t['validation']
    assert v['serverDigest'] == v['clientDigest'] and v['rows'] == plan['bootstrapRows'], t['stack']
    assert t['cleanup']['allObservedAbsent'] is True
    assert sum(r['inputs'] for r in t['records']) == v['keystrokes']
    for name in ['bootstrap', 'idle', 'catchup']:
        w = t['windows'][name]
        assert w['end'] > w['start'] and w['input_count'] > 0, (t['stack'], name)
    assert abs(t['windows']['bootstrap']['duration_ms'] - t['milestones']['bootstrapCompleteMs']) < 0.02
    assert abs(t['windows']['catchup']['duration_ms'] - t['milestones']['catchUpCompleteMs']) < 0.02
    if t['condition'] == 'low-priority':
        assert t['clampedProcesses'] and all(p['type'] != 'GPU' for p in t['clampedProcesses'])
    else:
        assert t['clampedProcesses'] == []


def fixed(value, places):
    return str(Decimal(value).quantize(Decimal(1).scaleb(-places), rounding=ROUND_HALF_UP))


def ms(value):
    return f"{fixed(value, 0 if value >= 100 else 1 if value >= 10 else 2)} ms"


def pct(value):
    return f"{fixed(value, 0 if value >= 10 else 1)}%"


def group(stack, condition):
    trials = [t for t in measured if t['stack'] == stack and t['condition'] == condition]
    done = [t for t in trials if t['status'] == 'completed']
    return trials, done


def med(done, path):
    values = []
    for t in done:
        value = t
        for key in path.split('.'):
            value = value[key]
        values.append(value)
    return statistics.median(values)


def suffix(trials, done):
    failed = len(trials) - len(done)
    return '' if len(done) == plan['trials'] and not failed else f" (n={len(done)}{f', {failed} failed' if failed else ''})"


page = Path('README.md').read_text()
section = page.split('### Staying responsive while syncing\n', 1)[1].split('\n### ', 1)[0].split('\n## ', 1)[0]
tables = re.findall(r'((?:^\|.*\|\n)+)', section, flags=re.M)
assert len(tables) == 2
cells = 0
for table, condition in zip(tables, ['default', 'low-priority']):
    rows = [line for line in table.strip().splitlines()][2:]
    assert len(rows) == len(labels)
    for row, (label, stack) in zip(rows, labels.items()):
        values = [v.strip() for v in row.split('|')[1:-1]]
        trials, done = group(stack, condition) if stack else ([], [])
        if not done:
            assert stack in (None, 'jazz') and values[0] == label, values
            assert all(v.startswith('Not applicable') or v.startswith('Not measured') for v in values[1:]), values
            continue
        assert values[0] == label + suffix(trials, done), (values[0], label)
        if condition == 'default':
            expected = [ms(med(done, 'milestones.bootstrapCompleteMs')), ms(med(done, 'windows.bootstrap.input_latency_p95_ms')), pct(med(done, 'windows.bootstrap.blocking_pct')),
                        ms(med(done, 'windows.bootstrap.longest_frame_ms')), ms(med(done, 'milestones.catchUpCompleteMs')), ms(med(done, 'windows.catchup.input_latency_p95_ms')), pct(med(done, 'windows.catchup.blocking_pct'))]
        else:
            _, base = group(stack, 'default')
            slowdown = f"{fixed(med(done, 'calibration.mainMs') / med(base, 'calibration.mainMs'), 1)}×/{fixed(med(done, 'calibration.workerMs') / med(base, 'calibration.workerMs'), 1)}×"
            expected = [slowdown, ms(med(done, 'milestones.bootstrapCompleteMs')), ms(med(done, 'windows.bootstrap.input_latency_p95_ms')),
                        ms(med(done, 'milestones.catchUpCompleteMs')), ms(med(done, 'windows.catchup.input_latency_p95_ms'))]
        assert values[1:] == expected, (label, condition, values[1:], expected)
        cells += len(expected)
print(json.dumps({'status': 'verified', 'trials': len(measured), 'completed': sum(t['status'] == 'completed' for t in measured), 'cells': cells}))
