#!/usr/bin/env python3
"""Regression tests for public RAG routing and isolated gateway credentials."""
import importlib.util
import subprocess
import sys
import tempfile
import re
import os
import shutil
import unittest
from pathlib import Path

DIRECTORY = Path(__file__).resolve().parent
SCRIPT = DIRECTORY / 'patch-nginx.py'
TOKEN = 'rag_fixture_token_0123456789abcdefgh'
BASE = '''server {
    location /api/ {
        if ($dm_authed = 0) { return 401; }
        proxy_set_header Authorization "Bearer pipeline_fixture";
    }
    location /pipeline/ {
        if ($dm_authed = 0) { return 302 https://songuu.top/login; }
        proxy_pass http://127.0.0.1:3000/;
    }
    location = / {
        root /opt/songuu-home;
    }
}
'''


class RagGatewayPublicAccessTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.config = Path(self.directory.name) / 'default.conf'
        self.env = Path(self.directory.name) / '.env.prod'
        self.config.write_text(BASE, encoding='utf-8')
        self.env.write_text('RAG_SINGLE_TENANT_TOKEN=' + TOKEN + '\n', encoding='utf-8')

    def run_patch(self, *args):
        return subprocess.run(
            [sys.executable, str(SCRIPT), '--config', str(self.config),
             '--env-file', str(self.env), *args],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True,
        )

    def installed(self):
        result = self.run_patch()
        self.assertEqual(result.returncode, 0, result.stderr)
        return self.config.read_text(encoding='utf-8')

    def assert_public(self, text):
        self.assertEqual(text.count('$dm_authed'), BASE.count('$dm_authed'))
        spec = importlib.util.spec_from_file_location('rag_nginx_patch', SCRIPT)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        for header in ('    location = /rag-system {',
                       '    location ^~ /rag-system/ {',
                       '    location ^~ /rag-api/ {'):
            _, _, block = module.find_block(text, header)
            self.assertNotIn('$dm_authed', block)
        self.assertIn('location ^~ /rag-system/api/ {\n        return 404;', text)
        self.assertIn('proxy_set_header Authorization "Bearer ' + TOKEN + '";', text)
        self.assertIn(BASE[BASE.index('    location /api/ {'):BASE.index('    location = / {')], text)

    def legacy(self):
        text = self.installed()
        for header, guard in (
            ('    location = /rag-system {', 'return 302 https://songuu.top/login;'),
            ('    location ^~ /rag-system/ {', 'return 302 https://songuu.top/login;'),
            ('    location ^~ /rag-api/ {', 'return 401;'),
        ):
            text = text.replace(header + '\n', header + '\n        if ($dm_authed = 0) { ' + guard + ' }\n')
        self.config.write_text(text, encoding='utf-8')
        return text

    def test_new_install_is_public_and_pipeline_stays_protected(self):
        self.assert_public(self.installed())

    def test_existing_public_policy_migration_is_idempotent(self):
        self.legacy()
        result = self.run_patch('--public-access')
        self.assertEqual(result.returncode, 0, result.stderr)
        public = self.config.read_text(encoding='utf-8')
        self.assert_public(public)
        result = self.run_patch('--public-access')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.config.read_text(encoding='utf-8'), public)

    def test_public_migration_refuses_ambiguous_locations_without_changes(self):
        text = self.legacy() + '\n    location ^~ /rag-api/ { return 404; }\n'
        self.config.write_text(text, encoding='utf-8')
        result = self.run_patch('--public-access')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('incomplete or ambiguous', result.stderr)
        self.assertEqual(self.config.read_text(encoding='utf-8'), text)

    def test_public_migration_refuses_unrecognized_session_guard(self):
        text = self.legacy().replace('if ($dm_authed = 0) { return 401; }',
                                    'if ($dm_authed != 1) { return 401; }')
        self.config.write_text(text, encoding='utf-8')
        result = self.run_patch('--public-access')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('unrecognized', result.stderr)
        self.assertEqual(self.config.read_text(encoding='utf-8'), text)

    def test_public_migration_ignores_comment_and_quoted_braces(self):
        text = self.legacy().replace(
            '    location = /rag-system {\n',
            '    location = /rag-system {\n        # closing brace } in a comment\n'
            '        add_header X-Test "quoted } and { braces";\n',
        )
        self.config.write_text(text, encoding='utf-8')
        result = self.run_patch('--public-access')
        self.assertEqual(result.returncode, 0, result.stderr)
        public = self.config.read_text(encoding='utf-8')
        self.assert_public(public)
        self.assertIn('# closing brace } in a comment', public)
        self.assertIn('add_header X-Test "quoted } and { braces";', public)

    def test_token_refresh_ignores_comments_and_escaped_quote_braces(self):
        text = self.installed().replace(
            '    location ^~ /rag-api/ {\n',
            '    location ^~ /rag-api/ {\n        # commented } brace\n'
            '        add_header X-Test "escaped \\\" } quote";\n',
        )
        self.config.write_text(text, encoding='utf-8')
        next_token = 'rag_next_fixture_token_0123456789abcd'
        self.env.write_text('RAG_SINGLE_TENANT_TOKEN=' + next_token + '\n', encoding='utf-8')
        result = self.run_patch('--refresh-token')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.config.read_text(encoding='utf-8'), text.replace(TOKEN, next_token))

    def test_token_refresh_only_changes_rag_bearer(self):
        original = self.legacy()
        next_token = 'rag_next_fixture_token_0123456789abcd'
        self.env.write_text('RAG_SINGLE_TENANT_TOKEN=' + next_token + '\n', encoding='utf-8')
        result = self.run_patch('--refresh-token')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.config.read_text(encoding='utf-8'), original.replace(TOKEN, next_token))

    def test_token_refresh_refuses_duplicate_authorization(self):
        text = self.installed().replace('proxy_set_header Authorization "Bearer ' + TOKEN + '";',
            'proxy_set_header Authorization "Bearer ' + TOKEN + '";\n        proxy_set_header Authorization "Bearer duplicate_fixture";')
        self.config.write_text(text, encoding='utf-8')
        result = self.run_patch('--refresh-token')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('exactly one RAG Authorization', result.stderr)
        self.assertEqual(self.config.read_text(encoding='utf-8'), text)

    def test_modes_are_mutually_exclusive(self):
        result = self.run_patch('--refresh-token', '--public-access')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.config.read_text(encoding='utf-8'), BASE)

    def test_unsafe_token_refused_without_config_mutation(self):
        self.env.write_text('RAG_SINGLE_TENANT_TOKEN=unsafe"token\n', encoding='utf-8')
        result = self.run_patch()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('unsafe nginx header format', result.stderr)
        self.assertEqual(self.config.read_text(encoding='utf-8'), BASE)



