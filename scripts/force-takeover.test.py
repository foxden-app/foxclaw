import fcntl
import importlib.util
import os
from pathlib import Path
import pty
import shutil
import signal
import tempfile
import time
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('takeover', Path(__file__).with_name('force-takeover.py'))
takeover = importlib.util.module_from_spec(spec)
spec.loader.exec_module(takeover)
THREAD = '00000000-0000-0000-0000-000000000001'


class WriterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='foxclaw-force-test-')
        self.home = Path(self.temp.name)
        (self.home / 'thread-writer-locks').mkdir()
        self.lock = self.home / 'thread-writer-locks' / f'{THREAD}.lock'
        self.pid = None
        self.terminal = None

    def tearDown(self):
        if self.pid:
            try:
                os.kill(self.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            os.waitpid(self.pid, 0)
        if self.terminal is not None:
            os.close(self.terminal)
        self.temp.cleanup()

    def writer(self, extra_lock=False, ignore_term=False, name='codex'):
        # Harmless sleep binary: real PTY, PID, flock and pidfd, never a user CLI.
        executable = self.home / name
        shutil.copyfile('/bin/sleep', executable)
        executable.chmod(0o700)
        pid, terminal = pty.fork()
        if pid == 0:
            if ignore_term:
                signal.signal(signal.SIGTERM, signal.SIG_IGN)
            locks = [self.lock]
            if extra_lock:
                locks.append(self.lock.with_name('00000000-0000-0000-0000-000000000002.lock'))
            for lock in locks:
                fd = os.open(lock, os.O_CREAT | os.O_RDWR, 0o600)
                os.set_inheritable(fd, True)
                fcntl.flock(fd, fcntl.LOCK_EX)
            os.execl(str(executable), name, '60')
        self.pid, self.terminal = pid, terminal
        for _ in range(200):
            if os.readlink(f'/proc/{pid}/exe') == str(executable):
                return
            time.sleep(0.01)
        self.fail('Fixture did not start')

    def test_inspect_does_not_signal_and_stop_releases_real_lock(self):
        self.writer()
        identity = takeover.inspect_writer(self.home, THREAD)
        self.assertEqual(identity['pid'], self.pid)
        os.kill(self.pid, 0)
        self.assertEqual(takeover.stop_writer(self.home, THREAD, identity), {'stopped': True})
        self.assertTrue(self.lock.exists(), 'helper must not unlink lock files')
        with self.lock.open('rb') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)

    def test_escalates_only_confirmed_process_after_term_timeout(self):
        self.writer(ignore_term=True)
        identity = takeover.inspect_writer(self.home, THREAD)
        takeover.stop_writer(self.home, THREAD, identity)
        self.assertEqual(takeover.process_stat(self.pid)[0], 'Z')

    def test_stale_identity_never_signals(self):
        self.writer()
        identity = takeover.inspect_writer(self.home, THREAD)
        identity['startTime'] = 'wrong-start-time'
        with self.assertRaisesRegex(RuntimeError, 'changed since confirmation'):
            takeover.stop_writer(self.home, THREAD, identity)
        self.assertEqual(takeover.lock_owners(self.lock), [self.pid])

    def test_additional_thread_refused(self):
        self.writer(extra_lock=True)
        with self.assertRaisesRegex(RuntimeError, 'additional'):
            takeover.inspect_writer(self.home, THREAD)

    def test_non_codex_refused(self):
        self.writer(name='sleep')
        with self.assertRaisesRegex(RuntimeError, 'not an interactive'):
            takeover.inspect_writer(self.home, THREAD)

    def test_server_remote_and_other_user_refused(self):
        self.writer()
        for arg in (b'app-server', b'exec', b'--remote', b'--remote=ws://localhost:9000'):
            with patch.object(Path, 'read_bytes', return_value=b'codex\0' + arg + b'\0'):
                with self.assertRaisesRegex(RuntimeError, 'Refusing to stop'):
                    takeover.inspect_writer(self.home, THREAD)
        with patch.object(os, 'getuid', return_value=os.getuid() + 1):
            with self.assertRaisesRegex(RuntimeError, 'different OS user'):
                takeover.inspect_writer(self.home, THREAD)

    def test_ancestor_refused(self):
        self.writer()
        with patch.object(os, 'getpid', return_value=self.pid):
            with self.assertRaisesRegex(RuntimeError, 'ancestor'):
                takeover.inspect_writer(self.home, THREAD)

    def test_unlocked_file_and_invalid_id_refused(self):
        self.lock.touch()
        with self.assertRaisesRegex(RuntimeError, 'No unique'):
            takeover.inspect_writer(self.home, THREAD)
        with self.assertRaisesRegex(RuntimeError, 'Invalid thread'):
            takeover.inspect_writer(self.home, '../../outside')


if __name__ == '__main__':
    unittest.main()
