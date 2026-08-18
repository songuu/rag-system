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
const releaseHost = readFileSync(
  path.join(root, 'deploy', 'songuu', 'release-host.sh'),
  'utf8'
).replaceAll('\r\n', '\n');
const postgresProvisioner = readFileSync(
  path.join(root, 'deploy', 'songuu', 'provision-postgres-host.sh'),
  'utf8'
).replaceAll('\r\n', '\n');
const publicPostgresVerifier = readFileSync(
  path.join(root, 'scripts', 'verify-postgres-public.mjs'),
  'utf8'
).replaceAll('\r\n', '\n');
const publicPostgresVerifierTest = readFileSync(
  path.join(root, 'scripts', 'verify-postgres-public.test.mjs'),
  'utf8'
).replaceAll('\r\n', '\n');

function stepBody(name, nextName) {
  const boundary = nextName
    ? `(?=\\n      - name: ${nextName})`
    : '$';
  return workflow.match(
    new RegExp(`- name: ${name}\\n(?<body>[\\s\\S]*?)${boundary}`)
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
    dockerfile,
    /COPY --from=builder .*\/app\/scripts\/verify-postgres-runtime\.mjs \.\/scripts\/verify-postgres-runtime\.mjs/
  );
  assert.match(
    packageStep,
    /tar -C \/app --owner=0 --group=0 --numeric-owner -czf - server\.js \.next public node_modules db\/postgres scripts\/migrate-postgres\.mjs scripts\/backfill-local-postgres\.mjs scripts\/verify-postgres-runtime\.mjs/
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
  assert.match(
    packageStep,
    /grep -qx 'scripts\/verify-postgres-runtime\.mjs' "\$\{entries\}"/
  );
});

test('GitHub quality gates exercise a pinned real PostgreSQL 17 service', () => {
  const qualityGateStep = stepBody('Run RAG quality gates', 'Build Linux production image');
  const provisionedImage = postgresProvisioner.match(
    /readonly CONTAINER_IMAGE='(?<image>postgres:17-[^']+@sha256:[0-9a-f]{64})'/
  )?.groups?.image;

  assert.ok(provisionedImage, 'host provisioner must pin a PostgreSQL 17 image digest');
  assert.ok(qualityGateStep, 'RAG quality gate step must exist');
  assert.ok(
    workflow.includes(`services:\n      postgres:\n        image: ${provisionedImage}`),
    'CI PostgreSQL service must reuse the host provisioner image digest'
  );
  assert.match(workflow, /POSTGRES_USER: rag_ci_owner/);
  assert.match(workflow, /POSTGRES_PASSWORD: rag_ci_ephemeral_password/);
  assert.match(workflow, /POSTGRES_DB: rag_ci/);
  assert.match(workflow, /- 54329:5432/);
  assert.match(workflow, /--health-cmd "pg_isready -U rag_ci_owner -d rag_ci"/);
  assert.match(
    qualityGateStep,
    /env:\n\s+TEST_DATABASE_URL: postgresql:\/\/rag_ci_owner:rag_ci_ephemeral_password@127\.0\.0\.1:54329\/rag_ci/
  );
  assert.match(qualityGateStep, /pnpm test:postgres:integration/);
  assert.match(qualityGateStep, /node scripts\/verify-postgres-public\.test\.mjs/);
});

