"""Package committed source and its verified web build; never deploys or reads .env."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parent.parent


def git(*args):
    return subprocess.check_output(['git', '-c', f'safe.directory={ROOT.as_posix()}', *args], cwd=ROOT)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    output = args.out.resolve()
    receipt_path = output.with_suffix(output.suffix + '.json')
    sum_path = output.with_suffix(output.suffix + '.sha256')
    if any(p.exists() for p in [output, receipt_path, sum_path]):
        raise ValueError('Use a new output path; existing artifacts are never overwritten')
    if git('status', '--porcelain', '--untracked-files=normal').strip():
        raise ValueError('Candidate worktree must be committed and clean')
    commit = git('rev-parse', 'HEAD').decode().strip()
    build = json.loads((ROOT / 'runtime/release-v1/build.json').read_text(encoding='utf-8'))
    if build['commit'] != commit or build['tree'] != git('rev-parse', 'HEAD^{tree}').decode().strip():
        raise ValueError('Build receipt belongs to another commit/tree')
    if build['typecheck'] != 'PASS' or build['webBuild'] != 'PASS' or build['workspaceResolution'] != 'PASS':
        raise ValueError('Build checks have not passed')
    roots = ('apps/', 'packages/', 'scripts/', 'docs/')
    top = {'README.md', '.env.example', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.base.json', 'vitest.config.ts', '.gitattributes', '.gitignore'}
    payload = {}
    with zipfile.ZipFile(io.BytesIO(git('archive', '--format=zip', commit))) as source:
        for info in source.infolist():
            name = info.filename
            if info.is_dir() or not (name.startswith(roots) or name in top):
                continue
            parts = Path(name).parts
            if any(part in {'.git', 'node_modules', 'runtime', 'dist'} for part in parts) or any(part.startswith('.env') and part != '.env.example' for part in parts):
                raise ValueError(f'Unexpected source payload path: {name}')
            if name.startswith('/') or '..' in parts or '\\' in name or (info.external_attr >> 16) & 0o170000 == 0o120000:
                raise ValueError(f'Unsafe source path: {name}')
            payload[name] = source.read(info)
    if digest(payload['package-lock.json']) != build['packageLockSha256']:
        raise ValueError('Dependency lock differs from the build receipt')
    dist = ROOT / 'apps/web/dist'
    expected_dist = {entry['path']: entry for entry in build['files']}
    actual_dist = {p.relative_to(dist).as_posix(): p for p in dist.rglob('*') if p.is_file()}
    if actual_dist.keys() != expected_dist.keys():
        raise ValueError('Web file inventory differs from the build receipt')
    for name, path in actual_dist.items():
        data = path.read_bytes()
        entry = expected_dist[name]
        if len(data) != entry['bytes'] or digest(data) != entry['sha256']:
            raise ValueError(f'Web file changed after build: {name}')
        payload['apps/web/dist/' + name] = data
    identity = json.loads(payload['apps/web/dist/version.json'])
    if identity['commit'] != commit or identity['version'] != build['version']:
        raise ValueError('Web identity differs from source commit')
    manifest = {
        'schema': 'kontur.release-v1-package.v1', 'commit': commit, 'tree': build['tree'],
        'version': build['version'], 'node': build['node'], 'packageLockSha256': build['packageLockSha256'],
        'maxMigration': max(int(Path(n).name.split('_', 1)[0]) for n in payload if n.startswith('docs/migrations/') and n.endswith('.sql')),
        'requiresDependencies': True, 'installed': False, 'accepted': False,
        'sourceRoots': list(roots), 'sourceTopFiles': sorted(top),
        'files': [{'path': n, 'bytes': len(data), 'sha256': digest(data)} for n, data in sorted(payload.items())],
    }
    payload['RELEASE-MANIFEST.json'] = (json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode()
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as package:
        package.comment = commit.encode('ascii')
        for name, data in sorted(payload.items()):
            package.writestr(name, data)
    with zipfile.ZipFile(output) as package:
        if package.testzip() is not None or len(package.namelist()) != len(payload):
            raise ValueError('ZIP integrity check failed')
        for name, data in payload.items():
            if digest(package.read(name)) != digest(data):
                raise ValueError(f'ZIP readback mismatch: {name}')
    receipt = {
        'schema': 'kontur.release-v1-package-receipt.v1', 'commit': commit, 'tree': build['tree'],
        'version': build['version'], 'artifact': output.name, 'bytes': output.stat().st_size,
        'sha256': digest(output.read_bytes()), 'files': len(payload), 'integrity': 'PASS',
        'maxMigration': manifest['maxMigration'], 'installed': False, 'accepted': False,
    }
    receipt_path.write_text(json.dumps(receipt, indent=2) + '\n', encoding='utf-8')
    sum_path.write_text(receipt['sha256'] + '  ' + output.name + '\n', encoding='ascii')
    print(json.dumps(receipt, indent=2))


if __name__ == '__main__':
    main()
