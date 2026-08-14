import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, '..', '..');
const workflow = readFileSync(
  path.join(root, '.github', 'workflows', 'deploy.yml'),
  'utf8'
).replaceAll('\r\n', '\n');
const dockerfile = readFileSync(path.join(root, 'Dockerfile'), 'utf8').replaceAll('\r\n', '\n');
const knownHosts = readFileSync(
  path.join(root, 'deploy', 'songuu', 'ssh-known-hosts'),
  'utf8'
).replaceAll('\r\n', '\n');
const postReleaseGate = readFileSync(
  path.join(root, 'deploy', 'songuu', 'post-release-gate.sh'),
  'utf8'
).replaceAll('\r\n', '\n');

function stepBody(name, nextName) {
  return workflow.match(
    new RegExp(`- name: ${name}\\n(?<body>[\\s\\S]*?)(?=\\n      - name: ${nextName})`)
  )?.groups?.body;
}

test('GitHub standalone archive carries the PostgreSQL migration runtime', () => {
  const packageStep = workflow.match(
    /- name: Package standalone release\n(?<body>[\s\S]*?)(?=\n      - name:)/
  )?.groups?.body;

  assert.ok(packageStep, 'Package standalone release step must exist');
  assert.match(dockerfile, /COPY --from=builder .*\/app\/db\/postgres \.\/db\/postgres/);
  assert.match(
    dockerfile,
    /COPY --from=builder .*\/app\/scripts\/migrate-postgres\.mjs \.\/scripts\/migrate-postgres\.mjs/
  );
  assert.match(
    dockerfile,
    /COPY --from=builder .*\/app\/scripts\/backfill-local-postgres\.mjs \.\/scripts\/backfill-local-postgres\.mjs/
  );
  assert.match(
    packageStep,
    /tar -C \/app --owner=0 --group=0 --numeric-owner -czf - server\.js \.next public node_modules db\/postgres scripts\/migrate-postgres\.mjs scripts\/backfill-local-postgres\.mjs/
  );
  assert.match(packageStep, /tar --numeric-owner -tvzf "\$\{archive\}"/);
  assert.match(packageStep, /awk '\$2 != "0\/0" \{ exit 1 \}'/);
  assert.match(packageStep, /grep -qx 'db\/postgres\/bootstrap\.sql' "\$\{entries\}"/);
  assert.match(
    packageStep,
    /grep -Eq '\^db\/postgres\/migrations\/\.\+\\\.sql\$' "\$\{entries\}"/
  );
  assert.match(
    packageStep,
    /grep -qx 'scripts\/migrate-postgres\.mjs' "\$\{entries\}"/
  );
  assert.match(
    packageStep,
    /grep -qx 'scripts\/backfill-local-postgres\.mjs' "\$\{entries\}"/
  );
});

test('GitHub deployment installs and passes the PostgreSQL host provisioner', () => {
  const uploadStep = stepBody(
    'Upload release and host scripts',
    'Remote atomic release and gateway verification'
  );
  const remoteStep = stepBody(
    'Remote atomic release and gateway verification',
    'Verify public deployment'
  );

  assert.ok(uploadStep, 'Upload release and host scripts step must exist');
  assert.ok(remoteStep, 'Remote atomic release step must exist');
  assert.match(uploadStep, /deploy\/songuu\/provision-postgres-host\.sh/);
  assert.match(
    remoteStep,
    /for script in [^\n]*provision-postgres-host\.sh[^\n]*; do/
  );
  assert.match(remoteStep, /chmod 700 [^\n]*provision-postgres-host\.sh/);
  assert.match(remoteStep, /bash -n "\$\{REMOTE_DIR\}\/provision-postgres-host\.sh"/);
  assert.match(
    remoteStep,
    /RAG_POSTGRES_PROVISIONER="\$\{REMOTE_DIR\}\/provision-postgres-host\.sh" \\\n+\s*RAG_ENV_DEFAULTS_RENDERER=/
  );
});

