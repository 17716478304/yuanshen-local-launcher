import asyncio
import json
import os
from pathlib import Path
import secrets
import socket
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'sophon_server'))
os.environ['SOPHON_TOKEN']=secrets.token_hex(32)
os.environ['SOPHON_ORIGIN']='http://127.0.0.1:12345'
import server
import storage
import sophon_api
import uvicorn

class ServiceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with socket.socket() as sock:
            sock.bind(('127.0.0.1',0)); cls.port=sock.getsockname()[1]
        cls.http = uvicorn.Server(uvicorn.Config(server.app, host='127.0.0.1',port=cls.port,log_level='error'))
        cls.thread=threading.Thread(target=cls.http.run,daemon=True); cls.thread.start()
        for _ in range(100):
            if cls.http.started: return
            time.sleep(.03)
        raise RuntimeError('Test server did not start')
    @classmethod
    def tearDownClass(cls):
        cls.http.should_exit=True; cls.thread.join(timeout=5)
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(); self.root=Path(self.temp.name).resolve()/'data'; self.root.mkdir()
        self.pointer=Path(self.temp.name).resolve()/'location.json'
        storage.atomic_json(self.pointer,{'root':str(self.root)})
        self.paths=patch.multiple(storage,ROOT=self.root,POINTER=self.pointer);self.paths.start()
        server.launch_active=False;server.restart_required=False;server.launch_completed=False
        self.watcher = patch('game_process.watch_exit'); self.watcher.start()
    def tearDown(self):
        for _ in range(100):
            if not server.operation_lock.locked(): break
            time.sleep(.01)
        server.launch_watch_cancel.set()
        self.watcher.stop();self.paths.stop();self.temp.cleanup()
    def call(self, path, body=None, token=True, origin=None):
        headers={'Content-Type':'application/json'}
        if token:headers['Authorization']='Bearer '+server.TOKEN
        if origin:headers['Origin']=origin
        req=urllib.request.Request(f'http://127.0.0.1:{self.port}'+path,headers=headers,
                                   data=None if body is None else json.dumps(body).encode())
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req,timeout=5) as response:
            return json.load(response)
    def test_http_auth_and_origin(self):
        with self.assertRaises(urllib.error.HTTPError) as error:self.call('/health',token=False)
        self.assertEqual(error.exception.code,401)
        with self.assertRaises(urllib.error.HTTPError) as error:self.call('/health',origin='https://hostile.example')
        self.assertEqual(error.exception.code,403)
        self.assertEqual(self.call('/health')['status'],'healthy')
    def test_game_window_state_requires_active_authenticated_launch(self):
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.call('/api/launch/window-state', token=False)
        self.assertEqual(error.exception.code, 401)
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.call('/api/launch/window-state')
        self.assertEqual(error.exception.code, 409)
        self.call('/api/launch/begin', {})
        with patch('game_process.window_state') as probe:
            self.assertEqual(self.call('/api/launch/window-state'), {'has_window': None, 'auto_cleanup': False})
            probe.assert_not_called()  # HTTP/UI polling cannot start Wine after native cleanup.
        self.assertFalse(server.launch_watch_cancel.is_set())
        self.call('/api/launch/failed', {})
        self.assertTrue(server.launch_watch_cancel.is_set())

    def test_failed_cleanup_retains_launch_lock_and_blocks_migration(self):
        self.call('/api/launch/begin', {})
        marker = self.root / '.storage/patched.neustorage'
        marker.parent.mkdir()
        marker.write_text('1')
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.call('/api/launch/failed', {})
        self.assertEqual(error.exception.code, 409)
        self.assertTrue(server.launch_active)
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.call('/api/storage/migrate', {'destination': str(self.root.parent / 'new')})
        self.assertEqual(error.exception.code, 409)
        marker.unlink()
        self.call('/api/launch/failed', {})
        self.assertFalse(server.launch_active)

    def test_end_joins_old_watchdog_before_accepting_new_launch(self):
        ready, release = threading.Event(), threading.Event()
        watcher = __import__('game_process').watch_exit
        watcher.side_effect = lambda *args: (ready.set(), release.wait(3))
        self.call('/api/launch/begin', {})
        self.assertTrue(ready.wait(1))
        ended = threading.Event()
        ending = threading.Thread(target=lambda: (self.call('/api/launch/end', {}), ended.set()))
        ending.start()
        try:
            for _ in range(100):
                if server.launch_watch_cancel.is_set(): break
                time.sleep(.01)
            self.assertTrue(server.launch_active)
            with self.assertRaises(urllib.error.HTTPError) as error:
                self.call('/api/launch/begin', {})
            self.assertEqual(error.exception.code, 409)
            self.assertFalse(ended.is_set())
        finally:
            release.set(); ending.join(3)
        self.assertTrue(ended.is_set())
        self.call('/api/launch/begin', {}); self.call('/api/launch/failed', {})

    def test_task_failure_and_path_boundary(self):
        task=self.call('/api/install',{'gamedir':str(self.root.parent/'outside'),'game_type':'hk4e','install_reltype':'cn'})
        for _ in range(100):
            state=self.call('/api/tasks/'+task['task_id']+'/status')
            if state['status']=='failed':break
            time.sleep(.01)
        self.assertEqual(state['status'],'failed')
        self.assertFalse((self.root.parent/'outside').exists())
    def test_duplicate_and_launch_block(self):
        self.call('/api/launch/begin',{})
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.call('/api/install',{'gamedir':str(self.root/'game'),'game_type':'hk4e','install_reltype':'cn'})
        self.assertEqual(error.exception.code,409)
        self.call('/api/launch/failed',{})
    def test_ws_auth(self):
        import websockets
        async def attempt():
            async with websockets.connect(f'ws://127.0.0.1:{self.port}/ws/unknown') as ws:
                await ws.send(json.dumps({'token':'incorrect'}))
                try:await ws.recv()
                except websockets.exceptions.ConnectionClosed as error:self.assertEqual(error.code,1008)
        asyncio.run(attempt())
    def test_resume_missing_executable_with_explicit_cn(self):
        # Boundary dispatch must use a full manifest sync and an explicit CN channel.
        seen=[]
        def install(manager,tasks,task,request,cancel): seen.append(request.install_reltype)
        with patch.object(server,'perform_install',side_effect=install):
            task=self.call('/api/repair',{'gamedir':str(self.root/'game'),'game_type':'hk4e','repair_mode':'reliable'})
            for _ in range(100):
                if self.call('/api/tasks/'+task['task_id']+'/status')['status']=='completed':break
                time.sleep(.01)
        self.assertEqual(seen,['cn'])
    def test_manifest_traversal_and_hash_resume(self):
        options=sophon_api.Options();options.gamedir=self.root/'game';options.gamedir.mkdir()
        sophon_api.OPT=options
        for path in ['../x','/tmp/x','a/../../x','a\\..\\x']:
            with self.assertRaises(ValueError):sophon_api.filename_safety_check(path)
        sophon_api.filename_safety_check('YuanShen_Data/file.blk')
        options.tempdir=self.root/'tmp';options.tempdir.mkdir()
        (options.gamedir/'same.bin').write_bytes(b'bad')
        client=sophon_api.SophonClient();client.di_chunks.category_json={'chunk_download':{'url_prefix':'https://official.example'}}
        import manifest_pb2,hashlib,zstandard
        content=b'yes';file=manifest_pb2.FileInfo(filename='same.bin',size=3,md5=hashlib.md5(content).hexdigest())
        chunk=file.chunks.add(chunk_id='validchunk',compressed_size=12,offset=0)
        def download(url,path,size):path.write_bytes(zstandard.ZstdCompressor().compress(content))
        with patch.object(client,'_download_file_resume',side_effect=download):client.download_game_file(file)
        self.assertEqual((options.gamedir/'same.bin').read_bytes(),content)

    def test_cn_update_uses_full_manifest_sync(self):
        seen=[]
        def install(manager,tasks,task,request,cancel): seen.append(request.install_reltype)
        with patch.object(server,'perform_install',side_effect=install):
            task=self.call('/api/update',{'gamedir':str(self.root/'game'),'game_type':'hk4e'})
            for _ in range(100):
                state=self.call('/api/tasks/'+task['task_id']+'/status')
                if state['status']=='completed':break
                time.sleep(.01)
        self.assertEqual(state['status'],'completed')
        self.assertEqual(seen,['cn'])
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.call('/api/update',{'gamedir':str(self.root/'game'),'game_type':'hk4e','predownload':True})
        self.assertEqual(error.exception.code,400)

    def test_release_cache_refresh_preserves_resume_data(self):
        from tasks import remove_cached_files
        cache=self.root/'game/.tmp';cache.mkdir(parents=True)
        for name in ['getBuild.json','manifest.zstd','chunk-id','file.partial']:
            (cache/name).write_bytes(b'resume')
        remove_cached_files(cache)
        self.assertEqual({p.name for p in cache.iterdir()},{'chunk-id','file.partial'})

if __name__=='__main__': unittest.main()