class GatewayReleaseAccessTests(unittest.TestCase):
    def run_verifier(self, ui_code, api_code, expected_ui='200', expected_api='200'):
        source = (DIRECTORY / 'post-release-gate.sh').read_text(encoding='utf-8')
        functions = []
        for name in ('gateway_code', 'rag_gateway_absent', 'verify_gateway'):
            match = re.search(r'^' + name + r'\(\) \{[\s\S]*?^\}', source, re.MULTILINE)
            self.assertIsNotNone(match, name + ' must have executable verifier coverage')
            functions.append(match.group())
        mock = """set -euo pipefail
DOMAIN_NAME=songuu.top
RAG_BASE_PATH=/rag-system
location_count() { printf '0'; }
curl() {
  case "${@: -1}" in
    *rag-api/health/live) printf '200' ;;
    *rag-system/api/health/live) printf '404' ;;
    *rag-api/health) printf '%s' ;;
    *rag-system) printf '%s' ;;
    *) return 2 ;;
  esac
}
""" % (api_code, ui_code)
        bash = os.environ.get('RAG_TEST_BASH', 'bash')
        if os.name == 'nt' and 'RAG_TEST_BASH' not in os.environ:
            git = shutil.which('git')
            self.assertIsNotNone(git, 'Git Bash or RAG_TEST_BASH is required on Windows')
            bash = str(Path(git).resolve().parent.parent / 'bin' / 'bash.exe')
        return subprocess.run([bash, '-c', mock + '\n'.join(functions) +
                               '\nverify_gateway ' + expected_ui + ' ' + expected_api],
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              universal_newlines=True)

    def test_public_release_verifier_accepts_new_devices(self):
        result = self.run_verifier('200', '200')
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_public_release_verifier_rejects_a_reintroduced_shared_login(self):
        for ui_code, api_code in (('302', '200'), ('200', '401')):
            result = self.run_verifier(ui_code, api_code)
            self.assertNotEqual(result.returncode, 0)

    def test_first_install_rollback_accepts_absent_rag_routes(self):
        self.assertEqual(self.run_verifier('404', '404', 'absent', 'absent').returncode, 0)

    def test_rollback_verifier_accepts_only_the_saved_access_policy(self):
        self.assertEqual(self.run_verifier('302', '401', '302', '401').returncode, 0)
        self.assertNotEqual(self.run_verifier('200', '200', '302', '401').returncode, 0)


if __name__ == '__main__':
    unittest.main()