test('GitHub deployment creates an unpredictable root-only remote staging directory', () => {
  const configureStep = stepBody('Configure SSH', 'Create secure remote staging');
  const stagingStep = stepBody(
    'Create secure remote staging',
    'Upload release and host scripts'
  );
  const uploadStep = stepBody(
    'Upload release and host scripts',
    'Remote atomic release and gateway verification'
  );

  assert.ok(configureStep, 'Configure SSH step must precede secure staging');
  assert.ok(stagingStep, 'Create secure remote staging step must exist');
  assert.ok(uploadStep, 'Upload step must exist');
  assert.match(workflow, /REMOTE_PARENT=\/opt\/rag-system\/staging/);
  assert.match(stagingStep, /test "\$\(id -u\)" = '0'/);
  assert.match(stagingStep, /remote_root="\$\(dirname -- "\$\{REMOTE_PARENT\}"\)"/);
  assert.match(stagingStep, /test "\$\{remote_root\}" = '\/opt\/rag-system'/);
  assert.match(stagingStep, /test ! -L "\$\{remote_root\}"/);
  assert.match(stagingStep, /stat -c '%U:%G' -- "\$\{remote_root\}"/);
  assert.match(stagingStep, /stat -c '%a' -- "\$\{remote_root\}"/);
  assert.match(stagingStep, /test ! -L "\$\{REMOTE_PARENT\}"/);
  assert.match(stagingStep, /stat -c '%U:%G' -- "\$\{REMOTE_PARENT\}"/);
  assert.match(stagingStep, /stat -c '%a' -- "\$\{REMOTE_PARENT\}"/);
  assert.match(stagingStep, /umask 077/);
  assert.match(
    stagingStep,
    /mktemp -d "\$\{REMOTE_PARENT\}\/rag-system\.XXXXXXXXXX"/
  );
  assert.match(
    stagingStep,
    /"\$\{REMOTE_PARENT\}"\/rag-system\.\[A-Za-z0-9\]\[A-Za-z0-9\]\[A-Za-z0-9\]\[A-Za-z0-9\]\[A-Za-z0-9\]\[A-Za-z0-9\]\[A-Za-z0-9\]\[A-Za-z0-9\]\[A-Za-z0-9\]\[A-Za-z0-9\]/
  );
  assert.match(stagingStep, /test ! -L "\$\{remote_dir\}"/);
  assert.match(stagingStep, /stat -c '%U:%G' -- "\$\{remote_dir\}"/);
  assert.match(stagingStep, /stat -c '%a' -- "\$\{remote_dir\}"/);
  assert.doesNotMatch(workflow, /REMOTE_DIR=\/tmp\/rag-system-/);
  assert.doesNotMatch(workflow, /rag-system\.\?\?\?\?\?\?\?\?\?\?/);
  assert.doesNotMatch(workflow, /mkdir -p [^\n]*\$\{REMOTE_(?:DIR|PARENT)\}/);
});

test('uploaded staging payload is root-owned, private, non-symlink and hash-verified', () => {
  const uploadStep = stepBody(
    'Upload release and host scripts',
    'Remote atomic release and gateway verification'
  );

  assert.ok(uploadStep);
  assert.match(uploadStep, /sha256sum "\$\{source\}"/);
  assert.match(uploadStep, /rag-system-sha256sums\.txt/);
  assert.match(uploadStep, /test -d "\$\{REMOTE_DIR\}"/);
  assert.match(uploadStep, /test ! -L "\$\{REMOTE_DIR\}"/);
  assert.match(uploadStep, /stat -c '%U:%G' -- "\$\{REMOTE_DIR\}"/);
  assert.match(uploadStep, /stat -c '%a' -- "\$\{REMOTE_DIR\}"/);
  assert.match(uploadStep, /test -f "\$\{staged_file\}"/);
  assert.match(uploadStep, /test ! -L "\$\{staged_file\}"/);
  assert.match(uploadStep, /stat -c '%U:%G' -- "\$\{staged_file\}"/);
  assert.match(uploadStep, /chmod 600 -- "\$\{staged_file\}"/);
  assert.match(uploadStep, /stat -c '%a' -- "\$\{staged_file\}"/);
  assert.match(uploadStep, /sha256sum -c -- "\$\{REMOTE_CHECKSUMS_NAME\}"/);
});

