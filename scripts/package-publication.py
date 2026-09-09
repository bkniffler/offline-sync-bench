"""Lossless publication packaging. Run the benchmark publication gate first."""
import argparse
import collections
import gzip
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import posixpath
import re
import shutil

FORMAT = 'benchmark-publication-archive-v1'
CHUNK = 1024 * 1024

def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for b in iter(lambda: f.read(CHUNK), b''): h.update(b)
    return h.hexdigest()

def safe(root, name):
    p = PurePosixPath(name)
    if not name or p.is_absolute() or str(p) != name or '..' in p.parts or '\\' in name:
        raise ValueError('Invalid archive path: ' + name)
    result = root.joinpath(*p.parts)
    if not result.resolve().is_relative_to(root.resolve()): raise ValueError('Escaping archive path')
    return result

def restore(source, destination):
    index = json.loads((source / 'ARCHIVE.json').read_text())
    if index['format'] != FORMAT: raise ValueError('Unknown archive format')
    names = set()
    for entry in index['files']:
        safe(source, entry['archive']); safe(destination, entry['path'])
        if entry['path'] in names: raise ValueError('Duplicate output path')
        names.add(entry['path'])
    if any(str(parent) in names for name in names for parent in PurePosixPath(name).parents if str(parent) != '.'):
        raise ValueError('Conflicting output paths')
    destination.mkdir(parents=True, exist_ok=False)
    for entry in index['files']:
        archived = safe(source, entry['archive'])
        if archived.stat().st_size != entry['compressedBytes'] or digest(archived) != entry['compressedSha256']:
            raise ValueError('Compressed artifact mismatch: ' + entry['path'])
        output = safe(destination, entry['path']); output.parent.mkdir(parents=True, exist_ok=True)
        h = hashlib.sha256(); size = 0
        with gzip.open(archived, 'rb') as inp, output.open('xb') as out:
            for b in iter(lambda: inp.read(CHUNK), b''): h.update(b); size += len(b); out.write(b)
        if size != entry['bytes'] or h.hexdigest() != entry['sha256']:
            raise ValueError('Restored artifact mismatch: ' + entry['path'])
        output.chmod(entry['mode'])
    return {'status': 'restored-and-verified', 'files': len(names)}

def pack(source, destination):
    if source == destination or destination.is_relative_to(source) or source.is_relative_to(destination):
        raise ValueError('Source and destination must be separate directories')
    manifest = json.loads((source / 'RESULTS.json').read_text())
    if manifest.get('status') != 'complete' or manifest.get('config', {}).get('purpose') != 'publication':
        raise ValueError('Only a completed publication can be packaged')
    if not manifest.get('plan') or len(manifest['attempts']) != len(manifest['plan']):
        raise ValueError('Publication attempt roster is incomplete')
    paths = sorted(source.rglob('*'))
    if any(p.is_symlink() for p in paths): raise ValueError('Publication contains a symlink')
    paths = [p for p in paths if p.is_file()]
    names = {p.relative_to(source).as_posix() for p in paths}
    if names & {'ARCHIVE.json', 'RESTORE.py', 'README-ARCHIVE.md'} or any(n.startswith('archive/') for n in names):
        raise ValueError('Reserved archive path in source')
    destination.mkdir(parents=True, exist_ok=False)
    files = []
    for p in paths:
        name = p.relative_to(source).as_posix(); archive = 'archive/files/' + name + '.gz'
        out = safe(destination, archive); out.parent.mkdir(parents=True, exist_ok=True)
        h = hashlib.sha256(); size = 0
        with p.open('rb') as inp, out.open('xb') as stream:
            with gzip.GzipFile(filename='', mode='wb', fileobj=stream, compresslevel=6, mtime=0) as zipped:
                for b in iter(lambda: inp.read(CHUNK), b''): h.update(b); size += len(b); zipped.write(b)
        files.append({'path': name, 'archive': archive, 'bytes': size, 'sha256': h.hexdigest(),
                      'compressedBytes': out.stat().st_size, 'compressedSha256': digest(out), 'mode': p.stat().st_mode & 0o777})
    mapping = {e['path']: e['archive'] if e['path'].endswith(('.json', '.log')) else e['path'] for e in files}
    for p in paths:
        name = p.relative_to(source).as_posix()
        if name.endswith(('.json', '.log')): continue
        output = safe(destination, name); output.parent.mkdir(parents=True, exist_ok=True)
        if name.endswith('.md'):
            def link(match):
                target = match.group(2)
                if re.match(r'^[a-z]+:', target, re.I) or target.startswith(('/', '#')): return match.group(0)
                path, sep, fragment = target.partition('#')
                resolved = posixpath.normpath(posixpath.join(posixpath.dirname(name), path))
                if resolved not in mapping: raise ValueError('Missing linked artifact: ' + name + ' -> ' + target)
                relative = posixpath.relpath(mapping[resolved], posixpath.dirname(name) or '.')
                return match.group(1) + relative + (sep + fragment if sep else '') + ')'
            output.write_text(re.sub(r'(\]\()([^\s)]+)\)', link, p.read_text()))
        else: shutil.copy2(p, output)
    index = {'format': FORMAT, 'campaignId': manifest['id'], 'files': files,
             'scope': 'Lossless packaging only. Benchmark contracts, provenance and reviewed annotations must pass publishCampaign before packaging.'}
    (destination / 'ARCHIVE.json').write_text(json.dumps(index, indent=2) + '\n')
    compact = {'schema': 'benchmark-publication-index-v1', 'campaignId': manifest['id'], 'status': 'complete',
               'attempts': len(manifest['attempts']), 'plannedAttempts': len(manifest['plan']),
               'outcomes': dict(collections.Counter(a['result']['status'] for a in manifest['attempts'])),
               'manifest': mapping['RESULTS.json'], 'artifacts': 'ARCHIVE.json', 'restoreInstructions': 'README-ARCHIVE.md'}
    (destination / 'RESULTS.json').write_text(json.dumps(compact, indent=2) + '\n')
    shutil.copy2(Path(__file__), destination / 'RESTORE.py')
    (destination / 'README-ARCHIVE.md').write_text('# Restoring the publication\n\nThe readable report links to compressed raw evidence. [The artifact index](./ARCHIVE.json) records original and compressed byte counts and SHA-256 digests. The root RESULTS.json is a compact index; the complete manifest is preserved in the archive.\n\nFrom this directory, restore the original publication into a new sibling directory:\n\n```sh\npython3 RESTORE.py restore . ../restored-publication\n```\n\nRestoration verifies every byte stream and preserves original paths, Markdown, reviewed annotations and file permissions. Regenerate the report from the restored RESULTS.json using the repository publication command. This packaging step does not replace the benchmark publication gate.\n')
    return {'status': 'packaged', 'files': len(files), 'rawBytes': sum(e['bytes'] for e in files), 'compressedBytes': sum(e['compressedBytes'] for e in files)}

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['pack', 'restore']); parser.add_argument('source', type=Path); parser.add_argument('destination', type=Path)
    args = parser.parse_args()
    print(json.dumps((pack if args.command == 'pack' else restore)(args.source.resolve(), args.destination.resolve())))
