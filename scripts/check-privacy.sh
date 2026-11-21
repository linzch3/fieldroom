#!/bin/sh
# Inspect the Git index, including the initial commit before HEAD exists.
set -eu
cd "$(git rev-parse --show-toplevel)"
python3 - <<'PY'
import re
import subprocess
from pathlib import PurePosixPath

paths = subprocess.check_output(['git','ls-files','-z']).decode().split('\0')
bad = []
for name in filter(None, paths):
    path = PurePosixPath(name)
    blocked = {'data','private','work','.venv','.qa','node_modules','__pycache__','test-results'}
    if (blocked.intersection(path.parts) or path.name.startswith('.env')
            or re.search(r'\.(?:sqlite\d*|db)(?:-.*)?$|\.(?:log|pem|key)$', name)):
        bad.append(name)
        continue
    data = subprocess.check_output(['git','show',':'+name])
    if b'\x00' in data:
        if not name.startswith('docs/') or path.suffix != '.png':
            bad.append(name)
        continue
    signals = [
        rb'/(?:play|manage)#[A-Za-z0-9_-]{20,}',
        rb'(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}',
        rb'-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----',
        rb'/Users/[^/\s]+/(?:Documents|code)/',
    ]
    if any(re.search(signal, data) for signal in signals):
        bad.append(name)
if bad:
    raise SystemExit('Please review staged paths: '+', '.join(bad))
print('Public-source privacy check passed.')
PY
