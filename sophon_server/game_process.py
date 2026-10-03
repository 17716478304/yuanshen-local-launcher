"""Read only the current launch's game window state; never terminate processes here."""
from pathlib import Path
import subprocess
import psutil
import re
import os
import threading
import logging
import time
import json
from datetime import datetime


def quit_requested(root: Path, started: float):
    """Use only a timestamped engine quit event from this launch's owned log."""
    path = root / 'wineprefix/drive_c/users/crossover/AppData/LocalLow/miHoYo/原神/output_log.txt'
    try:
        with path.open('rb') as stream:
            stream.seek(max(0, path.stat().st_size - 65536))
            tail = stream.read().decode('utf-8', errors='replace')
        for timestamp in re.findall(r'^\[([^\]]+)\] OnApplicationQuit\s*$', tail, re.MULTILINE):
            if datetime.fromisoformat(timestamp).timestamp() >= started:
                return True
    except (OSError, ValueError):
        pass
    return False


def record_watch_state(root: Path, state: dict):
    try:
        with (root / 'logs/exit-watchdog.log').open('a') as stream:
            stream.write(json.dumps(dict(state, time=time.time()), ensure_ascii=False) + '\n')
    except OSError:
        # An unavailable log must not stop observation or authorize termination.
        pass


def watch_exit(root: Path, started: float, cancel: threading.Event, state: dict):
    """Keep watching while the WebView is hidden or its JavaScript is suspended."""
    seen = False
    missing = 0
    previous = None
    state['launch_started'] = started
    while not cancel.wait(2):
        try:
            open_window = window_state(root, started)['has_window']
        except Exception:
            logging.exception('Game window query failed; keep game running')
            open_window = None
        if cancel.is_set():
            return
        state['has_window'] = open_window
        quitting = quit_requested(root, started)
        seen |= open_window is True
        state.update(seen_window=seen, quit_requested=quitting, sampled_at=time.time())
        current = (open_window, seen, quitting)
        if current != previous:
            record_watch_state(root, state)
            previous = current
        missing = missing + 1 if (seen or quitting) and open_window is False else 0
        if missing >= 6:
            state['cleanup_started'] = True
            try:
                stop_runtime(root, cancel)
                state['auto_cleanup'] = not cancel.is_set()
                logging.info('Game window closed; owned Wine runtime stopped')
            except (OSError, subprocess.SubprocessError, RuntimeError) as error:
                logging.exception('Automatic Wine cleanup failed')
                state['cleanup_error'] = str(error)
            record_watch_state(root, state)
            return


def stop_runtime(root: Path, cancel: threading.Event):
    """Terminate only this prefix; never use a global process-name kill."""
    command = [str(root / 'wine/bin/wineserver')]
    environment = dict(os.environ, WINEPREFIX=str(root / 'wineprefix'), WINEDEBUG='-all')
    deadline = time.monotonic() + 15
    while not cancel.is_set():
        if time.monotonic() >= deadline:
            raise RuntimeError('Wine 退出超时，请在启动器中重试清理残留')
        result = subprocess.run(command + ['-k'], env=environment, capture_output=True, timeout=3)
        if result.returncode not in (0, 1):
            raise RuntimeError(f'wineserver -k failed: {result.returncode}')
        try:
            subprocess.run(command + ['-w'], env=environment, capture_output=True, timeout=1, check=True)
            if runtime_running(root):
                if cancel.wait(.25):
                    return
                continue
            return
        except subprocess.TimeoutExpired:
            continue


def window_state(root: Path, started: float):
    executable = 'Z:' + str(root / 'game/YuanShen.exe').replace('/', '\\')
    prefix = str(root / 'wineprefix')
    pids = []
    try:
        for process in psutil.process_iter(['pid', 'cmdline', 'create_time']):
            args = process.info['cmdline'] or []
            if not args or re.sub(r'\\+', lambda _: '\\', args[0]) != executable or process.info['create_time'] < started:
                continue
            # Wine rewrites argv and can remove the Unix environment on macOS.
            # The exact game path, owned runtime and launch creation time identify it.
            runtime = Path(process.exe()).resolve()
            if runtime.is_relative_to((root / 'wine').resolve()):
                environment_prefix = process.environ().get('WINEPREFIX')
                if environment_prefix in (None, prefix):
                    pids.append(str(process.pid))
        if not pids:
            return {'has_window': False}
        # Wine can retain a Cocoa window after the Windows game window is destroyed.
        # Query the existing runtime's window table; this does not attach to the game.
        environment = dict(__import__('os').environ, WINEPREFIX=prefix, WINEDEBUG='-all')
        result = subprocess.run([str(root / 'wine/bin/wine'), 'winedbg', '--command', 'info wnd'],
                                env=environment, capture_output=True, text=True, timeout=3, check=True)
        return {'has_window': parse_window_table(result.stdout)}
    except (OSError, subprocess.SubprocessError, psutil.Error):
        # Unreadable/unknown must never be interpreted as a closed game.
        return {'has_window': None}


def parse_window_table(output: str):
    header = re.search(r'^Window handle\s+Class Name\s+Style\s+[^\n]*', output, re.MULTILINE)
    if not header:
        return None
    unreadable = False
    for line in output[header.end():].splitlines():
        if not line.strip():
            continue
        match = re.match(r'^\s*[0-9a-fA-F]+\s+(.*?)\s+([0-9a-fA-F]{8})\s+[0-9a-fA-F]+\s+[0-9a-fA-F]+\s', line)
        if not match or '-- Unknown --' in match[1]:
            unreadable = True
            continue
        # WS_VISIBLE remains set for minimized or macOS-hidden game windows.
        if match[1] == 'UnityWndClass' and int(match[2], 16) & 0x10000000:
            return True
    return None if unreadable else False


def runtime_running(root: Path):
    runtime = (root / 'wine').resolve()
    prefix = str(root / 'wineprefix')
    for process in psutil.process_iter(['exe']):
        executable = process.info.get('exe')
        if not executable or not Path(executable).resolve().is_relative_to(runtime):
            continue
        try:
            # Missing rewritten environment is conservatively treated as still running.
            if process.environ().get('WINEPREFIX') in (None, prefix):
                return True
        except psutil.NoSuchProcess:
            continue
        except psutil.AccessDenied:
            return True
    return False
