"""Real APFS image lifecycle check. Run with the test volume mounted."""
import json
from pathlib import Path
import subprocess
import tempfile
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'sophon_server'))
import storage
with tempfile.TemporaryDirectory() as temporary:
    base=Path(temporary).resolve()
    old=base/'data';old.mkdir()
    (old/storage.MARKER).write_text('GenshinLocalLauncher\n')
    (old/'game').mkdir();(old/'game/fixture').write_bytes(b'fixture-game')
    (old/'wineprefix').mkdir();(old/'wineprefix/z:').symlink_to('/')
    storage.ROOT=old;storage.POINTER=base/'location.json'
    storage.atomic_json(storage.POINTER,{'root':str(old),'volume_uuid':storage.volume(old)['uuid']})
    destination=Path('/Volumes/GenshinMigrationTest/lifecycle')
    destination.mkdir()
    result=storage.migrate(destination)
    new=Path(result['root']);info=storage.location()
    assert storage.checked_root(info)==new
    subprocess.run(['hdiutil','detach','/Volumes/GenshinMigrationTest'],check=True,capture_output=True)
    try:storage.checked_root(info)
    except ValueError:pass
    else:raise AssertionError('Offline volume was accepted')
    assert not new.exists()
    image=Path(__file__).resolve().parents[1]/'.build-cache/migration-test-wide.sparseimage'
    subprocess.run(['hdiutil','attach','-nobrowse',str(image)],check=True,capture_output=True)
    assert storage.checked_root(info)==new
    assert (new/'game/fixture').read_bytes()==b'fixture-game'
    assert (new/'wineprefix/z:').is_symlink()
    storage.rollback();assert storage.checked_root(storage.location())==old
    print('APFS copy/hash/rebase/offline/reconnect/rollback passed; real external drive unverified')