test('remote deployment cleans exact staging and rolls shared runtime assets back on failure', () => {
  const remoteStep = stepBody(
    'Remote atomic release and gateway verification',
    'Verify public deployment'
  );

  assert.ok(remoteStep);
  const sharedDirectory = remoteStep.indexOf("shared_root='/opt/rag-system/shared'");
  const prepareSharedDirectory = remoteStep.indexOf('prepare_shared_directory');
  const prepareBackup = remoteStep.lastIndexOf('\n          prepare_shared_asset_backup\n');
  assert.ok(sharedDirectory >= 0);
  assert.ok(prepareSharedDirectory > sharedDirectory);
  assert.ok(prepareBackup > prepareSharedDirectory);
  assert.match(remoteStep, /test ! -L "\$\{shared_root\}"/);
  assert.match(remoteStep, /stat -c '%U:%G' -- "\$\{shared_root\}"/);
  assert.match(remoteStep, /stat -c '%a' -- "\$\{shared_root\}"/);
  assert.match(remoteStep, /trap remote_exit EXIT/);
  assert.match(remoteStep, /shared_backup_manifest="\$\{REMOTE_DIR\}\/shared-assets\.manifest"/);
  assert.match(remoteStep, /record_shared_asset run-rag-system\.sh/);
  assert.match(remoteStep, /record_shared_asset run-rag-system\.cjs/);
  assert.match(remoteStep, /record_shared_asset rag-system\.ecosystem\.config\.cjs/);
  assert.match(remoteStep, /record_shared_asset manage-rag-system-pm2\.sh/);
  assert.match(remoteStep, /rollback_shared_assets/);
  assert.match(remoteStep, /cleanup_allowed=0/);
  assert.match(remoteStep, /if \[ "\$\{cleanup_allowed\}" = '1' \]; then/);
  assert.match(remoteStep, /present\) restore_shared_asset/);
  assert.match(remoteStep, /absent\) rm -f -- "\$\{target\}"/);
  assert.match(remoteStep, /shared_assets_armed=0/);
  assert.ok(
    remoteStep.lastIndexOf('shared_assets_armed=0') >
      remoteStep.indexOf('"${REMOTE_DIR}/release-host.sh"'),
    'shared runtime rollback must remain armed until release-host succeeds'
  );
  assert.match(remoteStep, /cleanup_remote_staging/);
  assert.match(remoteStep, /test ! -L "\$\{REMOTE_DIR\}"/);
  assert.match(remoteStep, /validate_remote_staging \|\| return/);
  assert.match(remoteStep, /restore_shared_asset "\$\{backup_name\}" "\$\{target\}" \|\| return/);
  assert.match(remoteStep, /rm -rf -- "\$\{REMOTE_DIR\}"/);
  assert.doesNotMatch(remoteStep, /rm -rf "\$\{REMOTE_DIR\}"/);
});

test('remote deployment holds the environment reload lock while shared assets change', () => {
  const remoteStep = stepBody(
    'Remote atomic release and gateway verification',
    'Verify public deployment'
  );

  assert.ok(remoteStep);
  const lock = remoteStep.indexOf("lock_file='/run/lock/rag-system-env-reload.lock'");
  const flock = remoteStep.indexOf('flock -x 9');
  const prepare = remoteStep.lastIndexOf('\n          prepare_shared_asset_backup\n');
  const install = remoteStep.indexOf('install_shared_asset run-rag-system.sh');
  assert.ok(lock >= 0);
  assert.ok(flock > lock);
  assert.ok(prepare > flock);
  assert.ok(install > prepare);
  assert.match(remoteStep, /RAG_ENV_RELOAD_LOCK_HELD=1 \\\n+\s*RAG_POSTGRES_PROVISIONER=/);
});

