"""Collect only expected native packages after every OS build succeeds."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess

version = json.loads(Path('package.json').read_text())['version']
destination = Path('release-assets')
destination.mkdir(exist_ok=False)
sources = list(Path('downloaded').rglob('*'))
for filename in [f'Orbit-{version}.AppImage', f'Orbit Setup {version}.exe',
                 f'Orbit-{version}-arm64-mac.zip', f'Orbit-{version}-mac.zip']:
    matches = [item for item in sources if item.is_file() and item.name == filename]
    if len(matches) != 1:
        raise RuntimeError(f'Expected exactly one native artifact: {filename}; found {len(matches)}')
    shutil.copy2(matches[0], destination / filename.replace(' ', '-'))
shutil.copy2('INSTALL.md', destination / 'INSTALL.md')
subprocess.run(['git', 'archive', '--format=zip', f'--prefix=orbit-desktop-{version}/',
                f'--output={destination / f"Orbit-{version}-source.zip"}', 'HEAD'], check=True)
checksums = []
for item in sorted(destination.iterdir()):
    with item.open('rb') as stream:
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    checksums.append(f'{digest}  {item.name}')
(destination / 'SHA256SUMS.txt').write_text('\n'.join(checksums) + '\n')