test('GitHub deployment installs and passes the PostgreSQL host provisioner', () => {
  const uploadStep = stepBody(
    'Upload release and host scripts',
    'Provision public PostgreSQL host'
  );
  const remoteStep = stepBody(
    'Remote atomic release and gateway verification',
    'Verify released PostgreSQL public contract'
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

test('GitHub release safely passes DEPLOY_HOST as the PostgreSQL public identity', () => {
  const defaultsStep = stepBody('Set deployment defaults', 'Validate deployment secret');
  const remoteStep = stepBody(
    'Remote atomic release and gateway verification',
    'Verify released PostgreSQL public contract'
  );

  assert.ok(defaultsStep, 'deployment defaults step must exist');
  assert.ok(remoteStep, 'remote release step must exist');
  assert.match(defaultsStep, /DEPLOY_HOST="\$\{DEPLOY_HOST:-47\.253\.230\.197\}"/);
  assert.match(defaultsStep, /\[\[ ! "\$\{DEPLOY_HOST\}" =~ \^\[A-Za-z0-9\]/);
  assert.match(defaultsStep, /Unsafe DEPLOY_HOST/);
  assert.match(
    remoteStep,
    /RAG_POSTGRES_PUBLIC_HOST='\$\{DEPLOY_HOST\}'[^\n]*bash -s/
  );
  assert.match(
    remoteStep,
    /RAG_POSTGRES_PUBLIC_HOST="\$\{RAG_POSTGRES_PUBLIC_HOST\}" \\\n+\s*RAG_POSTGRES_CUTOVER_TOKEN="\$\{RAG_POSTGRES_CUTOVER_TOKEN\}" \\\n+\s*RAG_POSTGRES_CUTOVER_ACTION=activate \\\n+\s*RAG_POSTGRES_PROVISIONER=/
  );
});

test('public PostgreSQL network gate precedes and full gate follows app release', () => {
  const provisionStep = stepBody(
    'Provision public PostgreSQL host',
    'Verify public PostgreSQL TLS endpoint'
  );
  const publicPostgresStep = stepBody(
    'Verify public PostgreSQL TLS endpoint',
    'Remote atomic release and gateway verification'
  );
  const remoteReleaseStep = stepBody(
    'Remote atomic release and gateway verification',
    'Verify released PostgreSQL public contract'
  );
  const rollbackStep = stepBody('Roll back unfinished public PostgreSQL cutover');
  const releasedPublicPostgresStep = stepBody(
    'Verify released PostgreSQL public contract',
    'Verify public deployment'
  );
  const provisionPosition = workflow.indexOf('- name: Provision public PostgreSQL host');
  const publicGatePosition = workflow.indexOf('- name: Verify public PostgreSQL TLS endpoint');
  const releasePosition = workflow.indexOf('- name: Remote atomic release and gateway verification');
  const releasedPublicGatePosition = workflow.indexOf(
    '- name: Verify released PostgreSQL public contract'
  );
  const publicDeploymentPosition = workflow.indexOf('- name: Verify public deployment');
  const rollbackPosition = workflow.indexOf(
    '- name: Roll back unfinished public PostgreSQL cutover'
  );

  assert.ok(provisionStep, 'public PostgreSQL provision step must exist');
  assert.ok(publicPostgresStep, 'public PostgreSQL verification step must exist');
  assert.ok(remoteReleaseStep, 'remote release transaction must exist');
  assert.ok(rollbackStep, 'cross-step PostgreSQL rollback guard must exist');
  assert.ok(releasedPublicPostgresStep, 'post-migration public PostgreSQL gate must exist');
  assert.ok(provisionPosition >= 0 && publicGatePosition > provisionPosition);
  assert.ok(releasePosition > publicGatePosition, 'external database gate must precede app release');
  assert.ok(
    releasedPublicGatePosition > releasePosition,
    'full external database gate must follow release migration and runtime probes'
  );
  assert.ok(
    rollbackPosition > publicDeploymentPosition,
    'pending cutover finalizer must remain after every release verification step'
  );
  assert.match(
    provisionStep,
    /RAG_POSTGRES_PUBLIC_HOST='\$\{DEPLOY_HOST\}'[^\n]*bash -s/
  );
  assert.match(provisionStep, /tr -d '\\r' < "\$\{provisioner\}"/);
  assert.match(provisionStep, /chmod 700 -- "\$\{provisioner\}"/);
  assert.match(provisionStep, /bash -n "\$\{provisioner\}"/);
  assert.match(
    provisionStep,
    /RAG_POSTGRES_PUBLIC_HOST="\$\{RAG_POSTGRES_PUBLIC_HOST\}" \\\n+\s*RAG_POSTGRES_CUTOVER_TOKEN="\$\{RAG_POSTGRES_CUTOVER_TOKEN\}" \\\n+\s*RAG_POSTGRES_CUTOVER_ACTION=prepare \\\n+\s*"\$\{provisioner\}"/
  );
  assert.match(provisionStep, /RAG_POSTGRES_CUTOVER_TOKEN='\$\{RELEASE_NAME\}'/);
  assert.match(provisionStep, /prepare_succeeded=0/);
  assert.match(
    provisionStep,
    /if \[ "\$\{prepare_succeeded\}" = '1' \]; then[\s\S]*RAG_POSTGRES_CUTOVER_ACTION=rollback/
  );
  assert.match(
    provisionStep,
    /RAG_POSTGRES_CUTOVER_ACTION=prepare[\s\S]*prepare_succeeded=1/
  );
  assert.match(provisionStep, /RAG_POSTGRES_CUTOVER_ACTION=prepare/);
  assert.match(provisionStep, /RAG_POSTGRES_CUTOVER_ACTION=rollback/);
  assert.match(provisionStep, /cleanup_failed_preflight/);
  assert.match(postgresProvisioner, /prepare\|activate\|finalize\|rollback\|verify/);
  assert.match(postgresProvisioner, /readonly CUTOVER_TOKEN="\$\{RAG_POSTGRES_CUTOVER_TOKEN:-\}"/);
  assert.match(postgresProvisioner, /pending_token/);
  assert.match(postgresProvisioner, /does not own the pending PostgreSQL public cutover/);
  assert.match(postgresProvisioner, /prepare cannot downgrade an active or committed transaction/);
  assert.match(postgresProvisioner, /write_cutover_marker activated/);
  assert.match(postgresProvisioner, /cutover_irreversible=true/);
  assert.match(postgresProvisioner, /rollback is intentionally skipped/);
  assert.doesNotMatch(postgresProvisioner, /state=committed/);
  const finalizeBlock = postgresProvisioner.slice(
    postgresProvisioner.lastIndexOf('[[ "$CUTOVER_ACTION" = finalize ]]')
  );
  const finalizingReceipt = finalizeBlock.indexOf('write_cutover_marker finalizing');
  const irreversibleBackupRemoval = finalizeBlock.indexOf('docker rm "$CONTAINER_BACKUP_NAME"');
  const finalizedReceipt = finalizeBlock.indexOf('write_cutover_marker finalized');
  const committedCleanup = finalizeBlock.indexOf('cleanup_committed_cutover_state');
  assert.ok(finalizingReceipt >= 0);
  assert.ok(irreversibleBackupRemoval > finalizingReceipt);
  assert.ok(finalizedReceipt > irreversibleBackupRemoval);
  assert.ok(committedCleanup > finalizedReceipt);
  assert.match(postgresProvisioner, /cleanup remains pending/);
  assert.match(releaseHost, /readonly POSTGRES_CUTOVER_TOKEN=/);
  assert.match(releaseHost, /RAG_POSTGRES_CUTOVER_TOKEN="\$POSTGRES_CUTOVER_TOKEN"/);
  assert.match(releaseHost, /postgres_finalize_started=false/);
  assert.match(
    releaseHost,
    /run_postgres_finalize_action\(\)[\s\S]*RAG_POSTGRES_CUTOVER_ACTION=finalize[\s\S]*RAG_POSTGRES_CUTOVER_TOKEN="\$POSTGRES_CUTOVER_TOKEN"/
  );
  assert.match(
    releaseHost,
    /reconcile_postgres_finalize_receipt\(\)[\s\S]*run_postgres_finalize_action[\s\S]*run_postgres_verify_action[\s\S]*release_committed=true/
  );
  const releaseVerifyAction = releaseHost.match(
    /run_postgres_verify_action\(\) \{[\s\S]*?\n\}/
  );
  assert.ok(releaseVerifyAction);
  assert.match(releaseVerifyAction[0], /RAG_POSTGRES_CUTOVER_ACTION=verify/);
  assert.doesNotMatch(releaseVerifyAction[0], /RAG_POSTGRES_CUTOVER_TOKEN=/);
  assert.match(
    postgresProvisioner,
    /if \[\[ "\$CUTOVER_ACTION" = verify \]\]; then[\s\S]*pending_state" = finalizing[\s\S]*pending_state" = finalized[\s\S]*rollback-capable/
  );
  const releaseExitTrap = releaseHost.slice(
    releaseHost.indexOf('release_exit_trap() {'),
    releaseHost.indexOf('trap release_exit_trap EXIT')
  );
  assert.ok(
    releaseExitTrap.indexOf('reconcile_postgres_finalize_receipt') <
      releaseExitTrap.indexOf('restore_database_environment'),
    'lost finalize acknowledgements must be reconciled before app environment rollback'
  );
  assert.match(
    releaseHost,
    /if ! finalize_postgres_cutover; then[\s\S]*reconcile_postgres_finalize_receipt[\s\S]*elif rollback/
  );
  assert.match(releaseHost, /RAG_RELEASE_RECEIPT_ROOT:-/);
  assert.match(releaseHost, /RAG_RELEASE_RECEIPT:-/);
  assert.match(
    releaseHost,
    /write_release_receipt\(\)[\s\S]*release=%s\\ntoken=%s\\nstate=%s\\n[\s\S]*chmod 600[\s\S]*sync -f/
  );
  assert.match(releaseHost, /write_release_receipt app-committed/);
  assert.match(releaseHost, /write_release_receipt app-rolled-back/);

  assert.match(publicPostgresStep, /readonly postgres_public_port='25432'/);
  assert.match(
    publicPostgresStep,
    /mktemp -d "\$\{RUNNER_TEMP\}\/rag-postgres-public\.XXXXXXXXXX"/
  );
  assert.match(publicPostgresStep, /trap cleanup_public_postgres_probe EXIT/);
  assert.match(
    publicPostgresStep,
    /rm -f -- "\$\{postgres_ca\}" "\$\{public_client_env\}"/
  );
  assert.match(publicPostgresStep, /rmdir -- "\$\{probe_dir\}"/);
  assert.match(
    publicPostgresStep,
    /scp -i ~\/\.ssh\/rag_system_deploy_key -o BatchMode=yes \\\n+\s*-o StrictHostKeyChecking=yes -o UserKnownHostsFile="\$\{HOME\}\/\.ssh\/known_hosts"/
  );
  assert.match(
    publicPostgresStep,
    /"\$\{DEPLOY_USER\}@\$\{DEPLOY_HOST\}:\/opt\/rag-system\/shared\/\.postgres-host\/tls\/ca\.crt"/
  );
  assert.match(
    publicPostgresStep,
    /"\$\{DEPLOY_USER\}@\$\{DEPLOY_HOST\}:\/opt\/rag-system\/shared\/\.postgres-host\/tls\/rag-app-client\.env"/
  );
  assert.match(
    publicPostgresStep,
    /chmod 600 -- "\$\{postgres_ca\}" "\$\{public_client_env\}"/
  );
  assert.match(publicPostgresStep, /PGSSLMODE\|PGSSLROOTCERT/);
  assert.match(publicPostgresStep, /\. "\$\{public_client_env\}"/);
  assert.match(publicPostgresStep, /export PGSSLMODE='verify-full'/);
  assert.match(publicPostgresStep, /PGSSLROOTCERT="\$\(readlink -f -- "\$\{postgres_ca\}"\)"/);
  assert.match(publicPostgresStep, /POSTGRES_PUBLIC_EXPECTED_HOST="\$\{DEPLOY_HOST\}"/);
  assert.match(publicPostgresStep, /POSTGRES_PUBLIC_VERIFY_PHASE='network'/);
  assert.match(publicPostgresStep, /timeout 30 node scripts\/verify-postgres-public\.mjs/);
  assert.match(publicPostgresStep, /cloud security group allows this port from the runner/);
  assert.match(publicPostgresStep, /REMOTE_CLEANUP/);
  assert.match(publicPostgresStep, /RAG_POSTGRES_CUTOVER_ACTION=rollback/);
  assert.match(publicPostgresStep, /RAG_POSTGRES_CUTOVER_TOKEN='\$\{RELEASE_NAME\}'/);
  assert.match(
    publicPostgresStep,
    /RAG_POSTGRES_CUTOVER_TOKEN="\$\{RAG_POSTGRES_CUTOVER_TOKEN\}" \\\n+\s*RAG_POSTGRES_CUTOVER_ACTION=rollback/
  );
  assert.doesNotMatch(
    publicPostgresStep,
    /RAG_POSTGRES_CUTOVER_ACTION=(?:commit|activate|finalize)|cutover_committed/
  );
  assert.match(
    remoteReleaseStep,
    /RAG_POSTGRES_CUTOVER_TOKEN="\$\{RAG_POSTGRES_CUTOVER_TOKEN\}" \\\n+\s*RAG_POSTGRES_CUTOVER_ACTION=activate \\\n+\s*RAG_POSTGRES_PROVISIONER=/
  );
  assert.match(remoteReleaseStep, /RAG_POSTGRES_CUTOVER_TOKEN='\$\{RELEASE_NAME\}'/);
  assert.match(releaseHost, /Host release PostgreSQL action must be activate or verify/);
  assert.ok(
    releaseHost.indexOf('run_post_release_gate verify') <
      releaseHost.lastIndexOf('finalize_postgres_cutover'),
    'PostgreSQL topology must finalize only after release readiness and gateway verification'
  );
  assert.ok(
    releaseHost.lastIndexOf('finalize_postgres_cutover') <
      releaseHost.lastIndexOf('release_committed=true'),
    'PostgreSQL finalization must remain inside the release transaction'
  );
  assert.match(remoteReleaseStep, /rollback_pending_postgres\(\)/);
  assert.match(
    remoteReleaseStep,
    /remote_exit\(\) \{[\s\S]*rollback_pending_postgres[\s\S]*cleanup_remote_staging/
  );
  const remoteExit = remoteReleaseStep.match(/remote_exit\(\) \{[\s\S]*?\n          \}/);
  const receiptValidator = remoteReleaseStep.match(
    /validate_app_release_receipt\(\) \{[\s\S]*?\n          \}/
  );
  assert.ok(remoteExit);
  assert.ok(receiptValidator);
  assert.match(receiptValidator[0], /release-state\.receipt/);
  assert.match(receiptValidator[0], /stat -c '%U:%G'/);
  assert.match(receiptValidator[0], /stat -c '%a'/);
  assert.match(receiptValidator[0], /wc -l/);
  assert.match(receiptValidator[0], /receipt_release.*RELEASE_NAME/);
  assert.match(receiptValidator[0], /receipt_token.*RAG_POSTGRES_CUTOVER_TOKEN/);
  assert.match(receiptValidator[0], /app-committed\|app-rolled-back/);
  assert.match(remoteReleaseStep, /RAG_RELEASE_RECEIPT_ROOT="\$\{REMOTE_DIR\}"/);
  assert.match(remoteReleaseStep, /RAG_RELEASE_RECEIPT="\$\{release_receipt\}"/);
  assert.match(
    remoteReleaseStep,
    /reconcile_committed_postgres\(\)[\s\S]*RAG_POSTGRES_CUTOVER_ACTION=verify/
  );
  assert.doesNotMatch(
    remoteReleaseStep.match(/reconcile_committed_postgres\(\) \{[\s\S]*?\n          \}/)[0],
    /RAG_POSTGRES_CUTOVER_ACTION=finalize|RAG_POSTGRES_CUTOVER_TOKEN=/
  );
  assert.ok(
    remoteExit[0].indexOf('validate_app_release_receipt') <
      remoteExit[0].indexOf('reconcile_committed_postgres')
  );
  assert.ok(
    remoteExit[0].indexOf('reconcile_committed_postgres') <
      remoteExit[0].indexOf('rollback_pending_postgres')
  );
  assert.ok(
    remoteExit[0].indexOf('shared_assets_armed=0') <
      remoteExit[0].indexOf('rollback_shared_assets')
  );
  assert.match(
    remoteExit[0],
    /\[ "\$\{app_recovery_authorized\}" = '1' \] && \[ "\$\{shared_assets_armed\}" = '1' \]/
  );
  assert.match(
    remoteExit[0],
    /app_release_state}" = 'app-committed'[\s\S]*reconcile_committed_postgres; then[\s\S]*shared_assets_armed=0[\s\S]*cleanup_allowed=0/
  );
  assert.match(
    remoteExit[0],
    /No valid durable app receipt exists; preserving PostgreSQL, app\/current, shared assets[\s\S]*cleanup_allowed=0/
  );
  assert.match(
    remoteExit[0],
    /else[\s\S]*app_recovery_authorized=1[\s\S]*rollback_pending_postgres/
  );
  assert.match(remoteReleaseStep, /postgres-rollback\.failed/);
  assert.match(remoteReleaseStep, /cleanup_allowed=0/);
  assert.doesNotMatch(publicPostgresStep, /openssl s_client|printenv|credentials\.env/);
  assert.match(rollbackStep, /if: \$\{\{ failure\(\) \|\| cancelled\(\) \}\}/);
  assert.match(rollbackStep, /RELEASE_NAME='\$\{RELEASE_NAME\}'/);
  const finalizerReceipt = rollbackStep.match(
    /validate_finalizer_release_receipt\(\) \{[\s\S]*?\n          \}/
  );
  const finalizerCommitted = rollbackStep.match(
    /if \[ "\$\{app_release_state\}" = 'app-committed' \]; then[\s\S]*?\n          fi/
  );
  assert.ok(finalizerReceipt);
  assert.ok(finalizerCommitted);
  const finalizerLock = rollbackStep.indexOf("lock_file='/run/lock/rag-system-env-reload.lock'");
  const finalizerFlock = rollbackStep.indexOf('flock -w 120 -x 9');
  const finalizerReceiptRead = rollbackStep.indexOf('release_started=0');
  const finalizerRollback = rollbackStep.indexOf('RAG_POSTGRES_CUTOVER_ACTION=rollback');
  assert.ok(finalizerLock >= 0);
  assert.ok(finalizerFlock > finalizerLock);
  assert.ok(finalizerReceiptRead > finalizerFlock);
  assert.ok(finalizerRollback > finalizerReceiptRead);
  assert.match(rollbackStep, /test ! -L "\$\{lock_file\}"/);
  assert.match(rollbackStep, /stat -c '%U:%G' -- "\$\{lock_file\}"/);
  assert.match(rollbackStep, /chmod 600 -- "\$\{lock_file\}"/);
  assert.match(rollbackStep, /Timed out waiting for the release transaction lock/);
  assert.match(rollbackStep, /release_started=0/);
  assert.match(rollbackStep, /shared-assets\.manifest/);
  assert.match(finalizerReceipt[0], /stat -c '%U:%G'/);
  assert.match(finalizerReceipt[0], /stat -c '%a'/);
  assert.match(finalizerReceipt[0], /receipt_release.*RELEASE_NAME/);
  assert.match(finalizerReceipt[0], /receipt_token.*RAG_POSTGRES_CUTOVER_TOKEN/);
  assert.match(finalizerReceipt[0], /app-committed\|app-rolled-back/);
  assert.match(
    rollbackStep,
    /release_started}" = '1'[\s\S]*! validate_finalizer_release_receipt[\s\S]*preserving PostgreSQL, app\/current, shared assets, and staging[\s\S]*exit 1/
  );
  assert.match(finalizerCommitted[0], /RAG_POSTGRES_CUTOVER_ACTION=verify/);
  assert.doesNotMatch(finalizerCommitted[0], /RAG_POSTGRES_CUTOVER_TOKEN=/);
  assert.ok(
    rollbackStep.indexOf('RAG_POSTGRES_CUTOVER_ACTION=verify') <
      finalizerRollback
  );
  assert.match(rollbackStep, /RAG_POSTGRES_CUTOVER_ACTION=rollback/);
  assert.match(rollbackStep, /RAG_POSTGRES_CUTOVER_TOKEN='\$\{RELEASE_NAME\}'/);
  assert.match(
    rollbackStep,
    /RAG_POSTGRES_CUTOVER_TOKEN="\$\{RAG_POSTGRES_CUTOVER_TOKEN\}" \\\n+\s*RAG_POSTGRES_CUTOVER_ACTION=rollback/
  );
  assert.match(rollbackStep, /protected staging was retained for audit/);

  assert.match(publicPostgresVerifier, /requireExact\(env, 'PGSSLMODE', 'verify-full'\)/);
  assert.match(publicPostgresVerifier, /POSTGRES_PUBLIC_VERIFY_PHASE/);
  assert.match(publicPostgresVerifier, /network/);
  assert.match(publicPostgresVerifier, /full/);
  assert.match(publicPostgresVerifier, /checkServerIdentity\(expectedHost, certificate\)/);
  assert.match(publicPostgresVerifier, /FROM pg_stat_ssl/);
  assert.match(publicPostgresVerifier, /server_version_num < 170_000/);
  assert.match(publicPostgresVerifier, /operational_dml !== true/);
  assert.match(publicPostgresVerifier, /parent_write_denied !== true/);
  assert.match(publicPostgresVerifier, /ssl: false/);
  assert.match(publicPostgresVerifier, /error\.code === '28000'/);
  assert.match(
    publicPostgresVerifier,
    /assertRestrictedRoleRejected\(createClient, (?:clientConfig|config), 'rag_owner'\)/
  );
  assert.match(
    publicPostgresVerifier,
    /assertRestrictedRoleRejected\(createClient, (?:clientConfig|config), 'postgres'\)/
  );
  assert.match(publicPostgresVerifier, /randomBytes\(32\)\.toString\('hex'\)/);
  assert.match(publicPostgresVerifierTest, /does not expose credentials or endpoint details/);
  assert.match(
    publicPostgresVerifierTest,
    /network phase verifies an empty PG17 database without referencing application tables/
  );
  assert.doesNotMatch(
    publicPostgresStep,
    /POSTGRES_URL|POSTGRES_MIGRATION_URL|OWNER_PASSWORD|ADMIN_PASSWORD/
  );

  assert.match(
    releasedPublicPostgresStep,
    /mktemp -d "\$\{RUNNER_TEMP\}\/rag-postgres-public-full\.XXXXXXXXXX"/
  );
  assert.match(releasedPublicPostgresStep, /trap cleanup_released_public_postgres_probe EXIT/);
  assert.match(
    releasedPublicPostgresStep,
    /scp -i ~\/\.ssh\/rag_system_deploy_key -o BatchMode=yes \\\n+\s*-o StrictHostKeyChecking=yes -o UserKnownHostsFile="\$\{HOME\}\/\.ssh\/known_hosts"/
  );
  assert.match(
    releasedPublicPostgresStep,
    /tls\/ca\.crt"[\s\S]*tls\/rag-app-client\.env"/
  );
  assert.match(
    releasedPublicPostgresStep,
    /chmod 600 -- "\$\{postgres_ca\}" "\$\{public_client_env\}"/
  );
  assert.match(releasedPublicPostgresStep, /wc -l < "\$\{public_client_env\}"\)" -ne 7/);
  assert.match(releasedPublicPostgresStep, /\. "\$\{public_client_env\}"/);
  assert.match(releasedPublicPostgresStep, /export PGSSLMODE='verify-full'/);
  assert.match(
    releasedPublicPostgresStep,
    /PGSSLROOTCERT="\$\(readlink -f -- "\$\{postgres_ca\}"\)"/
  );
  assert.match(
    releasedPublicPostgresStep,
    /POSTGRES_PUBLIC_EXPECTED_HOST="\$\{DEPLOY_HOST\}"/
  );
  assert.match(releasedPublicPostgresStep, /POSTGRES_PUBLIC_VERIFY_PHASE='full'/);
  assert.match(
    releasedPublicPostgresStep,
    /timeout 30 node scripts\/verify-postgres-public\.mjs/
  );
  assert.match(releasedPublicPostgresStep, /release completed, but PostgreSQL post-migration/);
  assert.match(
    releasedPublicPostgresStep,
    /rm -f -- "\$\{postgres_ca\}" "\$\{public_client_env\}"/
  );
  assert.doesNotMatch(
    releasedPublicPostgresStep,
    /POSTGRES_URL|POSTGRES_MIGRATION_URL|OWNER_PASSWORD|ADMIN_PASSWORD|credentials\.env|printenv/
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
    'Provision public PostgreSQL host'
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
    'Provision public PostgreSQL host'
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

test('remote deployment cleans exact staging and only rolls shared assets back with app evidence', () => {
  const remoteStep = stepBody(
    'Remote atomic release and gateway verification',
    'Verify released PostgreSQL public contract'
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
    'Verify released PostgreSQL public contract'
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
  assert.match(
    remoteStep,
    /RAG_ENV_RELOAD_LOCK_HELD=1 \\\n+\s*RAG_POSTGRES_PUBLIC_HOST="\$\{RAG_POSTGRES_PUBLIC_HOST\}" \\\n+\s*RAG_POSTGRES_CUTOVER_TOKEN="\$\{RAG_POSTGRES_CUTOVER_TOKEN\}" \\\n+\s*RAG_POSTGRES_CUTOVER_ACTION=activate \\\n+\s*RAG_POSTGRES_PROVISIONER=/
  );
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
    'PGPASSWORD',
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
    'Verify released PostgreSQL public contract'
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
    'Provision public PostgreSQL host'
  );
  const remoteStep = stepBody(
    'Remote atomic release and gateway verification',
    'Verify released PostgreSQL public contract'
  );

  assert.ok(uploadStep);
  assert.ok(remoteStep);
  assert.match(uploadStep, /deploy\/songuu\/post-release-gate\.sh/);
  assert.match(remoteStep, /post-release-gate\.sh/);
  assert.match(remoteStep, /chmod 700 [^\n]*post-release-gate\.sh/);
  assert.match(remoteStep, /bash -n "\$\{REMOTE_DIR\}\/post-release-gate\.sh"/);
  assert.match(
    remoteStep,
    /RAG_POST_RELEASE_GATE="\$\{REMOTE_DIR\}\/post-release-gate\.sh" \\\n+\s*RAG_SHARED_ASSET_BACKUP_DIR="\$\{shared_backup_dir\}" \\\n+\s*RAG_SHARED_ASSET_BACKUP_MANIFEST="\$\{shared_backup_manifest\}" \\\n+\s*RAG_RELEASE_GATE_ROOT="\$\{REMOTE_DIR\}" \\\n+\s*RAG_RELEASE_RECEIPT_ROOT="\$\{REMOTE_DIR\}" \\\n+\s*RAG_RELEASE_RECEIPT="\$\{release_receipt\}" \\\n+\s*RAG_ENV_RELOAD_LOCK_HELD=1/
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