test('GitHub deployment shell never enables tracing or prints secret values', () => {
  assert.doesNotMatch(workflow, /(?:^|\s)set\s+-[^\n]*x/m);
  assert.doesNotMatch(workflow, /(?:^|\s)(?:env|printenv)(?:\s|$)/m);
  const privateKeyWrite = /^\s*printf '%s\\n' "\$\{SSH_PRIVATE_KEY\}" > ~\/\.ssh\/rag_system_deploy_key$/m;
  assert.match(workflow, privateKeyWrite);
  const workflowWithoutPrivateKeyWrite = workflow.replace(privateKeyWrite, '');

  for (const secretName of [
    'SSH_PRIVATE_KEY',
    'DATABASE_URL',
    'POSTGRES_URL',
    'POSTGRES_MIGRATION_URL',
    'POSTGRES_PASSWORD',
  ]) {
    const unsafeLogLines = workflowWithoutPrivateKeyWrite
      .split('\n')
      .filter((line) => new RegExp(`(?:echo|printf).*\\$\\{${secretName}\\}`).test(line));
    assert.deepEqual(unsafeLogLines, [], `${secretName} must never be printed to CI logs`);
  }
});

test('SSH private key is scoped only to validation and key installation steps', () => {
  const jobEnvironment = workflow.match(
    /jobs:\n[\s\S]*?    env:\n(?<body>[\s\S]*?)(?=\n    steps:)/
  )?.groups?.body;
  const validateStep = stepBody('Validate deployment secret', 'Enable pnpm');
  const configureStep = stepBody('Configure SSH', 'Create secure remote staging');

  assert.ok(jobEnvironment, 'job environment must exist');
  assert.ok(validateStep, 'secret validation step must exist');
  assert.ok(configureStep, 'SSH configuration step must exist');
  assert.doesNotMatch(jobEnvironment, /SSH_PRIVATE_KEY/);
  assert.match(
    validateStep,
    /env:\n\s+SSH_PRIVATE_KEY: \$\{\{ secrets\.RAG_SYSTEM_SSH_PRIVATE_KEY \}\}/
  );
  assert.match(
    configureStep,
    /env:\n\s+SSH_PRIVATE_KEY: \$\{\{ secrets\.RAG_SYSTEM_SSH_PRIVATE_KEY \}\}/
  );
  assert.equal(
    [...workflow.matchAll(/secrets\.RAG_SYSTEM_SSH_PRIVATE_KEY/g)].length,
    2,
    'the private key secret must not be injected into any other step'
  );
});

test('SSH trusts an audited host key and fails closed for unpinned hosts', () => {
  const configureStep = stepBody('Configure SSH', 'Create secure remote staging');

  assert.ok(configureStep);
  assert.match(
    knownHosts,
    /^47\.253\.230\.197 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKulmxuil4LA5L7EMfb8Ygd46MxyPkBwvx\/FDE03reOO$/m
  );
  assert.doesNotMatch(workflow, /ssh-keyscan/);
  assert.match(configureStep, /deploy\/songuu\/ssh-known-hosts/);
  assert.match(configureStep, /RAG_SYSTEM_SSH_KNOWN_HOSTS/);
  assert.match(configureStep, /ssh-keygen -F "\$\{DEPLOY_HOST\}"/);
  assert.match(configureStep, /Missing required GitHub secret RAG_SYSTEM_SSH_KNOWN_HOSTS/);
  assert.equal(
    [...workflow.matchAll(/-o StrictHostKeyChecking=yes/g)].length,
    [...workflow.matchAll(/-o BatchMode=yes/g)].length,
    'every non-interactive SSH/SCP call must enforce strict host-key checking'
  );
  assert.equal(
    [...workflow.matchAll(/-o UserKnownHostsFile="\$\{HOME\}\/\.ssh\/known_hosts"/g)].length,
    [...workflow.matchAll(/-o BatchMode=yes/g)].length,
    'every non-interactive SSH/SCP call must use the staged pinned file'
  );
});

