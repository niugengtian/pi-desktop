#!/usr/bin/env python3
"""Focused offline transaction checks using disposable fictional bundles only."""
import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('control', Path(__file__).with_name('app-install-control.py'))
control = importlib.util.module_from_spec(spec)
spec.loader.exec_module(control)


class AppInstallTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        self.root = self.base / 'backup'
        self.root.mkdir(mode=0o700)
        self.formal = self.base / 'Applications/Pi Agent Desktop.app'
        self.formal.parent.mkdir()
        for relative, data in ((control.OLD_NAME, 'old'), (control.NEW_NAME, 'new')):
            folder = self.root / relative / 'Contents/Resources'
            folder.mkdir(parents=True)
            (folder / 'app.asar').write_text(data)
        shutil.copytree(self.root / control.OLD_NAME, self.formal, symlinks=True)
        self.config = self.base / 'settings.json'
        self.config.write_text('human settings, auth/session/vault are never restored')
        self.formal_patch = patch.object(control, 'FORMAL', self.formal)
        self.formal_patch.start()
        self.signature = patch.object(control.subprocess, 'run', side_effect=self.run_command)
        self.signature.start()
        self.processes = patch.object(control, 'blockers', return_value=[])
        self.processes.start()
        self.atomic = patch.object(control, 'exchange', side_effect=self.exchange)
        self.atomic_mock = self.atomic.start()
        self.plan = {'schema': 1, 'formal': str(self.formal)}
        for name, relative in (('old', control.OLD_NAME), ('new', control.NEW_NAME)):
            app = self.root / relative
            self.plan[name] = {'tree': control.tree(app), 'asar': control.sha(app / 'Contents/Resources/app.asar')}
        (self.root / 'plan.json').write_text(json.dumps(self.plan))

    def tearDown(self):
        self.atomic.stop()
        self.processes.stop()
        self.signature.stop()
        self.formal_patch.stop()
        self.temp.cleanup()

    def run_command(self, args, **_kwargs):
        if args[:2] == ['/bin/cp', '-cR']:
            shutil.copytree(args[2], args[3], symlinks=True)
        elif args[0] != '/usr/bin/codesign':
            self.fail('Unexpected subprocess: ' + repr(args))

    def exchange(self, first, second):
        # Simulates rename-exchange semantics, not a real filesystem atomicity test.
        spare = self.base / 'temporary-exchange'
        first.rename(spare)
        second.rename(first)
        spare.rename(second)

    def test_install_rollback_reinstall_preserve_later_settings(self):
        control.load_plan(self.root)
        control.apply(self.root, self.plan, 'install')
        self.assertEqual(control.tree(self.formal), self.plan['new']['tree'])
        self.config.write_text('later human edits')
        control.apply(self.root, self.plan, 'rollback')
        self.assertEqual(control.tree(self.formal), self.plan['old']['tree'])
        self.assertEqual(self.config.read_text(), 'later human edits')
        control.apply(self.root, self.plan, 'install')
        self.assertEqual(self.config.read_text(), 'later human edits')

    def test_idempotent_operations(self):
        control.apply(self.root, self.plan, 'rollback')
        control.apply(self.root, self.plan, 'install')
        control.apply(self.root, self.plan, 'install')
        self.assertEqual(len(list(self.formal.parent.glob('.Pi Agent Desktop.tiered-*.app'))), 1)

    def test_running_refuses_before_stage(self):
        with patch.object(control, 'blockers', return_value=[{'pid': 2, 'ppid': 1, 'executable': 'main'}]):
            with self.assertRaisesRegex(RuntimeError, 'Cmd\\+Q'):
                control.apply(self.root, self.plan, 'install')
        self.assertEqual(control.tree(self.formal), self.plan['old']['tree'])
        self.assertEqual(list(self.formal.parent.glob('.Pi*')), [])

    def test_start_during_preparation_refuses_before_exchange(self):
        with patch.object(control, 'stopped', side_effect=[None, RuntimeError('started')]):
            with self.assertRaisesRegex(RuntimeError, 'started'):
                control.apply(self.root, self.plan, 'install')
        self.assertEqual(control.tree(self.formal), self.plan['old']['tree'])
        self.atomic_mock.assert_not_called()

    def test_unknown_app_not_overwritten(self):
        (self.formal / 'human-file').write_text('do not delete')
        with self.assertRaisesRegex(RuntimeError, '拒绝覆盖'):
            control.apply(self.root, self.plan, 'install')
        self.assertEqual((self.formal / 'human-file').read_text(), 'do not delete')

    def test_post_exchange_verification_failure_restores_old(self):
        verify = control.verify
        def guarded(app, info):
            if app == self.formal:
                raise RuntimeError('signature failed')
            return verify(app, info)
        with patch.object(control, 'verify', side_effect=guarded):
            with self.assertRaisesRegex(RuntimeError, 'signature failed'):
                control.apply(self.root, self.plan, 'install')
        self.assertEqual(control.tree(self.formal), self.plan['old']['tree'])
        self.assertEqual(self.atomic_mock.call_count, 2)

    def test_corrupt_backup_refused(self):
        (self.root / control.OLD_NAME / 'Contents/Resources/app.asar').write_text('corrupt')
        with self.assertRaisesRegex(RuntimeError, 'integrity mismatch'):
            control.load_plan(self.root)

    def test_rollback_does_not_require_new_package(self):
        shutil.rmtree(self.root / 'release')
        control.load_plan(self.root, require_new=False)
        with self.assertRaises((FileNotFoundError, RuntimeError)):
            control.load_plan(self.root)

    def test_symlink_plan_refused(self):
        path = self.root / 'plan.json'
        path.rename(self.root / 'original-plan')
        path.symlink_to(self.root / 'original-plan')
        with self.assertRaisesRegex(RuntimeError, 'Unsafe plan'):
            control.load_plan(self.root)

    def test_human_app_mode_change_refused(self):
        self.formal.chmod(0o700)
        with self.assertRaisesRegex(RuntimeError, '拒绝覆盖'):
            control.apply(self.root, self.plan, 'install')

    def test_exact_crashpad_orphan_exception_only(self):
        prefix = str(self.formal) + '/Contents/'
        crashpad = prefix + 'Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler'
        self.assertEqual(control.parse_blockers(['100 1 ' + crashpad]), [])
        cases = ['100 2 ' + crashpad, '100 1 ' + prefix + 'MacOS/Pi Agent Desktop',
                 '100 1 ' + prefix + 'Frameworks/Pi Agent Desktop Helper (Renderer).app/Contents/MacOS/Renderer',
                 '100 1 ' + prefix + 'other/chrome_crashpad_handler']
        for line in cases:
            with self.subTest(line=line):
                self.assertEqual(len(control.parse_blockers([line])), 1)
        self.assertEqual(control.parse_blockers(['101 1 /another/Pi Agent Desktop.app/Contents/MacOS/main']), [])


if __name__ == '__main__':
    unittest.main()
