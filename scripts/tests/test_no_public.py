"""Offline regression tests: the no-public check (SEC-01) flags public resources and fails closed."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


CHECK = Path(__file__).resolve().parents[1] / 'check-no-public.sh'
PUBLIC = {'bindings': [{'role': 'roles/run.invoker', 'members': ['allUsers']}]}
PRIVATE = {'bindings': [{'role': 'roles/run.invoker', 'members': ['serviceAccount:gw@p.iam.gserviceaccount.com']}]}

# Fake gcloud: answers from a JSON fixture, fails on anything it does not know.
FAKE_GCLOUD = '''#!/usr/bin/env python3
import json, sys
fixture = json.load(open(sys.argv[0] + '.json'))
args = sys.argv[1:]
if fixture.get('fail'):
    print('ERROR: (gcloud) PERMISSION_DENIED', file=sys.stderr)
    sys.exit(1)
if args[:3] == ['run', 'services', 'list']:
    print(''.join(f"{name}\\t{region}\\n" for name, region in fixture['services']), end='')
elif args[:3] == ['run', 'services', 'get-iam-policy']:
    print(json.dumps(fixture['service_policies'].get(args[3], {})))
elif args[:3] == ['storage', 'buckets', 'list']:
    print(''.join(f"{name}\\t{pap}\\n" for name, pap in fixture['buckets']), end='')
elif args[:3] == ['storage', 'buckets', 'get-iam-policy']:
    print(json.dumps(fixture['bucket_policies'].get(args[3].removeprefix('gs://'), {})))
else:
    print('unexpected call: ' + ' '.join(args), file=sys.stderr)
    sys.exit(2)
'''


class NoPublicCheckTest(unittest.TestCase):
    def run_check(self, services=(), service_policies=None, buckets=(), bucket_policies=None, fail=False, env=None):
        with tempfile.TemporaryDirectory() as directory:
            fake = Path(directory) / 'gcloud'
            fake.write_text(FAKE_GCLOUD)
            fake.chmod(0o700)
            Path(str(fake) + '.json').write_text(json.dumps({
                'services': list(services),
                'service_policies': service_policies or {},
                'buckets': list(buckets),
                'bucket_policies': bucket_policies or {},
                'fail': fail,
            }))
            base = {key: value for key, value in os.environ.items() if key != 'PUBLIC_RUN_SERVICES'}
            full_env = {**base, 'PATH': directory + os.pathsep + os.environ['PATH'], **(env or {})}
            return subprocess.run(['bash', str(CHECK), 'p'], env=full_env, capture_output=True, text=True)

    def test_private_project_passes(self):
        result = self.run_check(
            services=[('discord-proxy', 'europe-west1')], service_policies={'discord-proxy': PRIVATE},
            buckets=[('p-function-sources', 'enforced')])
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_public_frontend_is_the_allowed_exception(self):
        result = self.run_check(services=[('frontend', 'europe-west1')], service_policies={'frontend': PUBLIC})
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_other_public_service_fails(self):
        result = self.run_check(services=[('discord-hello', 'europe-west1')], service_policies={'discord-hello': PUBLIC})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('discord-hello', result.stderr)

    def test_all_authenticated_users_is_public_too(self):
        policy = {'bindings': [{'role': 'roles/run.invoker', 'members': ['allAuthenticatedUsers']}]}
        result = self.run_check(services=[('tile-reader', 'europe-west1')], service_policies={'tile-reader': policy})
        self.assertNotEqual(result.returncode, 0)

    def test_exception_list_can_be_emptied(self):
        result = self.run_check(services=[('frontend', 'europe-west1')], service_policies={'frontend': PUBLIC},
                                env={'PUBLIC_RUN_SERVICES': ''})
        self.assertNotEqual(result.returncode, 0)

    def test_public_bucket_fails(self):
        policy = {'bindings': [{'role': 'roles/storage.objectViewer', 'members': ['allUsers']}]}
        result = self.run_check(buckets=[('p-snapshots', 'enforced')], bucket_policies={'p-snapshots': policy})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('p-snapshots', result.stderr)

    def test_bucket_without_public_access_prevention_fails(self):
        result = self.run_check(buckets=[('p-snapshots', 'inherited')])
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('public_access_prevention', result.stderr)

    def test_managed_function_staging_bucket_may_inherit(self):
        result = self.run_check(buckets=[('gcf-v2-sources-123-europe-west1', 'inherited')])
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_read_error_fails_closed(self):
        result = self.run_check(fail=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('Rien de public', result.stdout)


if __name__ == '__main__':
    unittest.main()