test('long remote release keeps its SSH transport alive during quiet provisioning', () => {
  const remoteStep = stepBody(
    'Remote atomic release and gateway verification',
    'Verify public deployment'
  );

  assert.ok(remoteStep, 'Remote atomic release step must exist');
  const releaseCommand = remoteStep.slice(0, remoteStep.indexOf("<<'REMOTE_SCRIPT'"));
  assert.match(releaseCommand, /-o ServerAliveInterval=30/);
  assert.match(releaseCommand, /-o ServerAliveCountMax=20/);
  assert.match(releaseCommand, /-o TCPKeepAlive=yes/);
});

test('remote gateway and watcher gate remains inside the release transaction', () => {
  const uploadStep = stepBody(
    'Upload release and host scripts',
    'Remote atomic release and gateway verification'
  );
  const remoteStep = stepBody(
    'Remote atomic release and gateway verification',
    'Verify public deployment'
  );

  assert.ok(uploadStep);
  assert.ok(remoteStep);
  assert.match(uploadStep, /deploy\/songuu\/post-release-gate\.sh/);
  assert.match(remoteStep, /post-release-gate\.sh/);
  assert.match(remoteStep, /chmod 700 [^\n]*post-release-gate\.sh/);
  assert.match(remoteStep, /bash -n "\$\{REMOTE_DIR\}\/post-release-gate\.sh"/);
  assert.match(
    remoteStep,
    /RAG_POST_RELEASE_GATE="\$\{REMOTE_DIR\}\/post-release-gate\.sh" \\\n+\s*RAG_RELEASE_GATE_ROOT="\$\{REMOTE_DIR\}" \\\n+\s*RAG_ENV_RELOAD_LOCK_HELD=1/
  );

  const releaseInvocation = remoteStep.indexOf('"${REMOTE_DIR}/release-host.sh"');
  const rollbackDisarm = remoteStep.lastIndexOf('shared_assets_armed=0');
  assert.ok(releaseInvocation >= 0);
  assert.ok(rollbackDisarm > releaseInvocation);
  const afterDisarm = remoteStep.slice(rollbackDisarm);
  assert.doesNotMatch(afterDisarm, /systemctl|nginx|refresh-rag|curl|last-known-good/);

  assert.match(postReleaseGate, /case "\$MODE" in/);
  assert.match(postReleaseGate, /verify\)/);
  assert.match(postReleaseGate, /rollback\)/);
  assert.match(postReleaseGate, /snapshot_file/);
  assert.match(postReleaseGate, /restore_snapshots/);
  assert.match(postReleaseGate, /\/etc\/nginx\/conf\.d\/default\.conf/);
  assert.match(postReleaseGate, /rag-system-env-reload\.service/);
  assert.match(postReleaseGate, /rag-system-env-reload\.path/);
  assert.match(postReleaseGate, /\.env\.prod\.last-known-good/);
  assert.match(postReleaseGate, /\.env\.prod\.last-applied\.sha256/);
  assert.match(postReleaseGate, /systemctl enable --now rag-system-env-reload\.path/);
  assert.match(postReleaseGate, /refresh-rag-nginx-token\.sh/);
  assert.match(postReleaseGate, /\/rag-api\/health\/live/);
  assert.match(postReleaseGate, /RAG_BASE_PATH}\/api\/health\/live/);
  assert.match(postReleaseGate, /restore_watcher_state/);
  assert.match(postReleaseGate, /verify_restored_snapshots/);
  assert.match(postReleaseGate, /verify_gateway \|\| rollback_failed=1/);
  assert.match(postReleaseGate, /systemctl reload nginx/);
  assert.match(remoteStep, /post-release-gate-state\/rollback\.failed/);
  assert.match(remoteStep, /Preserving protected staging after post-release rollback failure/);
});
