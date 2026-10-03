import subprocess
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import psutil
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "sophon_server"))
import game_process
import threading
import tempfile
from datetime import datetime
from unittest.mock import Mock

ROOT = Path('/data')
TABLE = 'Window handle        Class Name        Style    WndProc          Thread   Text\n'
OPEN = ' 00010022 UnityWndClass 16cf0000 0000000000000000 00000108 ignored\n'
CLOSED = ' 00010020 #32769 96000000 0000000000000000 00000108 ignored\n'
EXE = 'Z:\\data\\game\\YuanShen.exe'


def process(pid=42, args=None, created=100, prefix='/data/wineprefix'):
    return SimpleNamespace(pid=pid, info={'pid': pid, 'cmdline': args or [EXE],
                          'create_time': created}, exe=lambda: '/data/wine/bin/wine', environ=lambda: {'WINEPREFIX': prefix})


class GameProcessTests(unittest.TestCase):
    def test_only_fresh_exact_engine_quit_events(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / 'wineprefix/drive_c/users/crossover/AppData/LocalLow/miHoYo/原神/output_log.txt'
            path.parent.mkdir(parents=True)
            started = datetime(2026, 10, 2, 17, 0).timestamp()
            for text, expected in [
                ('[2026-10-02 16:59:59.999] OnApplicationQuit\n', False),
                ('[2026-10-02 17:00:01.000] OnApplicationQuit\r\n', True),
                ('[2026-10-02 17:00:01.000] Call QuitApplication\n', False),
                ('[invalid] OnApplicationQuit\n', False),
                ('[2026-10-02 17:00:01.000] OnApplicationQuit cancelled\n', False),
            ]:
                path.write_text(text)
                self.assertEqual(game_process.quit_requested(root, started), expected)

    @patch('game_process.quit_requested', return_value=True)
    @patch('game_process.stop_runtime')
    @patch('game_process.window_state', return_value={'has_window': False})
    def test_engine_exit_cleans_even_if_visible_window_was_never_observed(self, probe, stop, quit):
        cancel = SimpleNamespace(wait=Mock(return_value=False), is_set=lambda: False)
        state = {'has_window': None, 'auto_cleanup': False}
        game_process.watch_exit(ROOT, 99, cancel, state)
        self.assertEqual(probe.call_count, 6)
        stop.assert_called_once_with(ROOT, cancel)
        self.assertTrue(state['auto_cleanup'])

    @patch('game_process.quit_requested', return_value=True)
    @patch('game_process.stop_runtime')
    @patch('game_process.window_state', return_value={'has_window': None})
    def test_exit_log_does_not_override_unknown_or_live_window(self, probe, stop, quit):
        for window in (None, True):
            probe.return_value = {'has_window': window}
            cancel = SimpleNamespace(wait=Mock(side_effect=[False] * 8 + [True]), is_set=lambda: False)
            state = {'has_window': None, 'auto_cleanup': False}
            game_process.watch_exit(ROOT, 99, cancel, state)
            self.assertFalse(state['auto_cleanup'])
        stop.assert_not_called()
    @patch('game_process.stop_runtime')
    @patch('game_process.window_state')
    def test_native_watchdog_without_any_ui_requests(self, probe, stop):
        snapshots = [False, None, True, False, False, None, True] + [False] * 6
        probe.side_effect = [{'has_window': value} for value in snapshots]
        cancel = SimpleNamespace(wait=Mock(return_value=False), is_set=lambda: False)
        state = {'has_window': None, 'auto_cleanup': False}
        game_process.watch_exit(ROOT, 99, cancel, state)
        self.assertEqual(probe.call_count, len(snapshots))
        stop.assert_called_once_with(ROOT, cancel)
        self.assertTrue(state['auto_cleanup'])

    @patch('game_process.stop_runtime', side_effect=RuntimeError('cleanup timeout'))
    @patch('game_process.window_state')
    def test_failed_native_cleanup_is_never_success(self, probe, stop):
        probe.side_effect = [{'has_window': True}] + [{'has_window': False}] * 6
        cancel = SimpleNamespace(wait=Mock(return_value=False), is_set=lambda: False)
        state = {'has_window': None, 'auto_cleanup': False}
        with self.assertLogs(level='ERROR'):
            game_process.watch_exit(ROOT, 99, cancel, state)
        self.assertTrue(state['cleanup_started'])
        self.assertFalse(state['auto_cleanup'])
        self.assertEqual(state['cleanup_error'], 'cleanup timeout')

    @patch('game_process.stop_runtime')
    @patch('game_process.window_state')
    def test_watchdog_never_seen_minimized_unknown_and_cancelled(self, probe, stop):
        for value in (False, True, None):
            probe.return_value = {'has_window': value}
            cancel = SimpleNamespace(wait=Mock(side_effect=[False] * 10 + [True]), is_set=lambda: False)
            state = {'has_window': None, 'auto_cleanup': False}
            game_process.watch_exit(ROOT, 99, cancel, state)
            self.assertFalse(state['auto_cleanup'])
        stop.assert_not_called()

    @patch('game_process.stop_runtime')
    @patch('game_process.window_state')
    def test_watchdog_query_exception_invalidates_state_and_cancellation(self, probe, stop):
        probe.side_effect = [{'has_window': True}] + [{'has_window': False}] * 5 + [UnicodeError('bad output'), {'has_window': True}]
        cancel = SimpleNamespace(wait=Mock(side_effect=[False] * 8 + [True]), is_set=lambda: False)
        state = {'has_window': None, 'auto_cleanup': False}
        with self.assertLogs(level='ERROR'):
            game_process.watch_exit(ROOT, 99, cancel, state)
        self.assertTrue(state['has_window']); self.assertFalse(state['auto_cleanup'])
        stop.assert_not_called()
        cancelled = threading.Event()
        def query(*args):
            cancelled.set()
            return {'has_window': False}
        probe.side_effect = query
        cancel = SimpleNamespace(wait=lambda _: False, is_set=cancelled.is_set)
        game_process.watch_exit(ROOT, 99, cancel, state)
        self.assertTrue(state['has_window']); stop.assert_not_called()

    @patch('game_process.runtime_running', return_value=False)
    @patch('game_process.subprocess.run')
    def test_native_stop_scope_wait_retry_and_failure(self, run, _):
        run.side_effect = [SimpleNamespace(returncode=0), subprocess.TimeoutExpired('wait', 1),
                           SimpleNamespace(returncode=1), SimpleNamespace(returncode=0)]
        game_process.stop_runtime(ROOT, threading.Event())
        self.assertEqual([call.args[0][-1] for call in run.call_args_list], ['-k', '-w', '-k', '-w'])
        for call in run.call_args_list:
            self.assertEqual(call.args[0][0], '/data/wine/bin/wineserver')
            self.assertEqual(call.kwargs['env']['WINEPREFIX'], '/data/wineprefix')
        run.side_effect = [SimpleNamespace(returncode=2)]
        with self.assertRaises(RuntimeError): game_process.stop_runtime(ROOT, threading.Event())
        run.reset_mock(); cancel = threading.Event(); cancel.set()
        game_process.stop_runtime(ROOT, cancel); run.assert_not_called()

    @patch('game_process.subprocess.run')
    @patch('game_process.psutil.process_iter')
    def test_exact_game_and_prefix_only(self, listing, run):
        listing.return_value = [process(), process(43, prefix='/other'),
                                process(44, args=['C:\\windows\\system32\\steam.exe', EXE]),
                                process(45, created=90)]
        run.return_value = SimpleNamespace(stdout=TABLE + OPEN)
        self.assertEqual(game_process.window_state(ROOT, 99), {'has_window': True})
        self.assertEqual(run.call_args.args[0], ['/data/wine/bin/wine', 'winedbg', '--command', 'info wnd'])
        self.assertEqual(run.call_args.kwargs['timeout'], 3)

    @patch('game_process.subprocess.run')
    @patch('game_process.psutil.process_iter')
    def test_rewritten_argv_and_environment_but_not_foreign_runtime(self, listing, run):
        own = process(args=[EXE.replace('\\', '\\\\')], prefix=None)
        foreign = process(pid=43)
        foreign.exe = lambda: '/foreign/wine/bin/wine'
        listing.return_value = [own, foreign]
        run.return_value = SimpleNamespace(stdout=TABLE + OPEN)
        self.assertEqual(game_process.window_state(ROOT, 99), {'has_window': True})
        self.assertEqual(run.call_args.kwargs['env']['WINEPREFIX'], '/data/wineprefix')

    @patch('game_process.psutil.process_iter')
    def test_unreadable_matching_game_is_unknown(self, listing):
        own = process()
        own.environ = lambda: (_ for _ in ()).throw(psutil.AccessDenied(42))
        listing.return_value = [own]
        self.assertEqual(game_process.window_state(ROOT, 99), {'has_window': None})

    @patch('game_process.psutil.process_iter')
    def test_runtime_guard_is_conservative_and_scoped(self, listing):
        own = process(prefix=None)
        own.info['exe'] = '/data/wine/bin/wine'
        listing.return_value = [own]
        self.assertTrue(game_process.runtime_running(ROOT))
        own.environ = lambda: {'WINEPREFIX': '/foreign/prefix'}
        self.assertFalse(game_process.runtime_running(ROOT))
        own.info['exe'] = '/foreign/wine/bin/wine'
        own.environ = lambda: {'WINEPREFIX': '/data/wineprefix'}
        self.assertFalse(game_process.runtime_running(ROOT))

    @patch('game_process.psutil.process_iter', return_value=[])
    def test_no_owned_game(self, _):
        self.assertEqual(game_process.window_state(ROOT, 99), {'has_window': False})

    def test_window_table_open_minimized_hidden_closed_and_corrupt(self):
        self.assertTrue(game_process.parse_window_table(TABLE + OPEN))
        self.assertTrue(game_process.parse_window_table(TABLE + OPEN.replace('16cf0000', '36cf0000')))
        self.assertFalse(game_process.parse_window_table(TABLE + OPEN.replace('16cf0000', '06cf0000')))
        self.assertFalse(game_process.parse_window_table(TABLE + CLOSED))
        self.assertIsNone(game_process.parse_window_table('Exception c0000005'))
        unknown = CLOSED.replace('#32769', '-- Unknown --')
        self.assertIsNone(game_process.parse_window_table(TABLE + unknown))
        self.assertIsNone(game_process.parse_window_table(TABLE + 'broken row'))
        self.assertTrue(game_process.parse_window_table(TABLE + unknown + OPEN))

    @patch('game_process.subprocess.run')
    @patch('game_process.psutil.process_iter')
    def test_closed_and_unknown(self, listing, run):
        listing.return_value = [process()]
        run.return_value = SimpleNamespace(stdout=TABLE + CLOSED)
        self.assertEqual(game_process.window_state(ROOT, 99), {'has_window': False})
        for failure in [OSError('missing probe'), subprocess.TimeoutExpired('probe', 3), psutil.AccessDenied(42)]:
            run.side_effect = failure
            self.assertEqual(game_process.window_state(ROOT, 99), {'has_window': None})
        run.side_effect = None
        run.return_value = SimpleNamespace(stdout='invalid')
        self.assertEqual(game_process.window_state(ROOT, 99), {'has_window': None})
