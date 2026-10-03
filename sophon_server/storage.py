"""Owned data root, bootstrap and verified migration. Never follow Wine drive links."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import threading
import uuid

CONTROL = Path(os.environ.get('CONTROL_ROOT', Path.home() / 'Library/Application Support/GenshinLocalLauncher'))
ROOT = Path(os.environ.get('DATA_ROOT', CONTROL / 'data')).resolve()
POINTER = CONTROL / 'location.json'
MARKER = '.genshin-local-root'


def atomic_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + '.new')
    with tmp.open('w') as f:
        json.dump(data, f, ensure_ascii=False)
        f.flush()
        os.fsync(f.fileno())
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def location():
    return json.loads(POINTER.read_text()) if POINTER.exists() else {'root': str(ROOT)}


def volume(path):
    output = subprocess.run(['/bin/df', '-P', str(path)], check=True, capture_output=True, text=True).stdout
    mount = output.splitlines()[-1].split(None, 5)[5]
    result = subprocess.run(['/usr/sbin/diskutil', 'info', '-plist', mount], check=True, capture_output=True)
    info = plistlib.loads(result.stdout)
    if not info.get('VolumeUUID'):
        raise ValueError('无法识别磁盘卷')
    return {'uuid': info['VolumeUUID'], 'mount': info.get('MountPoint', ''),
            'filesystem': info.get('FilesystemType', '')}


def checked_root(info):
    root = Path(info['root'])
    # Never mkdir a missing external path: a different volume could occupy the mount point.
    if info.get('volume_uuid'):
        if not root.is_dir() or volume(root)['uuid'] != info['volume_uuid']:
            raise ValueError('数据磁盘未连接或卷标识不匹配。请重新连接原磁盘。')
    if root.is_symlink():
        raise ValueError('数据根目录不能是符号链接')
    return root.resolve()


def game_path():
    checked_root(location())
    return ROOT / 'game'


def require_within(path, parent):
    path = Path(path).resolve()
    parent = Path(parent).resolve()
    if path == parent or not path.is_relative_to(parent):
        raise ValueError('路径超出允许的数据目录')
    return path


def digest(path, cancel=None):
    with Path(path).open('rb') as f:
        if cancel is not None:
            checksum = hashlib.sha256()
            while block := f.read(4 * 1024 * 1024):
                if cancel.is_set():
                    raise RuntimeError('迁移已取消，原数据保留')
                checksum.update(block)
            return checksum.hexdigest()
        return hashlib.file_digest(f, 'sha256').hexdigest()


def inventory(root, cancel=None):
    records = {}
    for base, dirs, files in os.walk(root, followlinks=False):
        for name in dirs + files:
            if cancel is not None and cancel.is_set():
                raise RuntimeError('迁移已取消，原数据保留')
            p = Path(base) / name
            rel = str(p.relative_to(root))
            if p.is_symlink():
                records[rel] = ('link', os.readlink(p))
            elif p.is_file():
                records[rel] = ('file', p.stat().st_size, p.stat().st_mode & 0o777, digest(p, cancel))
            elif p.is_dir():
                records[rel] = ('dir', p.stat().st_mode & 0o777)
            else:
                raise ValueError(f'不支持的特殊文件：{p}')
    return records


def copy_verified(source, stage, cancel=None):
    source, stage = Path(source), Path(stage)
    before = inventory(source, cancel)
    def copy_file(src, dst):
        if cancel and cancel.is_set():
            raise RuntimeError('迁移已取消，原数据保留')
        # Bounded reads; no shell expansion, no symlink dereferencing.
        with open(src, 'rb') as inp, open(dst, 'xb') as out:
            while block := inp.read(4 * 1024 * 1024):
                if cancel and cancel.is_set():
                    raise RuntimeError('迁移已取消，原数据保留')
                out.write(block)
        shutil.copystat(src, dst, follow_symlinks=False)
        return dst
    shutil.copytree(source, stage, symlinks=True, copy_function=copy_file)
    if cancel and cancel.is_set():
        raise RuntimeError('迁移已取消，原数据保留')
    if before != inventory(stage, cancel) or before != inventory(source, cancel):
        raise RuntimeError('迁移校验失败或原数据变化，原数据保留')


def rebase(stage, old, new):
    """Rebase only absolute links inside our root and known Wine registry path values."""
    for base, dirs, files in os.walk(stage, followlinks=False):
        for name in dirs + files:
            p = Path(base) / name
            if p.is_symlink():
                target = Path(os.readlink(p))
                if target.is_absolute() and target.is_relative_to(old):
                    p.unlink()
                    p.symlink_to(new / target.relative_to(old))
    for name in ('user.reg', 'system.reg', 'userdef.reg'):
        p = stage / 'wineprefix' / name
        if p.is_file() and not p.is_symlink():
            text = p.read_text()
            text = text.replace(str(old), str(new))
            text = text.replace(str(old).replace('/', '\\\\'), str(new).replace('/', '\\\\'))
            p.write_text(text)


def migrate(destination, cancel=None):
    info = location()
    if info.get('previous_root'):
        raise ValueError('已有迁移等待验证，请先验证或回滚')
    old = checked_root(info)
    if old != ROOT or not (old / MARKER).is_file():
        raise ValueError('数据目录标识不匹配')
    parent = Path(destination).resolve(strict=True)
    if not parent.is_dir() or parent == old or parent.is_relative_to(old) or old.is_relative_to(parent):
        raise ValueError('迁移目的地必须是独立目录')
    vol = volume(parent)
    if vol['filesystem'].lower() != 'apfs':
        raise ValueError('外接磁盘需要 APFS 文件系统')
    final = parent / 'GenshinLocalData'
    if final.exists() or final.is_symlink():
        raise ValueError('目标数据目录已存在，不能覆盖')
    needed = sum(p.stat().st_size for base, _, files in os.walk(old, followlinks=False)
                 for name in files if not (p := Path(base) / name).is_symlink())
    if shutil.disk_usage(parent).free < needed + 2 * 1024**3:
        raise ValueError('目标磁盘可用空间不足')
    stage = parent / ('.genshin-migration-' + uuid.uuid4().hex)
    try:
        copy_verified(old, stage, cancel)
        rebase(stage, old, final)
        if volume(parent)['uuid'] != vol['uuid'] or (cancel and cancel.is_set()):
            raise RuntimeError('磁盘变化或迁移取消，原数据保留')
        stage.rename(final)
        atomic_json(POINTER, {'root': str(final), 'volume_uuid': vol['uuid'],
                             'previous_root': str(old), 'previous_uuid': info.get('volume_uuid'),
                             'launch_verified': False})
        return {'root': str(final), 'restart_required': True}
    except BaseException:
        # Delete only this operation's private stage; never delete source or existing target.
        if stage.is_dir() and not stage.is_symlink():
            shutil.rmtree(stage)
        raise


def rollback():
    info = location()
    if not info.get('previous_root'):
        raise ValueError('没有可回滚的迁移')
    old = checked_root({'root': info['previous_root'], 'volume_uuid': info.get('previous_uuid')})
    if not (old / MARKER).is_file():
        raise ValueError('原目录标识丢失')
    atomic_json(POINTER, {'root': str(old), 'volume_uuid': info.get('previous_uuid')})
    return {'restart_required': True}


def cleanup():
    info = location()
    if checked_root(info) != ROOT or not info.get('launch_verified'):
        raise ValueError('请先在新目录启动游戏并确认到达登录界面')
    old = checked_root({'root': info['previous_root'], 'volume_uuid': info.get('previous_uuid')})
    if old == ROOT or old.is_relative_to(ROOT) or ROOT.is_relative_to(old) or not (old / MARKER).is_file():
        raise ValueError('旧目录校验失败')
    shutil.rmtree(old)
    atomic_json(POINTER, {'root': str(ROOT), 'volume_uuid': info.get('volume_uuid')})
    return {'cleaned': True}


def bootstrap(bundle):
    CONTROL.mkdir(parents=True, exist_ok=True)
    lock = (CONTROL / 'launcher.lock').open('w')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise ValueError('启动器已经运行')
    info = location()
    root = checked_root(info)
    root.mkdir(parents=True, exist_ok=True)
    if not POINTER.exists():
        atomic_json(POINTER, {'root': str(root), 'volume_uuid': volume(root)['uuid']})
    marker = root / MARKER
    if not marker.exists():
        marker.write_text('GenshinLocalLauncher\n')
    logs = root / 'logs'
    logs.mkdir(exist_ok=True)
    launcher_log = logs / 'launcher.log'
    if not launcher_log.exists() and not launcher_log.is_symlink():
        launcher_log.symlink_to('../neutralinojs.log')
    resources = Path(bundle) / 'Contents/Resources'
    for name in ('resources.neu', 'neutralino.config.json'):
        if (resources / name).exists():
            shutil.copy2(resources / name, root / name)
    link = root / 'sidecar'
    if link.is_symlink():
        link.unlink()
    if not link.exists():
        link.symlink_to(resources / 'sidecar', target_is_directory=True)
    # Native services execute from the bundle; runtime/cache/game execute in root.
    os.environ.update(DATA_ROOT=str(root), CONTROL_ROOT=str(CONTROL), PATH_LAUNCH=str(bundle), LAUNCHER_BOOTSTRAP_PID=str(os.getpid()))
    # Keep the LaunchServices PID when entering the Cocoa app. A child process
    # loses the bundle's window identity. Preserve the instance lock across exec.
    os.set_inheritable(lock.fileno(), True)
    os.chdir(root)
    executable = str(Path(bundle) / 'Contents/MacOS/GenshinLocalLauncher')
    os.execve(executable, [executable, '--path=' + str(root)], dict(os.environ))
