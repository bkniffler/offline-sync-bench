"""Rebuild the publication failure index from the verified capture roster."""
import collections
import hashlib
import json
import os
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
CAPTURES = ROOT / 'results/diagnostics/publication-failure-captures'
PAGE = ROOT / 'results/diagnostics/publication-failure-captures/REPORT.md'
LEGACY = {10: 'publication-turso-conflict-setup-1', 16: 'publication-powersync-fanout-setup-1',
          27: 'publication-powersync-conflict-setup-1', 36: 'publication-powersync-reconnect-setup-1',
          39: 'publication-turso-fanout-spawn-1'}
sha = lambda b: hashlib.sha256(b).hexdigest()
verification_bytes = (CAPTURES / 'INTERIM-VERIFICATION.json').read_bytes()
verification = json.loads(verification_bytes)
entries = []
for check in verification['checks']:
    directory = CAPTURES / f"{check['index']:04d}"
    receipt_bytes = (directory / 'CAPTURE.json').read_bytes()
    if sha(receipt_bytes) != check['captureReceiptSha256']: raise ValueError('Capture receipt changed')
    receipt = json.loads(receipt_bytes)
    if receipt['sourceHash'] != verification['sourceHash'] or receipt['resultId'] != check['resultId']: raise ValueError('Capture identity changed')
    raw_names = [n for n in receipt['files'] if re.fullmatch(r'\d{4}-.+\.json', n)]
    if len(raw_names) != 1: raise ValueError('Missing or ambiguous raw result')
    raw_path = directory / raw_names[0]; raw = raw_path.read_bytes()
    if sha(raw) != receipt['rawSha256']: raise ValueError('Raw result changed')
    result = json.loads(raw)
    for key in ['resultId', 'stackId', 'scenarioId', 'status']:
        if result[key] != receipt[key]: raise ValueError('Raw identity changed')
    reviews = [p for p in [directory / 'INSPECTION.json', directory / 'VERIFICATION.json'] if p.is_file()]
    if not reviews and check['index'] in LEGACY:
        reviews = [ROOT / 'results/diagnostics' / LEGACY[check['index']] / 'INSPECTION.json']
    review_records = []
    for path in reviews:
        data = path.read_bytes(); review = json.loads(data)
        for key in ['sourceHash', 'resultId', 'resultDigest']:
            if review.get(key) != receipt[key]: raise ValueError('Stale inspection binding: ' + str(path))
        review_records.append({'path': path.relative_to(ROOT).as_posix(), 'sha256': sha(data)})
    entries.append({'index': check['index'], 'trial': receipt['trial'], 'stackId': receipt['stackId'],
                    'scenarioId': receipt['scenarioId'], 'status': receipt['status'], 'resultId': receipt['resultId'],
                    'resultDigest': receipt['resultDigest'], 'raw': raw_path.relative_to(ROOT).as_posix(),
                    'log': (directory / (raw_names[0] + '.log')).relative_to(ROOT).as_posix(),
                    'capture': (directory / 'CAPTURE.json').relative_to(ROOT).as_posix(), 'reviews': review_records})
if len({e['resultId'] for e in entries}) != len(entries): raise ValueError('Duplicate results')
entries.sort(key=lambda e: e['index'])
index = {'campaignId': verification['campaignId'], 'sourceHash': verification['sourceHash'],
         'verifiedAt': verification['verifiedAt'], 'verificationReceipt': verification,
         'verificationReceiptSha256': sha(verification_bytes), 'generatorSha256': sha(Path(__file__).read_bytes()),
         'scope': 'Only the failure captures in this verified roster. Successful and unavailable attempts are outside this index; counts are not product success rates. Later captures require verification and regeneration.', 'entries': entries}

def link(path, label):
    target = ROOT / path
    if not target.is_file() and target != CAPTURES / 'INDEX.json': raise ValueError('Missing linked artifact: ' + path)
    return f'[{label}]({Path(os.path.relpath(target, PAGE.parent)).as_posix()})'

groups = collections.defaultdict(list)
for e in entries: groups[(e['stackId'], e['scenarioId'])].append(e)
lines = ['# Historical publication failure evidence', '',
         'This index belongs to the withdrawn 2026-09-07 campaign. [Failure reviews from the corrected collection](./tuned-publication-failures.md) remain separate.', '',
         f"{len(entries)} captured failures verified through attempt {max(e['index'] for e in entries)}. Verification timestamp: {verification['verifiedAt']}.", '',
         'Counts cover this verified failure roster. Successful and unavailable attempts remain in the campaign; these counts are not success rates. A failed whole attempt supplies no latency estimate, even when a smaller subcase completed. Each inspection states its evidence and causal limits.', '',
         link('results/diagnostics/publication-failure-captures/INDEX.json', 'Machine-readable index and verification snapshot') + ' · ' + link('docs/history/README.md', 'Archived implementation notes'), '',
         '| Case | Failed | Invalid | Timed out | Inspection by attempt |',
         '| --- | ---: | ---: | ---: | --- |']
for (stack, scenario), group in sorted(groups.items()):
    counts = collections.Counter(e['status'] for e in group)
    reviews = [' / '.join(link(r['path'], str(e['index'])) for r in e['reviews']) if e['reviews'] else f"{e['index']}: inspection pending" for e in group]
    lines.append(f"| {stack}/{scenario} | {counts['failed']} | {counts['invalid']} | {counts['timed-out']} | {', '.join(reviews)} |")
lines += ['', '<details><summary>Raw result, log and capture receipt for every listed attempt</summary>', '',
          '| Attempt | Case | Trial | Outcome | Artifacts |', '| --- | --- | ---: | --- | --- |']
for e in entries:
    refs = ' · '.join(link(e[k], label) for k, label in [('raw', 'Raw'), ('log', 'Log'), ('capture', 'Capture')])
    lines.append(f"| {e['index']} | {e['stackId']}/{e['scenarioId']} | {e['trial']} | {e['status']} | {refs} |")
lines += ['', '</details>', '', 'Regenerate with `python3 scripts/index-publication-failures.py` after verifying new captures and adding their inspections. The generator refuses changed receipts, raw identities and stale inspection bindings.', '']
(CAPTURES / 'INDEX.json').write_text(json.dumps(index, indent=2) + '\n')
PAGE.write_text('\n'.join(lines))
print(json.dumps({'indexedFailures': len(entries), 'groups': len(groups), 'inspections': sum(len(e['reviews']) for e in entries)}))
