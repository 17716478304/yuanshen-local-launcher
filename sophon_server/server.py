import asyncio
import json
import os
from pathlib import Path
import secrets
import sys
import threading
import uuid

if __name__ == '__main__' and len(sys.argv) > 1 and sys.argv[1] == '--relaunch':
    import psutil, time, subprocess
    target = int(sys.argv[2])
    for _ in range(300):
        if not psutil.pid_exists(target):
            subprocess.Popen([str(Path(sys.argv[3]) / 'Contents/MacOS/parameterized')],
                             start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            sys.exit(0)
        time.sleep(.1)
    sys.exit('旧实例未退出，未重启')

# The same compiled binary bootstraps the app without requiring a system Python.
if __name__ == '__main__' and len(sys.argv) > 1 and sys.argv[1] == '--bootstrap':
    from storage import bootstrap
    try:
        sys.exit(bootstrap(sys.argv[2]))
    except Exception as error:
        import subprocess
        subprocess.run(['/usr/bin/osascript', '-e',
            'on run argv\ndisplay alert "原神本地启动器" message (item 1 of argv)\nend run', str(error)])
        sys.exit(1)

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from models import InstallRequest, RepairRequest, UpdateRequest, TaskResponse, TaskStatus
from tasks import perform_install, fetch_online_game_info
from utils import ConnectionManager, run_task_in_thread
import storage

TOKEN = os.environ.get('SOPHON_TOKEN', '')
ORIGIN = os.environ.get('SOPHON_ORIGIN', '')
if len(TOKEN) < 32:
    raise RuntimeError('SOPHON_TOKEN must contain at least 32 characters')
app = FastAPI(title='原神本地下载服务', docs_url=None, redoc_url=None)
app.add_middleware(CORSMiddleware, allow_origins=[ORIGIN] if ORIGIN else [],
                   allow_methods=['GET', 'POST', 'DELETE'], allow_headers=['Authorization', 'Content-Type'])
manager = None
tasks = {}
cancellations = {}
# ponytail: one writer and one Sophon OPT global; per-game concurrency only with isolated clients.
operation_lock = threading.Lock()
launch_active = False
restart_required = False
launch_completed = False
launch_started = 0.0
launch_watch_cancel = threading.Event()
launch_watch_thread = None
launch_window = {'has_window': None, 'auto_cleanup': False}

@app.middleware('http')
async def authenticate(request: Request, call_next):
    if request.method != 'OPTIONS':
        supplied = request.headers.get('authorization', '')
        if not secrets.compare_digest(supplied, 'Bearer ' + TOKEN):
            return JSONResponse({'detail': 'Unauthorized'}, status_code=401)
        origin = request.headers.get('origin')
        if origin and origin != ORIGIN:
            return JSONResponse({'detail': 'Origin denied'}, status_code=403)
    try:
        return await call_next(request)
    except (ValueError, OSError) as error:
        return JSONResponse({'detail': str(error)}, status_code=400)


def recovery_pending():
    from game_process import runtime_running
    return (storage.ROOT / '.storage/patched.neustorage').exists() or runtime_running(storage.ROOT)


def idle_lock(check_recovery=True):
    if restart_required:
        raise HTTPException(409, '存储位置已经切换，请重启启动器')
    if check_recovery and recovery_pending():
        raise HTTPException(409, '游戏进程或文件恢复未完成，请先清理残留')
    if launch_active or not operation_lock.acquire(blocking=False):
        raise HTTPException(409, '游戏或另一个任务正在运行')


def start_task(function, *args):
    idle_lock()
    task_id = uuid.uuid4().hex
    tasks[task_id] = TaskStatus(task_id=task_id, status='pending')
    cancellations[task_id] = threading.Event()
    def run():
        try:
            tasks[task_id].status = 'running'
            function(task_id, cancellations[task_id], *args)
            if cancellations[task_id].is_set():
                raise RuntimeError('任务已取消')
            tasks[task_id].status = 'completed'
        except Exception as error:
            tasks[task_id].status = 'cancelled' if cancellations[task_id].is_set() else 'failed'
            tasks[task_id].error = str(error)
            manager.send_message_threadsafe({'type': 'error', 'task_id': task_id, 'error': str(error)}, task_id)
        finally:
            operation_lock.release()
    threading.Thread(target=run, daemon=True).start()
    return TaskResponse(task_id=task_id, status='pending', message='Task started')


def safe_game(request):
    game = storage.game_path()
    if Path(request.gamedir).resolve() != game or request.game_type != 'hk4e':
        raise ValueError('只允许管理当前数据目录中的国服原神')
    game.mkdir(exist_ok=True)
    for base, dirs, files in os.walk(game, followlinks=False):
        for name in dirs + files:
            if (Path(base) / name).is_symlink():
                raise ValueError('游戏目录不允许符号链接')
    request.tempdir = str(game / '.tmp')
    if request.tempdir:
        (game / '.tmp').mkdir(exist_ok=True)
    return request

@app.post('/api/{task_type}')
async def game_operation(task_type: str, request: Request):
    body = await request.json()
    models = {'install': InstallRequest, 'repair': RepairRequest, 'update': UpdateRequest}
    if task_type not in models:
        raise HTTPException(404)
    model = models[task_type](**body)
    if getattr(model, 'install_reltype', 'cn') != 'cn':
        raise HTTPException(400, '只支持米哈游国服')
    if getattr(model, 'predownload', False):
        raise HTTPException(400, '首版不支持预下载')
    def operation(task_id, cancel):
        model_checked = safe_game(model)
        # CN differential updates are unimplemented upstream. Hash sync preserves valid files.
        req = InstallRequest(gamedir=model_checked.gamedir, game_type='hk4e',
                             install_reltype='cn', tempdir=model_checked.tempdir)
        perform_install(manager, tasks, task_id, req, cancel)
    return start_task(operation)

@app.get('/api/tasks/{task_id}/status')
async def task_status(task_id: str):
    if task_id not in tasks:
        raise HTTPException(404, 'Task not found; restart the operation to resume files')
    return tasks[task_id]

@app.delete('/api/tasks/{task_id}')
async def cancel_task(task_id: str):
    if task_id not in cancellations:
        raise HTTPException(404)
    cancellations[task_id].set()
    return {'message': '取消请求已发送，等待写入停止'}

@app.get('/api/game/online_info')
async def online_info(reltype: str = 'cn', game: str = 'hk4e'):
    if reltype != 'cn' or game != 'hk4e':
        raise HTTPException(400)
    idle_lock()
    try:
        result = await asyncio.to_thread(fetch_online_game_info, 'cn', 'hk4e')
        if result.error:
            raise HTTPException(502, result.error)
        return result
    finally:
        operation_lock.release()

@app.get('/api/network/proxy')
async def system_proxy():
    from urllib.request import getproxies
    from urllib.parse import urlparse
    value = getproxies().get('https', '')
    if value and urlparse(value).scheme not in ('http', 'https', 'socks5'):
        value = ''
    return {'proxy': value}

@app.get('/health')
async def health():
    return {'status': 'healthy'}

@app.get('/api/storage/state')
async def state():
    game = storage.game_path()
    config = game / 'config.ini'
    version = ''
    if config.is_file():
        import re
        match = re.search(r'game_version=(\d+\.\d+\.\d+)', config.read_text())
        version = match[1] if match else ''
    return {**storage.location(), 'game_dir': str(game), 'version': version,
            'installed': (game / 'YuanShen.exe').is_file() and version not in ('', '0.0.0'),
            'free_bytes': __import__('shutil').disk_usage(storage.ROOT).free,
            'busy': operation_lock.locked() or launch_active, 'restart_required': restart_required}

class PathRequest(BaseModel):
    destination: str

@app.post('/api/storage/migrate')
async def migration(request: PathRequest):
    def operation(task_id, cancel):
        global restart_required
        storage.migrate(request.destination, cancel)
        restart_required = True
    return start_task(operation)

@app.post('/api/storage/import')
async def import_game(request: PathRequest):
    def operation(task_id, cancel):
        source = Path(request.destination).resolve(strict=True)
        target = storage.game_path()
        if not (source / 'YuanShen.exe').is_file() or not (source / 'YuanShen_Data').is_dir():
            raise ValueError('请选择包含 YuanShen.exe 的米哈游国服目录')
        if (source / 'GenshinImpact.exe').exists() or (source / 'YuanShen_Data/Plugins/PCGameSDK.dll').exists():
            raise ValueError('不支持国际服或 Bilibili 渠道')
        for base, dirs, files in os.walk(source, followlinks=False):
            if any((Path(base) / name).is_symlink() for name in dirs + files):
                raise ValueError('导入目录不允许符号链接')
        if target.exists():
            raise ValueError('游戏目录已有文件，请先完成安装或修复')
        needed = sum((Path(base) / name).stat().st_size for base, _, files in os.walk(source) for name in files)
        if __import__('shutil').disk_usage(storage.ROOT).free < needed + 2 * 1024**3:
            raise ValueError('导入空间不足')
        stage = storage.ROOT / ('.import-' + uuid.uuid4().hex)
        try:
            storage.copy_verified(source, stage, cancel)
            stage.rename(target)
        finally:
            if stage.exists():
                __import__('shutil').rmtree(stage)
        perform_install(manager, tasks, task_id, InstallRequest(gamedir=str(target), game_type='hk4e',
                        install_reltype='cn', tempdir=str(target / '.tmp')), cancel)
    return start_task(operation)

@app.post('/api/storage/rollback')
async def rollback():
    global restart_required
    idle_lock()
    try:
        result = storage.rollback()
        restart_required = True
        return result
    finally:
        operation_lock.release()

@app.post('/api/storage/cleanup')
async def cleanup():
    def operation(task_id, cancel):
        storage.cleanup()
    return start_task(operation)

@app.post('/api/launch/{action}')
async def launch(action: str):
    global launch_active, launch_completed, launch_started, launch_watch_cancel, launch_watch_thread, launch_window
    if action == 'begin':
        idle_lock(check_recovery=False)
        launch_active = True
        launch_started = __import__('time').time()
        launch_completed = False
        operation_lock.release()
        from game_process import watch_exit
        launch_watch_cancel = threading.Event()
        launch_window = {'has_window': None, 'auto_cleanup': False}
        launch_watch_thread = threading.Thread(target=watch_exit,
            args=(storage.ROOT, launch_started, launch_watch_cancel, launch_window), daemon=True)
        launch_watch_thread.start()
    elif action in ('end', 'failed'):
        launch_watch_cancel.set()
        if launch_watch_thread:
            await asyncio.to_thread(launch_watch_thread.join, 8)
            if launch_watch_thread.is_alive():
                raise HTTPException(409, '退出监测尚未结束，请重试清理残留')
        if recovery_pending():
            raise HTTPException(409, '尚未结束游戏进程并恢复文件，保留运行互斥')
        launch_completed = action == 'end' and launch_active
        launch_active = False
    elif action == 'confirm':
        if not launch_completed or launch_active:
            raise HTTPException(409, '请先完成一次游戏启动并退出')
        info = storage.location()
        if info.get('previous_root'):
            info['launch_verified'] = True
            storage.atomic_json(storage.POINTER, info)
    else:
        raise HTTPException(400)
    return {'ok': True}

@app.get('/api/launch/window-state')
async def game_window_state():
    if not launch_active:
        raise HTTPException(409, '没有正在进行的游戏启动')
    if launch_window.get('cleanup_started') and launch_watch_thread and launch_watch_thread.is_alive():
        await asyncio.to_thread(launch_watch_thread.join, 18)
    return dict(launch_window)

@app.websocket('/ws/{task_id}')
async def websocket(websocket: WebSocket, task_id: str):
    if websocket.headers.get('origin') not in (None, ORIGIN):
        await websocket.close(code=1008)
        return
    await websocket.accept()
    try:
        auth = await asyncio.wait_for(websocket.receive_json(), 5)
        if not secrets.compare_digest(str(auth.get('token', '')), TOKEN) or task_id not in tasks:
            await websocket.close(code=1008)
            return
        manager.connect(task_id, websocket)
        while True:
            await websocket.receive_text()
    except (WebSocketDisconnect, asyncio.TimeoutError):
        pass
    finally:
        manager.disconnect(task_id)

@app.on_event('startup')
def startup():
    global manager
    manager = ConnectionManager(asyncio.get_event_loop())
    if os.environ.get('TERMINATE_WITH_PID'):
        import psutil, time, signal
        target = psutil.Process(int(os.environ['TERMINATE_WITH_PID']))
        created = target.create_time()
        def monitor():
            while True:
                try:
                    if not target.is_running() or target.create_time() != created:
                        raise psutil.NoSuchProcess(target.pid)
                except psutil.NoSuchProcess:
                    os.kill(os.getpid(), signal.SIGTERM)
                    return
                time.sleep(1)
        threading.Thread(target=monitor, daemon=True).start()

if __name__ == '__main__':
    import uvicorn
    uvicorn.run(app, host='127.0.0.1', port=int(os.environ.get('SOPHON_PORT', 8000)),
                workers=1, access_log=False)
