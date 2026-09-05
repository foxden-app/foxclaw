"""Linux-only, fail-closed handoff of one local interactive Codex writer.

No lock files are removed. pidfd keeps signals bound to the inspected process,
even if its numeric PID is reused. stdout is a small JSON protocol.
"""
import fcntl
import json
import os
from pathlib import Path
import re
import select
import signal
import sys


def lock_owners(lock_path):
    st = lock_path.stat()
    key = (os.major(st.st_dev), os.minor(st.st_dev), st.st_ino)
    owners = []
    for line in Path('/proc/locks').read_text().splitlines():
        fields = line.split()
        if len(fields) != 8 or fields[1:4] != ['FLOCK', 'ADVISORY', 'WRITE']:
            continue
        major, minor, inode = fields[5].split(':')
        if (int(major, 16), int(minor, 16), int(inode)) == key:
            owners.append(int(fields[4]))
    return owners


def process_stat(pid):
    # comm can contain spaces and parentheses; fields after the final ')' are stable.
    return Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()


def inspect_writer(home, thread_id):
    if sys.platform != 'linux' or not hasattr(os, 'pidfd_open') or not hasattr(signal, 'pidfd_send_signal'):
        raise RuntimeError('Requires Linux/WSL with Python 3.9+ and pidfd support')
    if not re.fullmatch(r'[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}', thread_id):
        raise RuntimeError('Invalid thread ID')
    lock_path = Path(home).resolve() / 'thread-writer-locks' / f'{thread_id}.lock'
    owners = lock_owners(lock_path)
    if len(owners) != 1 or owners[0] <= 1:
        raise RuntimeError('No unique local writer; nothing was stopped')
    pid = owners[0]
    proc = Path(f'/proc/{pid}')
    stat = process_stat(pid)
    if proc.stat().st_uid != os.getuid():
        raise RuntimeError('Writer belongs to a different OS user')
    exe = os.readlink(proc / 'exe')
    argv = (proc / 'cmdline').read_bytes().split(b'\0')
    if Path(exe).name != 'codex' or int(stat[4]) == 0:
        raise RuntimeError('Writer is not an interactive Codex CLI')
    if any(arg in (b'app-server', b'exec', b'e', b'review', b'mcp-server', b'--remote') or arg.startswith(b'--remote=') for arg in argv[1:]):
        raise RuntimeError('Refusing to stop a server, noninteractive CLI, or remote client')
    ancestor = os.getpid()
    while ancestor > 1:
        if ancestor == pid:
            raise RuntimeError('Refusing to stop an ancestor of this bridge')
        ancestor = int(process_stat(ancestor)[1])
    # A single CLI may own subagent threads: stopping it would affect them too.
    held_threads = set()
    for fd in (proc / 'fd').iterdir():
        try:
            target = os.readlink(fd)
            if '/thread-writer-locks/' in target and not target.endswith('/.coordination.lock'):
                held_threads.add(target)
        except FileNotFoundError:
            continue
    if held_threads != {str(lock_path)}:
        raise RuntimeError('Writer has additional or unidentifiable thread locks; manual handoff required')
    st = lock_path.stat()
    identity = {
        'pid': pid, 'startTime': stat[19], 'exe': exe,
        'lockDevice': str(st.st_dev), 'lockInode': str(st.st_ino),
        'cwd': os.readlink(proc / 'cwd'),
    }
    if lock_owners(lock_path) != [pid] or process_stat(pid)[19] != identity['startTime']:
        raise RuntimeError('Writer changed during inspection; request confirmation again')
    return identity


def stop_writer(home, thread_id, expected):
    # Open first, then revalidate. A recycled PID can never receive our signal.
    fd = os.pidfd_open(expected['pid'])
    try:
        if inspect_writer(home, thread_id) != expected:
            raise RuntimeError('Writer changed since confirmation; nothing was stopped')
        poller = select.poll()
        poller.register(fd, select.POLLIN)
        signal.pidfd_send_signal(fd, signal.SIGTERM)
        if not poller.poll(5000):
            # Recheck scope before escalation, retaining the original pidfd.
            if inspect_writer(home, thread_id) != expected:
                raise RuntimeError('Writer changed after SIGTERM; refused SIGKILL')
            signal.pidfd_send_signal(fd, signal.SIGKILL)
            if not poller.poll(3000):
                raise RuntimeError('CLI exit timed out; handoff not completed')
    finally:
        os.close(fd)
    lock_path = Path(home).resolve() / 'thread-writer-locks' / f'{thread_id}.lock'
    # Actual flock check, not just PID disappearance. Never unlink the lock.
    try:
        with lock_path.open('rb') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except FileNotFoundError:
        pass  # A clean CLI exit removed its own lock.
    except BlockingIOError:
        raise RuntimeError('CLI exited but thread is still locked; handoff not completed') from None
    return {'stopped': True}


if __name__ == '__main__':
    try:
        home, thread_id = sys.argv[1:3]
        result = stop_writer(home, thread_id, json.loads(sys.argv[3])) if len(sys.argv) == 4 else inspect_writer(home, thread_id)
        print(json.dumps({'ok': True, 'result': result}))
    except Exception as error:
        print(json.dumps({'ok': False, 'error': str(error)}))
