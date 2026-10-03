"""Real launch acceptance with the same instance lock as the app. Never handles login."""
import fcntl
import os
from pathlib import Path
import shutil
import subprocess
import sys
project = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(project / 'sophon_server'))
import storage
lock = (storage.CONTROL / 'launcher.lock').open('a')
fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
root = storage.checked_root(storage.location())
if not (root / 'game/YuanShen.exe').is_file() or 'game_version=0.0.0' in (root / 'game/config.ini').read_text():
    raise RuntimeError('Game installation is incomplete')
node = shutil.which('node')
if not node: raise RuntimeError('Node is required')
cli = subprocess.check_output([node, '-e', 'const p=require("path");console.log(p.join(p.dirname(require.resolve("vitest/package.json")),"../vite-node/vite-node.mjs"))'], cwd=project, text=True).strip()
environment = dict(os.environ, DATA_ROOT=str(root), LAUNCHER_ACCEPTANCE_LOCK=str(os.getpid()), LAUNCHER_ACCEPTANCE_PYTHON=sys.executable, YAAGL_CHANNEL_CLIENT='hk4ecn')
raise SystemExit(subprocess.call([node, cli, str(project / 'scripts/launch-acceptance.ts')], cwd=project, env=environment))
