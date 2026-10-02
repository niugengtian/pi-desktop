#!/usr/bin/env python3
"""Offline macOS app-only install/rollback. No settings/auth/session restoration.
A private backup root must contain a prepared plan.json and signed app copies.
Quit the app normally first. Never kills or schedules replacement of a live app.
"""
import argparse
import ctypes
import fcntl
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import uuid

FORMAL = Path('/Applications/Pi Agent Desktop.app')
OLD_NAME = 'Rollback-Pi Agent Desktop.app'
NEW_NAME = 'release/mac-arm64/Pi Agent Desktop.app'


def sha(path):
    h = hashlib.sha256()
    with path.open('rb') as file:
        for block in iter(lambda: file.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def tree(path):
    if path.is_symlink() or not path.is_dir():
        raise RuntimeError('Missing or symlink application: ' + str(path))
    h = hashlib.sha256()
    h.update(json.dumps(['root', stat.S_IMODE(path.stat().st_mode)]).encode() + b'\n')
    for item in sorted(path.rglob('*')):
        relative = str(item.relative_to(path))
        if item.is_symlink():
            record = ['link', relative, os.readlink(item)]
        elif item.is_file():
            record = ['file', relative, stat.S_IMODE(item.stat().st_mode), sha(item)]
        elif item.is_dir():
            record = ['dir', relative, stat.S_IMODE(item.stat().st_mode)]
        else:
            raise RuntimeError('Special app member: ' + str(item))
        h.update(json.dumps(record, ensure_ascii=False).encode() + b'\n')
    return h.hexdigest()


def verify(app, info):
    if sha(app / 'Contents/Resources/app.asar') != info['asar'] or tree(app) != info['tree']:
        raise RuntimeError('App integrity mismatch: ' + str(app))
    subprocess.run(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(app)],
                   check=True, timeout=90)


def parse_blockers(lines):
    prefix = str(FORMAL) + '/Contents/'
    crashpad = prefix + 'Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler'
    blockers = []
    for line in lines:
        parts = line.split(None, 2)
        if len(parts) != 3 or not parts[2].startswith(prefix):
            continue
        pid, ppid, executable = parts
        if ppid == '1' and executable == crashpad:
            continue
        blockers.append({'pid': int(pid), 'ppid': int(ppid), 'executable': executable})
    return blockers


def blockers():
    return parse_blockers(subprocess.check_output(
        ['/bin/ps', '-axo', 'pid=,ppid=,comm='], text=True).splitlines())


def stopped():
    processes = blockers()
    if processes:
        raise RuntimeError('请保存工作并 Cmd+Q 完全退出 Pi，再运行命令。不会强杀。\n' +
                           '\n'.join('PID {pid}, PPID {ppid}: {executable}'.format(**p) for p in processes))


def exchange(first, second):
    fn = ctypes.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True).renamex_np
    fn.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
    fn.restype = ctypes.c_int
    if fn(os.fsencode(first), os.fsencode(second), 2):
        raise OSError(ctypes.get_errno(), 'Atomic application exchange failed')


def status(root, stage, **details):
    temporary = root / ('.status-' + uuid.uuid4().hex)
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, 'w') as file:
            json.dump({'stage': stage, **details}, file, ensure_ascii=False, indent=2)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, root / 'transaction-status.json')
    finally:
        if temporary.exists():
            temporary.unlink()
    print(stage, flush=True)


def load_plan(root, require_new=True):
    if root.is_symlink() or not root.is_dir() or stat.S_IMODE(root.stat().st_mode) != 0o700:
        raise RuntimeError('Backup root must be a real private 0700 directory')
    path = root / 'plan.json'
    if path.is_symlink() or path.stat().st_nlink != 1:
        raise RuntimeError('Unsafe plan path')
    plan = json.loads(path.read_text())
    if plan.get('schema') != 1 or plan.get('formal') != str(FORMAL):
        raise RuntimeError('Unexpected application plan')
    for name in ('old', 'new'):
        for field in ('tree', 'asar'):
            digest = plan[name][field]
            if not isinstance(digest, str) or len(digest) != 64 or any(c not in '0123456789abcdef' for c in digest):
                raise RuntimeError('Invalid app fingerprint')
    verify(root / OLD_NAME, plan['old'])
    if require_new:
        verify(root / NEW_NAME, plan['new'])
    return plan


