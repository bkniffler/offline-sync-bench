"""Verify reader links and Git inclusion without staging or modifying evidence."""
from collections import deque
from pathlib import Path
import hashlib
import json
import re
import subprocess

root = Path.cwd()
receipt = Path('results/diagnostics/final-publication/LINKS-AND-GIT.json')
queue = deque(map(Path, ['README.md', 'RESULTS.md', 'docs/methodology.md',
                        'docs/benchmarks.md', 'docs/reporting.md', 'docs/history/README.md']))
seen, missing = set(), []
# Check the entrypoint's deep links as well as the files they name.
readme_anchors = 0
for target in re.findall(r'\]\(([^)]+)\)', Path('README.md').read_text()):
    if target.startswith(('https:', 'http:', 'mailto:')) or '#' not in target:
        continue
    filename, anchor = target.split('#', 1)
    page = Path(filename or 'README.md')
    slugs, seen_slugs = set(), {}
    for heading in re.findall(r'^#+ (.+)$', page.read_text(), re.M):
        slug = re.sub(r'[^\w\- ]', '', heading.lower()).replace(' ', '-')
        suffix = seen_slugs.get(slug, 0)
        seen_slugs[slug] = suffix + 1
        slugs.add(slug if suffix == 0 else f'{slug}-{suffix}')
    assert anchor in slugs, f'Missing README anchor: {target}'
    readme_anchors += 1
while queue:
    path = queue.popleft().resolve()
    if path in seen:
        continue
    seen.add(path)
    if not path.exists():
        missing.append(str(path))
        continue
    if path.suffix != '.md':
        continue
    for target in re.findall(r'\]\(([^)]+)\)', path.read_text()):
        if target.startswith(('https:', 'http:', 'mailto:', '#')):
            continue
        target = target.split('#')[0].strip('<>')
        if not target or '<' in target:
            continue
        linked = (path.parent / target).resolve()
        if linked.suffix == '.md' or not linked.exists():
            queue.append(linked)
        else:
            seen.add(linked)
for source in json.loads(Path('SUMMARY.json').read_text())['sources']:
    seen.update(p.resolve() for p in Path(source['root']).rglob('*') if p.is_file())
for folder in ['results/diagnostics/final-publication', 'results/reports/tuned-v017-current',
               'results/reports/tuned-v017-zero-current']:
    seen.update(p.resolve() for p in Path(folder).rglob('*') if p.is_file())
seen.update((root / p).resolve() for p in ['scripts/audit-publication.ts', 'scripts/audit-publication-links.py',
                                        'scripts/audit-readme-tables.py', 'RESULTS.json', 'SUMMARY.json', 'COVERAGE.json', 'COVERAGE.md'])
paths = sorted(str(p.relative_to(root)) for p in seen if p.is_relative_to(root) and p.is_file())
checked = subprocess.run(['git', 'check-ignore', '--stdin'], input='\n'.join(paths) + '\n',
                         capture_output=True, text=True)
assert checked.returncode in (0, 1), checked.stderr
assert not checked.stdout, checked.stdout
assert not missing, missing
records = []
for name in paths:
    if name in [str(receipt)]:
        # Exclude this receipt from its own content hashes.
        records.append({'path': name, 'scope': 'Existence and Git inclusion only; audit/receipt cycle excluded from byte hashes.'})
    else:
        data = Path(name).read_bytes()
        records.append({'path': name, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
receipt.write_text(json.dumps({'status': 'verified',
    'scope': 'Recursive local Markdown targets from reader entrypoints, every component-package file, final receipts and current-result redirects. All exist and none are Git-ignored. README section anchors are verified; other pages are checked for file existence. This audit does not stage, commit or push.',
    'auditorSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
    'readmeAnchors': readme_anchors, 'files': records, 'missing': [], 'ignored': []}, indent=2) + '\n')
print(f'Verified {len(records)} linked and packaged files; none missing or Git-ignored.')
