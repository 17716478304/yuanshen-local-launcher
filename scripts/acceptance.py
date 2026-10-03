"""Real CN manifest and download acceptance. Credentials stay in process memory."""
import argparse
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
parser = argparse.ArgumentParser()
parser.add_argument('--download', action='store_true')
args = parser.parse_args()
project = Path(__file__).resolve().parent.parent
control = Path.home() / 'Library/Application Support/GenshinLocalLauncher'
root = control / 'data'
root.mkdir(parents=True, exist_ok=True)
(root / '.genshin-local-root').write_text('GenshinLocalLauncher\n')
(root / 'logs').mkdir(exist_ok=True)
# The real app owns this location too; never operate while its lock is held.
import fcntl
lock = (control / 'launcher.lock').open('w')
fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
with socket.socket() as s:
    s.bind(('127.0.0.1', 0)); port = s.getsockname()[1]
token = secrets.token_hex(32)
environment = dict(os.environ, SOPHON_TOKEN=token, SOPHON_PORT=str(port),
                   DATA_ROOT=str(root), CONTROL_ROOT=str(control), TERMINATE_WITH_PID=str(os.getpid()))
server_log = (root / 'logs/acceptance-server.log').open('w')
process = subprocess.Popen([str(project / 'sophon_server/.venv/bin/python'), str(project / 'sophon_server/server.py')],
                           cwd=root, env=environment, stdout=server_log, stderr=subprocess.STDOUT)
def request(path, body=None):
    req = urllib.request.Request(f'http://127.0.0.1:{port}'+path,
        headers={'Authorization': 'Bearer '+token, 'Content-Type':'application/json'},
        data=json.dumps(body).encode() if body is not None else None)
    # Explicitly bypass the system proxy for local services.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(req, timeout=120) as response:
        return json.load(response)
try:
    for _ in range(30):
        try: request('/health'); break
        except Exception: time.sleep(1)
    info = request('/api/game/online_info?game=hk4e&reltype=cn')
    (project / '.build-cache/live-manifest.json').write_text(json.dumps(info, ensure_ascii=False, indent=2))
    print(json.dumps(info, ensure_ascii=False), flush=True)
    if args.download:
        required = info['install_size'] + info['temporary_size'] + 5 * 1024**3
        if required > shutil.disk_usage(root).free:
            raise RuntimeError('Insufficient disk space for live acceptance')
        job = request('/api/install', {'gamedir':str(root/'game'), 'game_type':'hk4e','install_reltype':'cn'})
        print('Downloading full CN game; task '+job['task_id'], flush=True)
        while True:
            status = request('/api/tasks/'+job['task_id']+'/status')
            if status['status'] == 'completed':
                print('Full CN game download completed', flush=True); break
            if status['status'] in ('failed','cancelled'):
                raise RuntimeError(status.get('error'))
            time.sleep(10)
finally:
    process.terminate()
    try: process.wait(timeout=10)
    except subprocess.TimeoutExpired: process.kill(); process.wait()
    server_log.close()