def apply(root, plan, mode):
    if mode not in ('install', 'rollback'):
        raise ValueError('Unknown operation')
    stopped()
    current = tree(FORMAL)
    if current not in (plan['old']['tree'], plan['new']['tree']):
        raise RuntimeError('应用已被其他安装/人工修改；拒绝覆盖，请重新备份准备。')
    name = 'new' if mode == 'install' else 'old'
    info = plan[name]
    source = root / (NEW_NAME if mode == 'install' else OLD_NAME)
    stage = FORMAL.parent / ('.Pi Agent Desktop.tiered-' + mode + '-' + uuid.uuid4().hex + '.app')
    exchanged = False
    try:
        if current != info['tree']:
            subprocess.run(['/bin/cp', '-cR', str(source), str(stage)], check=True, timeout=600)
            verify(stage, info)
        if tree(FORMAL) != current:
            raise RuntimeError('准备期间应用发生变化；没有执行替换。')
        stopped()
        status(root, 'prepared-' + mode, displacedApp=str(stage) if stage.exists() else None)
        if current != info['tree']:
            exchange(FORMAL, stage)
            exchanged = True
        verify(FORMAL, info)
        status(root, mode + '-verified', asar=info['asar'],
               displacedApp=str(stage) if exchanged else None,
               sessionsAuthVaultSettingsUntouched=True,
               scope='App integrity/signature only; not all-provider/semantic acceptance')
    except BaseException as error:
        failures = []
        try:
            # Covers interruption immediately after the atomic exchange.
            exchanged = exchanged or (stage.is_dir() and tree(FORMAL) == info['tree'] and tree(stage) == current)
            if exchanged:
                if tree(FORMAL) != info['tree'] or tree(stage) != current:
                    raise RuntimeError('Independent app change; no automatic undo')
                stopped()
                exchange(FORMAL, stage)
        except BaseException as undo_error:
            failures.append(str(undo_error))
        status(root, 'undo-needs-attention' if failures else 'cancelled-original-retained',
               error=str(error), undoErrors=failures, stagedApp=str(stage))
        raise
    print('完成：仅应用更新。认证、会话、记忆、设置和Web组件未覆盖。', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', required=True, type=Path)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--check', action='store_true')
    group.add_argument('--install', action='store_true')
    group.add_argument('--rollback', action='store_true')
    parser.add_argument('--launch', action='store_true')
    args = parser.parse_args()
    root = args.root.absolute()
    # Validate root before creating the lock file. Do not follow a lock symlink.
    if root.is_symlink() or not root.is_dir() or stat.S_IMODE(root.stat().st_mode) != 0o700:
        raise RuntimeError('Backup root must be 0700, not a symlink')
    fd = os.open(root / '.transaction.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'r+') as lock:
        if not stat.S_ISREG(os.fstat(lock.fileno()).st_mode) or os.fstat(lock.fileno()).st_nlink != 1:
            raise RuntimeError('Unsafe lock file')
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        plan = load_plan(root, require_new=not args.rollback)
        if args.check:
            current = tree(FORMAL)
            if current not in (plan['old']['tree'], plan['new']['tree']):
                raise RuntimeError('Installed app differs from prepared plan')
            verify(FORMAL, plan['old'] if current == plan['old']['tree'] else plan['new'])
            print('CHECK OK：当前应用、新包及旧版备份完整/签名有效；没有安装。')
            for process in blockers():
                print('安装前需要退出：', process)
        else:
            apply(root, plan, 'install' if args.install else 'rollback')
    if args.launch and not args.check:
        subprocess.run(['/usr/bin/open', '-a', str(FORMAL)], check=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        raise SystemExit('未完成：' + str(error))
