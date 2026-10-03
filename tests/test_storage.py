import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'sophon_server'))
import storage

class StorageTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=os.environ.get('TEST_APFS_PARENT'))
        self.base = Path(self.tmp.name).resolve()
        self.root = self.base / 'old'
        self.root.mkdir()
        (self.root / storage.MARKER).write_text('GenshinLocalLauncher\n')
        (self.root / 'game').mkdir()
        (self.root / 'game/a').write_bytes(b'game-data' * 200)
        (self.root / 'wineprefix').mkdir()
        (self.root / 'wineprefix/z:').symlink_to('/')
        (self.root / 'wineprefix/local').symlink_to(self.root / 'game')
        self.destination = self.base / 'external'
        self.destination.mkdir()
        self.pointer = self.base / 'control/location.json'
        self.root_patch = patch.multiple(storage, ROOT=self.root, POINTER=self.pointer)
        self.root_patch.start()
        self.vol_patch = patch.object(storage, 'volume', return_value={'uuid':'volume-1','filesystem':'apfs','mount':str(self.base)})
        if not os.environ.get('TEST_APFS_PARENT'):
            self.vol_patch.start()
        storage.atomic_json(self.pointer, {'root': str(self.root)})
    def tearDown(self):
        self.vol_patch.stop(); self.root_patch.stop(); self.tmp.cleanup()
    def test_copy_verify_and_rebase(self):
        result = storage.migrate(self.destination)
        new = Path(result['root'])
        self.assertTrue(self.root.exists())
        self.assertEqual((new/'game/a').read_bytes(), (self.root/'game/a').read_bytes())
        self.assertEqual(os.readlink(new/'wineprefix/z:'), '/')
        self.assertEqual(os.readlink(new/'wineprefix/local'), str(new/'game'))
        self.assertFalse(storage.location()['launch_verified'])
    def test_cancel_preserves_source_and_pointer(self):
        event = threading.Event(); event.set()
        with self.assertRaises(RuntimeError): storage.migrate(self.destination, event)
        self.assertEqual(storage.location()['root'], str(self.root))
        self.assertEqual(list(self.destination.iterdir()), [])
        self.assertTrue((self.root/'game/a').exists())
    def test_corruption_fails(self):
        real = storage.inventory
        count = 0
        def corrupted(path, cancel=None):
            nonlocal count
            count += 1
            if count == 2: (Path(path)/'game/a').write_bytes(b'corrupt')
            return real(path, cancel)
        with patch.object(storage, 'inventory', side_effect=corrupted):
            with self.assertRaises(RuntimeError): storage.migrate(self.destination)
        self.assertEqual(storage.location()['root'], str(self.root))
        self.assertTrue(self.root.exists())
    def test_cancel_during_hash_stops_before_copy(self):
        event = threading.Event()
        real = storage.digest
        def cancel_after_file(path, cancel=None):
            value = real(path)
            event.set()
            return value
        with patch.object(storage, 'digest', side_effect=cancel_after_file), patch.object(storage.shutil, 'copytree') as copying:
            with self.assertRaises(RuntimeError): storage.migrate(self.destination, event)
            copying.assert_not_called()
        self.assertEqual(storage.location()['root'], str(self.root))
        self.assertTrue((self.root/'game/a').exists())
    def test_existing_destination_not_overwritten(self):
        (self.destination/'GenshinLocalData').mkdir()
        with self.assertRaises(ValueError): storage.migrate(self.destination)
    def test_nested_destination_denied(self):
        with self.assertRaises(ValueError): storage.migrate(self.root/'game')
    def test_wrong_volume_denied(self):
        with patch.object(storage, 'volume', return_value={'uuid':'other'}):
            with self.assertRaises(ValueError): storage.checked_root({'root':str(self.root),'volume_uuid':'required'})
    def test_missing_external_not_recreated(self):
        missing = self.base/'missing/data'
        with self.assertRaises(ValueError): storage.checked_root({'root':str(missing),'volume_uuid':'volume'})
        self.assertFalse(missing.exists())
    def test_cleanup_requires_confirmed_new_root(self):
        storage.migrate(self.destination)
        with self.assertRaises(ValueError): storage.cleanup()
        new = Path(storage.location()['root'])
        with patch.object(storage, 'ROOT', new):
            with self.assertRaises(ValueError): storage.cleanup()
            info=storage.location(); info['launch_verified']=True; storage.atomic_json(self.pointer, info)
            storage.cleanup()
        self.assertFalse(self.root.exists())
        self.assertTrue((new/'game/a').exists())
    def test_rollback_preserves_both(self):
        storage.migrate(self.destination)
        new = Path(storage.location()['root'])
        storage.rollback()
        self.assertEqual(storage.location()['root'], str(self.root))
        self.assertTrue(new.exists())
    def test_symlink_escape_denied(self):
        (self.root/'game/link').symlink_to(self.base)
        with self.assertRaises(ValueError): storage.require_within(self.root/'game/link/out', self.root/'game')

if __name__ == '__main__': unittest.main()
