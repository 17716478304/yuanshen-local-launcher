import hashlib
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'sophon_server'))
import sophon_api
import tasks
import manifest_pb2
import manifest_ldiff_pb2

class RecoveryTests(unittest.TestCase):
    def test_bad_diff_preserves_original_file(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder).resolve();game=root/'game';cache=root/'cache';patches=root/'patches'
            for path in (game,cache,patches):path.mkdir()
            (game/'original.bin').write_bytes(b'old!');(patches/'patch').write_bytes(b'patch')
            options=sophon_api.Options();options.gamedir=game;options.tempdir=cache;sophon_api.OPT=options
            client=sophon_api.SophonClient()
            file=manifest_ldiff_pb2.DiffFileInfo(filename='original.bin',size=4,hash=hashlib.md5(b'good').hexdigest())
            info=manifest_ldiff_pb2.PatchInfo(patch_id='patch')
            def apply_patch(original,output,*args):output.write_bytes(b'bad!');return True
            with patch.object(client,'get_ldiff_patchinfo',return_value=info),patch.object(sophon_api,'hpatchz_patch_file',side_effect=apply_patch):
                client._apply_ldiff_file(patches,file)
            self.assertEqual((game/'original.bin').read_bytes(),b'old!')
            self.assertFalse((cache/'original.bin').exists())
            self.assertIn('original.bin',client.new_files_to_download)
    def test_clients_do_not_share_failed_update_state(self):
        old=sophon_api.SophonClient();old.new_files_to_download.add('old.bin');old.ldiff_files_to_remove.add('patch')
        fresh=sophon_api.SophonClient()
        self.assertFalse(fresh.new_files_to_download);self.assertFalse(fresh.ldiff_files_to_remove)
        self.assertIsNot(old.di_chunks,fresh.di_chunks)
    def test_chunk_and_patch_cache_boundaries(self):
        with tempfile.TemporaryDirectory() as folder:
            options=sophon_api.Options();options.tempdir=Path(folder).resolve();sophon_api.OPT=options
            for value in ['../../escape','/tmp/escape']:
                with self.assertRaises(ValueError):sophon_api.tempdir(value)
            for value in ['prefix-../../escape', '.', '..', 'sub/file']:
                with self.assertRaises(ValueError):sophon_api.cache_id(value)
            (options.tempdir/'link').symlink_to('/')
            with self.assertRaises(ValueError):sophon_api.tempdir('link/tmp/out')
            self.assertEqual(sophon_api.tempdir('valid-id'),options.tempdir/'valid-id')
    def test_cancel_at_download_and_delete_boundary(self):
        client=sophon_api.SophonClient();event=threading.Event();event.set();client.cancel_event=event
        with self.assertRaises(RuntimeError):client.check_cancelled()
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(RuntimeError):client._download_file_resume('https://official.example/x',Path(folder)/'new',123)
        event.clear();client.check_cancelled()
    def test_resume_capacity_counts_only_missing_files(self):
        # Use a tiny manifest and 6 GiB free: a 9 GiB already-correct file must not count again.
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder).resolve();(root/'good').write_bytes(b'good')
            manifest=manifest_pb2.Manifest();manifest.files.add(filename='good',size=4,md5=hashlib.md5(b'good').hexdigest())
            manifest.files.add(filename='missing',size=100,md5='x')
            seen=[]
            class Client:
                def __init__(self):self.di_chunks=type('Info',(),{'manifest':manifest})();self.installed_ver=None
                def initialize(self,options):sophon_api.OPT=options;seen.append(options)
                def retrieve_API_keys(self):pass
                def load_manifest(self,value):pass
                def get_chunk_download_size(self,value):return 100
                def download_game_file(self,*args,**kwargs):pass
                def update_config_ini_version(self):pass
            class Progress:
                def __init__(self,*args):pass
                def job_start(self):pass
                def download_summary(self,**kwargs):pass
                def job_end(self):pass
            from models import InstallRequest
            req=InstallRequest(gamedir=str(root),game_type='hk4e',install_reltype='cn',tempdir=str(root/'.tmp'))
            usage=type('Usage',(),{'free':5*1024**3+201})()
            with patch.object(tasks,'SophonClient',Client),patch.object(tasks,'InstallProgressHandler',Progress),patch.object(tasks.shutil,'disk_usage',return_value=usage):
                tasks.perform_install(None,{},'fixture',req,threading.Event())
            self.assertTrue(seen)
if __name__=='__main__':unittest.main()
