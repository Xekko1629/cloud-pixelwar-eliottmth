"""Offline regression tests: the guard never applies, forgets or deletes state."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


GUARD = Path(__file__).resolve().parents[1] / 'check-gateway-migration.sh'


class MigrationGuardTest(unittest.TestCase):
    def run_guard(self, output='', error='', code=0):
        with tempfile.TemporaryDirectory() as directory:
            fake = Path(directory) / 'terraform'
            fake.write_text('#!/usr/bin/env python3\nimport sys\n'
                            'assert sys.argv[1:] == ["state", "list"]\n'
                            f'print({output!r}, end="")\n'
                            f'print({error!r}, file=sys.stderr, end="")\n'
                            f'sys.exit({code})\n')
            fake.chmod(0o700)
            env = {**os.environ, 'PATH': directory + os.pathsep + os.environ['PATH']}
            return subprocess.run(['bash', str(GUARD)], env=env, capture_output=True, text=True)

    def test_current_function_state_is_allowed(self):
        result = self.run_guard('module.discord_hello[0].google_cloudfunctions2_function.main\n')
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_legacy_gateway_is_blocked(self):
        result = self.run_guard('module.api_gateway[0].google_api_gateway_api.main\n')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Legacy Gateway', result.stderr)

    def test_unindexed_legacy_gateway_is_blocked(self):
        self.assertNotEqual(self.run_guard('module.api_gateway.google_service_account.gateway\n').returncode, 0)

    def test_similar_module_name_is_not_blocked(self):
        self.assertEqual(self.run_guard('module.api_gateway_cache.google_service_account.main\n').returncode, 0)

    def test_empty_new_state_is_allowed(self):
        self.assertEqual(self.run_guard(error='No state file was found!\n', code=1).returncode, 0)

    def test_permission_error_fails_closed(self):
        self.assertNotEqual(self.run_guard(error='AccessDenied: forbidden\n', code=1).returncode, 0)


if __name__ == '__main__':
    unittest.main()
