"""Verify locally built OCI indexes, every referenced blob and both target platforms."""
import hashlib
import json
import re
import tarfile
from pathlib import Path

root = Path(__file__).resolve().parent / '.build'
results = {}
for name in ('postgres-16', 'postgres-17', 'pgbouncer-1', 'redis-7'):
    platforms = set()
    checked = set()
    with tarfile.open(root / f'{name}.tar') as archive:
        def blob(descriptor):
            digest = descriptor['digest']
            assert re.fullmatch(r'sha256:[0-9a-f]{64}', digest), 'Invalid OCI digest'
            member = f'blobs/sha256/{digest.split(":")[1]}'
            if digest not in checked:
                source = archive.extractfile(member)
                assert source is not None, 'Missing OCI blob'
                actual = hashlib.sha256()
                while chunk := source.read(1024 * 1024):
                    actual.update(chunk)
                assert actual.hexdigest() == digest.split(':')[1], 'OCI blob checksum mismatch'
                checked.add(digest)
            return member

        def visit(descriptor):
            member = blob(descriptor)
            manifest = json.load(archive.extractfile(member))
            if 'manifests' in manifest:
                for child in manifest['manifests']:
                    visit(child)
            else:
                config = json.load(archive.extractfile(blob(manifest['config'])))
                for layer in manifest['layers']:
                    blob(layer)
                platform = f'{config.get("os")}/{config.get("architecture")}'
                if platform in ('linux/arm64', 'linux/amd64'):
                    assert config['config']['Labels']['fleet.db-build-test'] == 'true'
                    platforms.add(platform)

        index = json.load(archive.extractfile('index.json'))
        for descriptor in index['manifests']:
            visit(descriptor)
        assert platforms == {'linux/arm64', 'linux/amd64'}, 'Missing required image architecture'
        results[name] = {'index_digests': [item['digest'] for item in index['manifests']], 'platforms': sorted(platforms), 'verified_blobs': len(checked)}
print(json.dumps(results, indent=2))
