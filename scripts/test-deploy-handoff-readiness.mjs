#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const buildWorkflowPath = resolve(repoRoot, '.github/workflows/build-push-image.yml');
const deployWorkflowPath = resolve(repoRoot, '.github/workflows/deploy-via-ssh.yml');
const rollbackWorkflowPath = resolve(repoRoot, '.github/workflows/rollback-via-ssh.yml');
const envHardeningStart = '# ENV_FILE_HARDENING_START';
const envHardeningEnd = '# ENV_FILE_HARDENING_END';
const protectedFlowStart = '# PROTECTED_RELEASE_FLOW_START';
const protectedFlowEnd = '# PROTECTED_RELEASE_FLOW_END';
const posixShellFixturesAvailable = process.platform !== 'win32' ||
  process.env.GAMEHUNTER_FORCE_POSIX_FIXTURES === '1';

class UpstreamPool {
  constructor(...servers) {
    this.servers = servers;
  }

  add(server) {
    this.servers.push(server);
  }

  remove(name) {
    this.servers = this.servers.filter((server) => server.name !== name);
  }

  request() {
    const errors = [];
    for (const server of this.servers) {
      if (server.alive) {
        return { ok: true, servedBy: server.name };
      }
      errors.push(`${server.name}:refused`);
    }
    return { ok: false, errors };
  }
}

function simulateLegacyFixedPortRecreate() {
  const canonical = { name: 'canonical-old', alive: true };
  const pool = new UpstreamPool(canonical);

  canonical.alive = false;
  const duringGap = pool.request();

  canonical.name = 'canonical-new';
  canonical.alive = true;
  const afterStart = pool.request();

  return { duringGap, afterStart };
}

function simulateCandidateProtectedRecreate() {
  const canonical = { name: 'canonical-old', alive: true };
  const candidate = { name: 'candidate-new', alive: true };
  const pool = new UpstreamPool(canonical);

  pool.add(candidate);
  canonical.alive = false;
  const duringCanonicalGap = pool.request();

  canonical.name = 'canonical-new';
  canonical.alive = true;
  const afterCanonicalStart = pool.request();

  pool.remove(candidate.name);
  const finalCanonicalOnly = pool.request();

  return { duringCanonicalGap, afterCanonicalStart, finalCanonicalOnly };
}

function simulateRollbackWhileCandidateProtectsTraffic() {
  const canonical = { name: 'canonical-old', alive: true };
  const candidate = { name: 'candidate-new', alive: true };
  const pool = new UpstreamPool(canonical, candidate);

  canonical.alive = false;
  const duringFailedDeploy = pool.request();

  canonical.name = 'canonical-rollback';
  canonical.alive = true;
  pool.remove(candidate.name);
  const afterRollback = pool.request();

  return { duringFailedDeploy, afterRollback };
}

function assertWorkflowKeepsGuardBeforeRecreate() {
  const workflow = readFileSync(deployWorkflowPath, 'utf8');
  const prepareIndex = workflow.lastIndexOf('            prepare_public_handoff');
  const recreateIndex = workflow.indexOf(
    'docker compose up -d --no-build --force-recreate \\$ALL_SERVICES',
    prepareIndex,
  );

  assert.ok(prepareIndex > -1, 'workflow must define/call prepare_public_handoff');
  assert.ok(recreateIndex > -1, 'workflow must still recreate compose services');
  assert.ok(
    prepareIndex < recreateIndex,
    'prepare_public_handoff must run before canonical docker compose recreate',
  );
  assert.match(workflow, /gh-deploy-candidate:\$SERVICE:\$DEPLOY_RUN_ID/);
  assert.match(workflow, /remove_handoff_candidate_upstream/);
  assert.match(workflow, /HANDOFF_NGINX_BACKUP_DIR="\/tmp\/gamehunter-deploy-nginx-backups"/);
  assert.doesNotMatch(
    workflow,
    /backup="\\\$HANDOFF_NGINX_SITE\.f1-443/,
    'nginx backups must not be written under sites-enabled because nginx includes backup files',
  );
  assert.match(workflow, /rollback_service/);
}

function countOccurrences(value, search) {
  return value.split(search).length - 1;
}

function extractEnvHardeningBlock(workflow, label) {
  const start = workflow.indexOf(envHardeningStart);
  const end = workflow.indexOf(envHardeningEnd, start);

  assert.ok(start > -1, `${label} must contain the env hardening start marker`);
  assert.ok(end > start, `${label} must contain the env hardening end marker`);

  return workflow
    .slice(start, end + envHardeningEnd.length)
    .replace(/\r\n/g, '\n')
    .replace(/\\\$/g, () => '$');
}

function extractProtectedFlowBlock(workflow) {
  const start = workflow.indexOf(protectedFlowStart);
  const end = workflow.indexOf(protectedFlowEnd, start);
  assert.ok(start > -1, 'deploy workflow must contain the protected flow start marker');
  assert.ok(end > start, 'deploy workflow must contain the protected flow end marker');
  const block = workflow
    .slice(start, end + protectedFlowEnd.length)
    .replace(/\r\n/g, '\n')
    .replace(/\\\$/g, () => '$');
  assert.doesNotMatch(block, /:rollback|IMAGE_TAG=rollback/);
  return block;
}

function assertWorkflowHardensEnvFile(workflowPath, label, expectedUpdateCalls) {
  const workflow = readFileSync(workflowPath, 'utf8');

  assert.equal(
    countOccurrences(workflow, envHardeningStart),
    1,
    `${label} must define one env hardening block`,
  );
  assert.equal(countOccurrences(workflow, envHardeningEnd), 1);
  assert.match(workflow, /umask 077/);
  assert.match(workflow, /if \[ ! -f \.env \] \|\| \[ -L \.env \]; then/);
  assert.ok(workflow.includes('ENV_TMP=\\$(umask 077; mktemp ".env.tmp.XXXXXX")'));
  assert.ok(workflow.includes('chmod 600 "\\$ENV_TMP"'));
  assert.ok(workflow.includes('mv -fT -- "\\$ENV_TMP" .env'));
  assert.doesNotMatch(
    workflow,
    /chmod 600 -- \.env/,
    `${label} must not follow the .env pathname after the atomic rename`,
  );
  assert.ok(workflow.includes("mode=\\$(stat -c '%a' .env)"));
  assert.ok(workflow.includes('cleanup_env_tmp; exit \\$status'));
  assert.ok(workflow.includes('cleanup_legacy_env_new()'));
  assert.ok(workflow.includes('legacy_path="\\$app_dir/.env.new"'));
  assert.ok(workflow.includes('legacy_resolved=\\$(readlink -f -- "\\$legacy_path")'));
  assert.ok(workflow.includes('[ -L "\\$legacy_path" ] || [ ! -f "\\$legacy_path" ]'));
  assert.ok(workflow.includes('if [ "\\$legacy_resolved" != "\\$app_dir/.env.new" ]; then'));
  assert.ok(workflow.includes('rm -f -- "\\$legacy_path"'));
  assert.doesNotMatch(workflow, />\s*\.env\.new|>>\s*\.env\.new|mv\s+\.env\.new\s+\.env/);
  const updateCalls = workflow
    .split(/\r?\n/)
    .filter((line) => /^\s+update_image_tag_env(?:\s|$)/.test(line));
  assert.equal(
    updateCalls.length,
    expectedUpdateCalls,
    `${label} must harden every IMAGE_TAG rewrite`,
  );

  const lastExitTrap = workflow
    .slice(workflow.lastIndexOf("trap 'status=\\$?"))
    .split(/\r?\n/, 1)[0];
  assert.match(
    lastExitTrap,
    /cleanup_env_tmp/,
    `${label} final EXIT trap must clean an unfinished env temp file`,
  );

  const hardeningBlock = extractEnvHardeningBlock(workflow, label);
  assert.ok(
    hardeningBlock.indexOf('if ! cleanup_legacy_env_new; then') <
      hardeningBlock.indexOf('mktemp ".env.tmp.XXXXXX"'),
    `${label} must handle a legacy .env.new before creating the handoff candidate`,
  );

  return { workflow, hardeningBlock };
}

function assertRollbackTagIsValidatedBeforeSsh() {
  const workflow = readFileSync(rollbackWorkflowPath, 'utf8');
  const validationIndex = workflow.indexOf('- name: Validate rollback image tag');
  const sshIndex = workflow.indexOf('- name: Set up SSH');
  const allowedTag = /^(v[0-9]+\.[0-9]+\.[0-9]+|sha-[0-9a-f]{7})$/;

  assert.ok(validationIndex > -1, 'rollback workflow must validate the requested tag');
  assert.ok(sshIndex > validationIndex, 'rollback tag must be validated before SSH setup');
  assert.equal(
    countOccurrences(workflow, '${{ inputs.tag }}'),
    1,
    'raw rollback input must only enter the validator through the step environment',
  );
  assert.ok(
    workflow.includes('TAG: ${{ steps.rollback-tag.outputs.tag }}'),
    'remote rollback must receive only the validated tag output',
  );
  assert.match(workflow, /\^\(v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\|sha-\[0-9a-f\]\{7\}\)\$/);
  for (const tag of ['v1.2.3', 'v100.0.42', 'sha-0a1b2c3']) {
    assert.equal(allowedTag.test(tag), true, `expected safe rollback tag: ${tag}`);
  }
  for (const tag of [
    'latest',
    'v1.2.3-rc1',
    'sha-ABCDEF0',
    'v1.2.3\nexit 0',
    '$(touch injected)',
    '`touch injected`',
  ]) {
    assert.equal(allowedTag.test(tag), false, `expected rejected rollback tag: ${tag}`);
  }
}

function assertDeploySshKeyscanIsBoundedAndRetried() {
  const workflow = readFileSync(deployWorkflowPath, 'utf8');
  const sshStart = workflow.indexOf('- name: Set up SSH');
  const deployStart = workflow.indexOf('- name: Pull image and restart on VPS');
  const sshBlock = workflow.slice(sshStart, deployStart);

  assert.ok(sshStart > -1, 'deploy workflow must configure SSH');
  assert.ok(deployStart > sshStart, 'SSH setup must precede the VPS mutation step');
  assert.match(sshBlock, /for attempt in 1 2 3 4 5 6/);
  assert.match(sshBlock, /ssh-keyscan -T 10 -t ed25519 -H "\$VPS_HOST"/);
  assert.match(sshBlock, /if \[ -s "\$keyscan_file" \]/);
  assert.match(sshBlock, /if \[ "\$attempt" -eq 6 \]/);

  const remoteStep = workflow.slice(deployStart);
  assert.match(remoteStep, /-o ConnectTimeout=15/);
  assert.match(remoteStep, /-o ConnectionAttempts=3/);
  assert.match(remoteStep, /-o ServerAliveInterval=30/);
  assert.match(remoteStep, /-o ServerAliveCountMax=3/);
}

function assertDeployTagInputIsNotInterpolatedIntoShellSource() {
  const workflow = readFileSync(deployWorkflowPath, 'utf8');

  assert.equal(
    countOccurrences(workflow, '${{ inputs.tag }}'),
    1,
    'deploy tag input must only enter through the step environment',
  );
  assert.ok(workflow.includes('INPUT_TAG: ${{ inputs.tag }}'));
  assert.ok(workflow.includes('TAG="$INPUT_TAG"'));
}

function assertReleaseIdentityContract() {
  const deploy = readFileSync(deployWorkflowPath, 'utf8');
  const rollback = readFileSync(rollbackWorkflowPath, 'utf8');

  for (const [label, workflow] of [
    ['deploy', deploy],
    ['rollback', rollback],
  ]) {
    assert.match(
      workflow,
      /release-identity-enabled:\s+[\s\S]*?default: false\s+[\s\S]*?type: boolean/,
      `${label} workflow must expose an opt-in release identity contract`,
    );
    assert.ok(
      workflow.includes('RELEASE_IDENTITY_ENABLED: ${{ inputs.release-identity-enabled }}'),
      `${label} workflow must pass the opt-in through an environment value`,
    );
    assert.ok(workflow.includes('resolve_release_identity()'));
    assert.ok(workflow.includes('org.opencontainers.image.revision'));
    assert.ok(workflow.includes('.RepoDigests'));
    assert.ok(workflow.includes("^sha256:[0-9a-f]{64}$"));
    assert.ok(workflow.includes("^[0-9a-f]{40}$"));
    assert.doesNotMatch(workflow, /index \.RepoDigests 0/);
    assert.ok(workflow.includes('expected exactly one target repository digest'));
    assert.ok(workflow.includes('does not match expected Git SHA'));
    assert.ok(workflow.includes('does not match expected digest'));
    assert.ok(workflow.includes('GH_RELEASE_TAG="\\$release_tag"'));
    assert.ok(workflow.includes('GH_GIT_SHA="\\$git_sha"'));
    assert.ok(workflow.includes('GH_IMAGE_DIGEST="\\$image_digest"'));
    assert.ok(
      workflow.includes(
        'update_image_tag_env "\\$IMAGE_TAG" "\\$GH_RELEASE_TAG" "\\$GH_GIT_SHA" "\\$GH_IMAGE_DIGEST"',
      ),
      `${label} workflow must persist the verified tuple atomically`,
    );

    const pullIndex = workflow.lastIndexOf('docker compose pull');
    const resolveIndex = workflow.lastIndexOf('resolve_release_identity ');
    const persistIndex = workflow.lastIndexOf(
      'update_image_tag_env "\\$IMAGE_TAG" "\\$GH_RELEASE_TAG" "\\$GH_GIT_SHA" "\\$GH_IMAGE_DIGEST"',
    );
    assert.ok(pullIndex > -1 && resolveIndex > pullIndex && persistIndex > resolveIndex);
  }
}

function assertBuildOnlyIdentityContract() {
  const workflow = readFileSync(buildWorkflowPath, 'utf8');

  for (const output of ['image', 'image_tag', 'git_sha', 'image_digest']) {
    assert.match(
      workflow,
      new RegExp(
        `${output}:\\s+[\\s\\S]*?value: \\$\\{\\{ jobs\\.build_push\\.outputs\\.${output} \\}\\}`,
      ),
      `build reusable must publish the ${output} workflow output`,
    );
  }
  assert.ok(workflow.includes('id: build-image'));
  assert.ok(workflow.includes('id: published-identity'));
  assert.ok(workflow.includes('crane digest'));
  assert.ok(workflow.includes('crane config'));
  assert.ok(workflow.includes('org.opencontainers.image.revision'));
  assert.ok(workflow.includes('actions/upload-artifact@v4'));
  assert.ok(workflow.includes('release-identity-${{ github.run_id }}'));
}

function assertProtectedModeContract() {
  const deploy = readFileSync(deployWorkflowPath, 'utf8');
  const rollback = readFileSync(rollbackWorkflowPath, 'utf8');

  assert.match(
    deploy,
    /cutover-mode:\s+[\s\S]*?default: standard\s+[\s\S]*?type: string/,
  );
  for (const mode of ['standard', 'protected-off', 'protected-on-bounded']) {
    assert.ok(deploy.includes(mode), `deploy must support ${mode}`);
  }
  assert.ok(deploy.includes('expected-git-sha'));
  assert.ok(deploy.includes('expected-image-digest'));
  assert.ok(deploy.includes('protected-predecessor-run-id'));
  assert.ok(deploy.includes('PROTECTED_RELEASE_FLOW_START'));
  assert.ok(deploy.includes('PROTECTED_RELEASE_FLOW_END'));
  assert.ok(deploy.includes('assert_running_release_identity'));
  assert.ok(deploy.includes('force_same_image_capture_off'));
  assert.ok(deploy.includes('recover_active_drain_id'));
  assert.ok(deploy.includes('bounded protected canary'));
  assert.ok(deploy.includes('external-request-telemetry:canary'));
  assert.ok(deploy.includes('--approved-spec=F1-513'));
  assert.ok(deploy.includes('--confirm-high=run-protected-telemetry-canary'));
  assert.ok(deploy.includes('EXTERNAL_REQUEST_TELEMETRY_RUNTIME_MANIFEST_PATH'));
  assert.ok(deploy.includes('build_runtime_manifest_from_running_containers'));
  const canaryFunction = deploy.slice(
    deploy.indexOf('run_protected_telemetry_canary()'),
    deploy.indexOf('bounded_protected_canary()'),
  );
  const registryWait = canaryFunction.indexOf('sleep 35');
  const runtimeManifest = canaryFunction.indexOf(
    'build_runtime_manifest_from_running_containers',
  );
  assert.ok(
    registryWait > -1 && runtimeManifest > registryWait,
    'protected canary must let superseded BullMQ registrations expire before exact parity',
  );
  assert.ok(deploy.includes('docker cp'));
  assert.ok(deploy.includes('copied runtime manifest is missing or was altered'));
  assert.ok(deploy.includes("date -u +'%Y-%m-%dT%H:%M:%S.%3NZ'"));
  assert.ok(deploy.includes('protected capture-on requires a proven capture-off predecessor'));
  assert.ok(deploy.includes('active drain is stale or belongs to another release'));
  assert.ok(deploy.includes('assert_protected_runtime_controls'));
  assert.ok(deploy.includes('protected release requires backend + workers with mandatory drain'));
  assert.ok(deploy.includes('effective protected policy mismatch'));
  for (const countKey of [
    'admin_responses',
    'bullmq_matrix_checks',
    'log_primary',
    'log_error',
    'log_stdout',
  ]) {
    assert.ok(
      deploy.includes(countKey),
      `protected telemetry canary gate must validate ${countKey}`,
    );
  }
  assert.ok(deploy.includes('log_signals is not exactly three'));
  assert.ok(deploy.includes('bullmq_matrix_checks is not exactly five'));
  assert.match(deploy, /recover_active_drain_id "\$PROTECTED_PREDECESSOR_RUN_ID"/);
  assert.match(deploy, /curl -fsS --connect-timeout 2 --max-time "\\\$max_time"/);

  const protectedOnStart = deploy.indexOf('protected-on-bounded)');
  const protectedOnPersisted = deploy.indexOf('assert_persisted_release_identity', protectedOnStart);
  const protectedOnRunning = deploy.indexOf('assert_running_release_identity', protectedOnPersisted);
  const protectedOnUpdate = deploy.indexOf('update_image_tag_env', protectedOnRunning);
  assert.ok(
    protectedOnStart > -1 &&
      protectedOnPersisted > protectedOnStart &&
      protectedOnRunning > protectedOnPersisted &&
      protectedOnUpdate > protectedOnRunning,
    'protected-on must prove the persisted and running tuple before enabling capture',
  );

  const protectedBlock = extractProtectedFlowBlock(deploy);
  const protectedOffStart = protectedBlock.indexOf('protected-off)');
  const protectedOffMutation = protectedBlock.indexOf(
    'PROTECTED_MUTATED=true',
    protectedOffStart,
  );
  const protectedOffStop = protectedBlock.indexOf('docker compose stop', protectedOffStart);
  assert.ok(
    protectedOffMutation > protectedOffStart && protectedOffMutation < protectedOffStop,
    'protected-off must enter containment before the first stop can partially mutate runtime',
  );
  const forceStart = protectedBlock.indexOf('force_same_image_capture_off()');
  const forceEnd = protectedBlock.indexOf('ensure_protected_queue_paused()', forceStart);
  const forceBlock = protectedBlock.slice(forceStart, forceEnd);
  assert.ok(forceBlock.indexOf('docker compose stop') < forceBlock.indexOf('docker compose up'));

  assert.match(
    rollback,
    /rollback-mode:\s+[\s\S]*?default: standard\s+[\s\S]*?type: string/,
  );
  assert.ok(rollback.includes('protected-same-image-off'));
  assert.ok(rollback.includes('expected-git-sha'));
  assert.ok(rollback.includes('expected-image-digest'));
  assert.ok(rollback.includes('assert_running_release_identity'));
  assert.ok(rollback.includes('protected rollback rejects a mixed capture policy'));
  assert.ok(rollback.includes('effective protected policy mismatch'));
  assert.ok(rollback.includes('protected rollback requires backend + workers'));
  assert.ok(rollback.includes('recovered_image_tag'));
  const protectedRollbackStart = rollback.lastIndexOf(
    'if [ "$ROLLBACK_MODE" = "protected-same-image-off" ]; then',
  );
  const protectedRollbackPersisted = rollback.indexOf(
    'assert_persisted_release_identity',
    protectedRollbackStart,
  );
  const protectedRollbackRunning = rollback.indexOf(
    'assert_running_release_identity',
    protectedRollbackPersisted,
  );
  const protectedRollbackPause = rollback.indexOf(
    'ensure_worker_queue_paused',
    protectedRollbackRunning,
  );
  assert.ok(
    protectedRollbackStart > -1 &&
      protectedRollbackPersisted > protectedRollbackStart &&
      protectedRollbackRunning > protectedRollbackPersisted &&
      protectedRollbackPause > protectedRollbackRunning,
    'protected rollback must reject a different running image before pausing or mutating',
  );
  const rollbackForceStart = rollback.indexOf('force_same_image_capture_off()');
  const rollbackForceEnd = rollback.indexOf("trap 'status=\\$?", rollbackForceStart);
  const rollbackForceBlock = rollback.slice(rollbackForceStart, rollbackForceEnd);
  assert.ok(
    rollbackForceBlock.indexOf('docker compose stop') <
      rollbackForceBlock.indexOf('docker compose up'),
  );
}

function runEnvHardeningFixture(label, hardeningBlock) {
  if (process.platform === 'win32') {
    return false;
  }

  const fixtureDir = mkdtempSync(resolve(tmpdir(), 'gh-env-hardening-'));
  const fixturePath = resolve(fixtureDir, 'fixture.sh');
  const exitTrapFixturePath = resolve(fixtureDir, 'exit-trap-fixture.sh');
  const concurrentTargetFixturePath = resolve(fixtureDir, 'concurrent-target-fixture.sh');
  const postRenameSymlinkFixturePath = resolve(fixtureDir, 'post-rename-symlink-fixture.sh');
  const script = `#!/usr/bin/env bash
set -euo pipefail
cd "${fixtureDir}"
${hardeningBlock}
trap 'status=$?; cleanup_env_tmp; exit $status' EXIT
printf '%s\\n' 'PORT=3001' 'DUMMY_VALUE=not-a-secret' 'IMAGE_TAG=old-1' 'IMAGE_TAG=old-2' > .env
printf '%s\\n' 'legacy-candidate=must-be-removed' > .env.new
chmod 644 .env
update_image_tag_env 'release-fixture'
test "$(stat -c '%a' .env)" = '600'
test "$(grep -c '^IMAGE_TAG=' .env)" = '1'
grep -qx 'IMAGE_TAG=release-fixture' .env
grep -qx 'DUMMY_VALUE=not-a-secret' .env
test ! -e .env.new
test ! -L .env.new
test -z "$(find . -maxdepth 1 -name '.env.tmp.*' -print -quit)"

mv .env .env.target
ln -s .env.target .env
if update_image_tag_env 'must-not-replace-symlink' >/dev/null 2>&1; then
  exit 1
fi
test -L .env
grep -qx 'IMAGE_TAG=release-fixture' .env.target
rm .env
mv .env.target .env

printf '%s\\n' 'outside=untouched' > legacy-outside
ln -s legacy-outside .env.new
if update_image_tag_env 'must-not-accept-legacy-symlink' >/dev/null 2>&1; then
  exit 1
fi
test -L .env.new
grep -qx 'outside=untouched' legacy-outside
grep -qx 'IMAGE_TAG=release-fixture' .env
rm -- .env.new

mkdir .env.new
if update_image_tag_env 'must-not-accept-legacy-directory' >/dev/null 2>&1; then
  exit 1
fi
test -d .env.new
grep -qx 'IMAGE_TAG=release-fixture' .env
rmdir .env.new

grep() { return 2; }
if update_image_tag_env 'must-clean-failed-temp'; then
  exit 1
fi
unset -f grep
test -z "$(find . -maxdepth 1 -name '.env.tmp.*' -print -quit)"
grep -qx 'IMAGE_TAG=release-fixture' .env

update_image_tag_env \
  'v9.9.9' \
  'v9.9.9' \
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' \
  'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
test "$(grep -c '^IMAGE_TAG=' .env)" = '1'
test "$(grep -c '^GH_RELEASE_TAG=' .env)" = '1'
test "$(grep -c '^GH_GIT_SHA=' .env)" = '1'
test "$(grep -c '^GH_IMAGE_DIGEST=' .env)" = '1'
grep -qx 'IMAGE_TAG=v9.9.9' .env
grep -qx 'GH_RELEASE_TAG=v9.9.9' .env
grep -qx 'GH_GIT_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' .env
grep -qx 'GH_IMAGE_DIGEST=sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' .env

update_image_tag_env \
  'v9.9.9' \
  'v9.9.9' \
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' \
  'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' \
  'false' \
  'disabled' \
  'false'
grep -qx 'EXTERNAL_REQUEST_LOG_ENABLED=false' .env
grep -qx 'FETCH_PROXY_MODE=disabled' .env
grep -qx 'SENTRY_EGRESS_ENABLED=false' .env

update_image_tag_env 'release-without-stale-identity'
test "$(grep -c '^GH_RELEASE_TAG=' .env || true)" = '0'
test "$(grep -c '^GH_GIT_SHA=' .env || true)" = '0'
test "$(grep -c '^GH_IMAGE_DIGEST=' .env || true)" = '0'
grep -qx 'IMAGE_TAG=release-without-stale-identity' .env

docker() {
  case "$*" in
    *org.opencontainers.image.revision*)
      printf '%s\n' 'cccccccccccccccccccccccccccccccccccccccc'
      ;;
    *.RepoDigests*)
      printf '%s\n' 'ghcr.io/gamehunter-com-br/backend@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
      ;;
    *)
      return 1
      ;;
  esac
}

resolve_release_identity \
  'ghcr.io/gamehunter-com-br/backend:v9.9.9' \
  'v9.9.9' \
  'cccccccccccccccccccccccccccccccccccccccc' \
  'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
test "$GH_RELEASE_TAG" = 'v9.9.9'
test "$GH_GIT_SHA" = 'cccccccccccccccccccccccccccccccccccccccc'
test "$GH_IMAGE_DIGEST" = 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
if resolve_release_identity \
  'ghcr.io/gamehunter-com-br/backend:v9.9.9' \
  'v9.9.9' \
  'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' \
  'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd' >/dev/null 2>&1; then
  exit 1
fi
unset -f docker
`;
  const exitTrapScript = `#!/usr/bin/env bash
set -euo pipefail
cd "${fixtureDir}"
${hardeningBlock}
trap 'status=$?; cleanup_env_tmp; exit $status' EXIT
ENV_TMP=$(umask 077; mktemp ".env.tmp.XXXXXX")
printf '%s\\n' 'trap-only-cleanup' > "$ENV_TMP"
exit 23
`;
  const concurrentTargetScript = `#!/usr/bin/env bash
set -euo pipefail
cd "${fixtureDir}"
rm -rf -- .env
printf '%s\\n' 'PORT=3001' 'IMAGE_TAG=before-race' > .env
${hardeningBlock}
trap 'status=$?; cleanup_env_tmp; exit $status' EXIT
mv() {
  rm -f -- .env
  mkdir -- .env
  command mv "$@"
}
update_image_tag_env 'must-fail-on-directory-substitution'
`;
  const postRenameSymlinkScript = `#!/usr/bin/env bash
set -euo pipefail
cd "${fixtureDir}"
printf '%s\\n' 'PORT=3001' 'IMAGE_TAG=before-post-rename-race' > .env
printf '%s\\n' 'outside=must-remain-unchanged' > post-rename-outside
${hardeningBlock}
trap 'status=$?; cleanup_env_tmp; exit $status' EXIT
mv() {
  command mv "$@"
  command mv -- .env .env.after-rename
  ln -s post-rename-outside .env
}
if update_image_tag_env 'must-fail-on-post-rename-symlink'; then
  exit 1
fi
test -L .env
grep -qx 'outside=must-remain-unchanged' post-rename-outside
test "$(stat -c '%a' .env.after-rename)" = '600'
grep -qx 'IMAGE_TAG=must-fail-on-post-rename-symlink' .env.after-rename
`;

  const assertNoEnvTemps = () => {
    assert.equal(
      readdirSync(fixtureDir).some((entry) => entry.startsWith('.env.tmp.')),
      false,
      `${label} must not leave an env candidate behind`,
    );
  };

  try {
    writeFileSync(fixturePath, script, { mode: 0o700 });
    const result = spawnSync('bash', [fixturePath], {
      cwd: fixtureDir,
      encoding: 'utf8',
    });
    assert.equal(
      result.status,
      0,
      `${label} env hardening fixture failed:\n${result.stdout}${result.stderr}`,
    );
    assertNoEnvTemps();

    writeFileSync(exitTrapFixturePath, exitTrapScript, { mode: 0o700 });
    const exitTrapResult = spawnSync('bash', [exitTrapFixturePath], {
      cwd: fixtureDir,
      encoding: 'utf8',
    });
    assert.equal(
      exitTrapResult.status,
      23,
      `${label} EXIT-trap fixture failed:\n${exitTrapResult.stdout}${exitTrapResult.stderr}`,
    );
    assertNoEnvTemps();

    writeFileSync(concurrentTargetFixturePath, concurrentTargetScript, { mode: 0o700 });
    const concurrentTargetResult = spawnSync('bash', [concurrentTargetFixturePath], {
      cwd: fixtureDir,
      encoding: 'utf8',
    });
    assert.equal(concurrentTargetResult.error, undefined);
    assert.notEqual(concurrentTargetResult.status, null);
    assert.notEqual(
      concurrentTargetResult.status,
      0,
      `${label} must reject a concurrent .env directory substitution`,
    );
    assert.equal(lstatSync(resolve(fixtureDir, '.env')).isDirectory(), true);
    assertNoEnvTemps();

    rmSync(resolve(fixtureDir, '.env'), { force: true, recursive: true });
    writeFileSync(postRenameSymlinkFixturePath, postRenameSymlinkScript, { mode: 0o700 });
    const postRenameSymlinkResult = spawnSync('bash', [postRenameSymlinkFixturePath], {
      cwd: fixtureDir,
      encoding: 'utf8',
    });
    assert.equal(postRenameSymlinkResult.error, undefined);
    assert.notEqual(postRenameSymlinkResult.status, null);
    assert.equal(
      postRenameSymlinkResult.status,
      0,
      `${label} post-rename symlink fixture failed:\n${postRenameSymlinkResult.stdout}${postRenameSymlinkResult.stderr}`,
    );
    assert.equal(lstatSync(resolve(fixtureDir, '.env')).isSymbolicLink(), true);
    assertNoEnvTemps();
  } finally {
    rmSync(fixtureDir, { force: true, recursive: true });
  }

  return true;
}

function runRuntimePolicyFixture(workflow) {
  if (!posixShellFixturesAvailable) return false;

  const start = workflow.indexOf('            assert_running_release_identity() {');
  const end = workflow.indexOf('\n\n            PROTECTED_MUTATED=false', start);
  assert.ok(start > -1 && end > start, 'deploy runtime identity function must be extractable');
  const identityFunction = workflow
    .slice(start, end)
    .replace(/^ {12}/gm, '')
    .replace(/\\\$/g, () => '$');
  const fixtureDir = mkdtempSync(resolve(tmpdir(), 'gh-runtime-policy-'));
  const fixturePath = resolve(fixtureDir, 'fixture.sh');
  const script = `#!/usr/bin/env bash
set -euo pipefail
ALL_SERVICES='backend workers'
BAD_SERVICE=''
DUPLICATE_KEY=false
EXPECTED_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
EXPECTED_DIGEST=sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
IMAGE_ID=sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc

docker() {
  if [[ "$*" == 'image inspect --format {{.Id}} '* ]]; then
    printf '%s\\n' "$IMAGE_ID"
  elif [[ "$*" == 'compose ps -q backend' ]]; then
    printf '%s\\n' aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  elif [[ "$*" == 'compose ps -q workers' ]]; then
    printf '%s\\n' bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
  elif [[ "$*" == *'inspect --format {{.State.Running}}'* ]]; then
    printf '%s\\n' true
  elif [[ "$*" == *'inspect --format {{.Image}}'* ]]; then
    printf '%s\\n' "$IMAGE_ID"
  elif [[ "$*" == *'image inspect --format {{ index .Config.Labels'* ]]; then
    printf '%s\\n' "$EXPECTED_SHA"
  elif [[ "$*" == *'image inspect --format {{range .RepoDigests}}'* ]]; then
    printf '%s\\n' "ghcr.io/gamehunter-com-br/backend@$EXPECTED_DIGEST"
  elif [[ "$*" == *'inspect --format {{range .Config.Env}}'* ]]; then
    container_id="\${*: -1}"
    external=false
    if [ "$BAD_SERVICE" = workers ] && [[ "$container_id" == b* ]]; then external=true; fi
    printf '%s\\n' \
      "EXTERNAL_REQUEST_LOG_ENABLED=$external" \
      'FETCH_PROXY_MODE=disabled' \
      'SENTRY_EGRESS_ENABLED=false'
    if [ "$DUPLICATE_KEY" = true ]; then
      printf '%s\\n' 'FETCH_PROXY_MODE=tag'
    fi
  else
    return 1
  fi
}

${identityFunction}

assert_running_release_identity \
  ghcr.io/gamehunter-com-br/backend:v9.9.9 "$EXPECTED_SHA" "$EXPECTED_DIGEST" \
  false disabled false
BAD_SERVICE=workers
if assert_running_release_identity \
  ghcr.io/gamehunter-com-br/backend:v9.9.9 "$EXPECTED_SHA" "$EXPECTED_DIGEST" \
  false disabled false >/dev/null 2>&1; then
  echo 'expected effective worker policy mismatch'
  exit 1
fi
BAD_SERVICE=''
DUPLICATE_KEY=true
if assert_running_release_identity \
  ghcr.io/gamehunter-com-br/backend:v9.9.9 "$EXPECTED_SHA" "$EXPECTED_DIGEST" \
  false disabled false >/dev/null 2>&1; then
  echo 'expected duplicate effective policy key to fail closed'
  exit 1
fi
`;

  try {
    writeFileSync(fixturePath, script, { mode: 0o700 });
    const result = spawnSync('bash', [fixturePath], {
      cwd: fixtureDir,
      encoding: 'utf8',
    });
    assert.equal(
      result.status,
      0,
      `runtime policy POSIX fixture failed:\n${result.stdout}${result.stderr}`,
    );
  } finally {
    rmSync(fixtureDir, { force: true, recursive: true });
  }
  return true;
}

function runProtectedFlowFixture(workflow) {
  if (!posixShellFixturesAvailable) return false;

  const protectedBlock = extractProtectedFlowBlock(workflow);
  const fixtureDir = mkdtempSync(resolve(tmpdir(), 'gh-protected-flow-'));
  const fixturePath = resolve(fixtureDir, 'fixture.sh');
  const script = `#!/usr/bin/env bash
set -euo pipefail
cd "${fixtureDir}"
printf '%s\\n' \
  'PORT=3001' \
  'IMAGE_TAG=v9.9.9' \
  'GH_RELEASE_TAG=v9.9.9' \
  'GH_GIT_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' \
  'GH_IMAGE_DIGEST=sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' \
  'EXTERNAL_REQUEST_LOG_ENABLED=false' \
  'FETCH_PROXY_MODE=disabled' \
  'SENTRY_EGRESS_ENABLED=false' > .env
TAG=v9.9.9
EXPECTED_GIT_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
EXPECTED_IMAGE_DIGEST=sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
IMAGE=ghcr.io/gamehunter-com-br/backend
SERVICE=backend
DEPLOY_RUN_ID=10001
ALL_SERVICES='backend workers'
DEPLOY_WORKERS=true
WORKER_DRAIN_ENABLED=true
MIGRATION_CMD='npm run migrate'
DEFAULT_PORT=3001
HEALTH_PATH=/health
PROTECTED_BOUNDED_SECONDS=0
PROTECTED_CANARY_OPERATOR=github-actions-fixture
PROTECTED_PREDECESSOR_RUN_ID=10001
WORKER_DRAIN_ID=''
WORKER_DRAIN_DEPLOY_REF=''
SHOULD_DRAIN_WORKERS=true
FAIL_PHASE=none
STATUS_TAG=v9.9.9
STATUS_DEPLOY_REF=10001
STOP_FAILURES_REMAINING=0
WORKER_FIXTURE_COUNT=1
LOG_FILE="$PWD/operations.log"
record() { printf '%s\\n' "$*" >> "$LOG_FILE"; }
docker() {
  record "DOCKER $*"
  if [ "$1" = pull ] && [ "$FAIL_PHASE" = pull ]; then return 1; fi
  if [[ "$*" == *'compose run'*'npm run migrate'* ]] && [ "$FAIL_PHASE" = migration ]; then return 1; fi
  if [[ "$*" == *'compose stop'* ]] && [ "$STOP_FAILURES_REMAINING" -gt 0 ]; then
    STOP_FAILURES_REMAINING=$((STOP_FAILURES_REMAINING - 1))
    return 1
  fi
  if [[ "$*" == *'compose up'* ]] && [ "$FAIL_PHASE" = handoff ]; then return 1; fi
  if [[ "$*" == *'deploy:workers:status'* ]]; then
    printf '%s\\n' '{"queue":{"name":"scheduled-jobs","paused":true,"pause_reason":"deploy_drain"},"active_drain":{"id":"drain-fixture-0001","deploy_ref":"'"$STATUS_DEPLOY_REF"'","image_tag":"'"$STATUS_TAG"'","status":"ready"},"active_jobs":[],"recent_drains":[],"orphan_pause":false}'
  fi
  if [[ "$*" == *'image inspect --format {{.Id}}'* ]]; then
    printf '%s\\n' 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
  fi
  if [[ "$*" == *'compose ps -q backend'* ]]; then
    printf '%s\\n' 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  fi
  if [[ "$*" == *'compose ps -q workers'* ]]; then
    if [ "$WORKER_FIXTURE_COUNT" -ge 1 ]; then
      printf '%s\\n' 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    fi
    if [ "$WORKER_FIXTURE_COUNT" -ge 2 ]; then
      printf '%s\\n' 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
    fi
  fi
  if [[ "$*" == *'inspect --format {{.State.Running}}'* ]]; then printf '%s\\n' true; fi
  if [[ "$*" == *'inspect --format {{.Image}}'* ]]; then
    printf '%s\\n' 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
  fi
  if [[ "$*" == *'exec '*' test ! -e '* ]]; then
    if [ "$FAIL_PHASE" = manifest-preexisting ]; then return 1; fi
    return 0
  fi
  if [ "$1" = cp ]; then
    if [ "$FAIL_PHASE" = manifest-missing ]; then return 1; fi
    return 0
  fi
  if [[ "$*" == *'exec '*' sha256sum '* ]]; then
    if [ "$FAIL_PHASE" = manifest-tampered ]; then
      printf '%064d\\n' 0 | tr 0 d
    else
      command sha256sum "$CANARY_MANIFEST_TMP" | cut -d ' ' -f1
    fi
    return 0
  fi
  if [[ "$*" == *'external-request-telemetry:canary'* ]]; then
    if [ "$FAIL_PHASE" = canary ]; then return 1; fi
    manifest_workers=$(grep -o '"role":"worker"' "$CANARY_MANIFEST_TMP" | wc -l | tr -d ' ')
    manifest_instances=$(grep -o '"instance_id"' "$CANARY_MANIFEST_TMP" | wc -l | tr -d ' ')
    generated_at=$(sed -n 's/.*"generated_at":"\\([^"]*\\)".*/\\1/p' "$CANARY_MANIFEST_TMP")
    if [[ ! "$generated_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$ ]]; then return 1; fi
    generated_epoch=$(date -u -d "$generated_at" +%s) || return 1
    freshness=$(( $(date -u +%s) - generated_epoch ))
    if [ "$freshness" -lt 0 ] || [ "$freshness" -gt 5 ]; then return 1; fi
    if [ "$FAIL_PHASE" = manifest-stale ]; then return 1; fi
    record "MANIFEST_WORKERS $manifest_workers"
    record "MANIFEST_INSTANCES $manifest_instances"
    record "MANIFEST_FRESH true"
    if [ "$manifest_workers" != "$WORKER_FIXTURE_COUNT" ]; then return 1; fi
    if [ "$FAIL_PHASE" = canary-counts ]; then
      printf '%s\\n' '{"schema_version":"1","status":"passed","run_id":"run-fixture-001","counts":{"fetch_stub_calls":1,"vendor_calls":0,"subscriber_events":1,"redis_jobs":1,"postgres_rows":1,"admin_responses":0,"bullmq_matrix_checks":5,"log_signals":3,"log_primary":1,"log_error":1,"log_stdout":1,"sentry_error":1,"sentry_transaction":1,"sentry_span":1,"sentry_breadcrumb":1,"sentry_log":1,"raw_violations":0}}'
    else
      printf '%s\\n' '{"schema_version":"1","status":"passed","run_id":"run-fixture-001","counts":{"fetch_stub_calls":1,"vendor_calls":0,"subscriber_events":1,"redis_jobs":1,"postgres_rows":1,"admin_responses":1,"bullmq_matrix_checks":5,"log_signals":3,"log_primary":1,"log_error":1,"log_stdout":1,"sentry_error":1,"sentry_transaction":1,"sentry_span":1,"sentry_breadcrumb":1,"sentry_log":1,"raw_violations":0}}'
    fi
  fi
}
resolve_release_identity() { record "RESOLVE $*"; }
update_image_tag_env() { record "UPDATE $*"; }
assert_running_release_identity() {
  record "ASSERT_RUNNING $*"
  [ "$FAIL_PHASE" != effective-env ]
}
assert_persisted_release_identity() { record 'ASSERT_PERSISTED'; }
start_worker_drain() {
  record 'PAUSE_QUEUE'
  if [ "$FAIL_PHASE" = drain ]; then return 1; fi
  WORKER_DRAIN_ID=drain-fixture-0001
}
recover_active_drain_id() {
  record 'RECOVER_DRAIN'
  if [ "$FAIL_PHASE" = drain ]; then return 1; fi
  WORKER_DRAIN_ID=drain-fixture-0001
}
resume_worker_queue() { record 'RESUME_QUEUE'; WORKER_DRAIN_ID=''; }
wait_local_health() { record "LOCAL_HEALTH $*"; [ "$FAIL_PHASE" != health ]; }
wait_public_readiness() { record "PUBLIC_HEALTH $*"; [ "$FAIL_PHASE" != health ]; }
public_readiness_ok() { [ "$FAIL_PHASE" != health ]; }
sleep() { :; }

${protectedBlock}

# The fixture exercises the protected gates and substitutes only container
# identity inspection, which has its own executable env/identity fixture.
assert_running_release_identity() {
  record "ASSERT_RUNNING $*"
  [ "$FAIL_PHASE" != effective-env ]
}

run_case() {
  local phase="$1" mode="$2" run_status=0 containment_status=0
  : > "$LOG_FILE"
  FAIL_PHASE="$phase"
  CUTOVER_MODE="$mode"
  WORKER_DRAIN_ID=''
  WORKER_DRAIN_DEPLOY_REF=''
  PROTECTED_MUTATED=false
  PROTECTED_IDENTITY_VERIFIED=false
  PROTECTED_QUEUE_PAUSED=false
  STATUS_TAG=v9.9.9
  STATUS_DEPLOY_REF=10001
  STOP_FAILURES_REMAINING=0
  DEPLOY_WORKERS=true
  WORKER_DRAIN_ENABLED=true
  SHOULD_DRAIN_WORKERS=true
  WORKER_FIXTURE_COUNT=1
  if [ "$phase" = worker-missing ]; then WORKER_FIXTURE_COUNT=0; fi
  if [ "$phase" = stop ]; then STOP_FAILURES_REMAINING=1; fi
  if run_protected_release_flow; then
    run_status=0
  else
    run_status=$?
    contain_protected_failure || containment_status=$?
    record "CONTAINMENT_STATUS $containment_status"
  fi
  return "$run_status"
}

run_case none protected-off
grep -q '^PAUSE_QUEUE$' "$LOG_FILE"
grep -q '^UPDATE v9.9.9 v9.9.9 .* false disabled false$' "$LOG_FILE"
grep -q '^DOCKER compose stop backend workers$' "$LOG_FILE"
grep -q '^DOCKER compose run .*npm run migrate$' "$LOG_FILE"
if grep -q '^RESUME_QUEUE$' "$LOG_FILE"; then exit 1; fi
if grep -q ':rollback' "$LOG_FILE"; then exit 1; fi
stop_line=$(grep -n '^DOCKER compose stop backend workers$' "$LOG_FILE" | head -n 1 | cut -d: -f1)
up_line=$(grep -n '^DOCKER compose up .*backend workers$' "$LOG_FILE" | head -n 1 | cut -d: -f1)
test "$stop_line" -lt "$up_line"

run_case none protected-on-bounded
grep -q '^DOCKER compose run .*deploy:workers:status.*--json$' "$LOG_FILE"
grep -q '^UPDATE v9.9.9 v9.9.9 .* true tag true$' "$LOG_FILE"
grep -q '^DOCKER exec .*external-request-telemetry:canary.*--approved-spec=F1-513.*--confirm-high=run-protected-telemetry-canary.*--operator=github-actions-fixture.*--json$' "$LOG_FILE"
test "$(grep -c '^RESUME_QUEUE$' "$LOG_FILE")" = 1
grep -q '^ASSERT_RUNNING .* false disabled false$' "$LOG_FILE"
grep -q '^ASSERT_RUNNING .* true tag true$' "$LOG_FILE"

WORKER_FIXTURE_COUNT=2
: > "$LOG_FILE"
PROTECTED_MUTATED=false
PROTECTED_IDENTITY_VERIFIED=false
PROTECTED_QUEUE_PAUSED=false
run_protected_release_flow
grep -q '^MANIFEST_WORKERS 2$' "$LOG_FILE"
grep -q '^MANIFEST_INSTANCES 3$' "$LOG_FILE"
grep -q '^MANIFEST_FRESH true$' "$LOG_FILE"
test "$(grep -c '^RESUME_QUEUE$' "$LOG_FILE")" = 1

: > "$LOG_FILE"
PROTECTED_MUTATED=false
PROTECTED_IDENTITY_VERIFIED=false
PROTECTED_QUEUE_PAUSED=false
STATUS_TAG=v0.0.1
if run_protected_release_flow; then
  echo 'expected protected-on to reject a drain from another release'
  exit 1
fi
if grep -q '^UPDATE .* true tag true$' "$LOG_FILE"; then exit 1; fi
STATUS_TAG=v9.9.9

: > "$LOG_FILE"
STATUS_DEPLOY_REF=99999
PROTECTED_MUTATED=false
PROTECTED_IDENTITY_VERIFIED=false
PROTECTED_QUEUE_PAUSED=false
if run_protected_release_flow; then
  echo 'expected protected-on to reject a drain from another protected-off run'
  exit 1
fi
if grep -q '^UPDATE .* true tag true$' "$LOG_FILE"; then exit 1; fi
STATUS_DEPLOY_REF=10001

: > "$LOG_FILE"
CUTOVER_MODE=protected-off
DEPLOY_WORKERS=false
SHOULD_DRAIN_WORKERS=false
PROTECTED_MUTATED=false
PROTECTED_IDENTITY_VERIFIED=false
PROTECTED_QUEUE_PAUSED=false
if run_protected_release_flow; then
  echo 'expected protected-off to require workers and drain'
  exit 1
fi
if grep -q '^DOCKER pull ' "$LOG_FILE"; then exit 1; fi
DEPLOY_WORKERS=true
SHOULD_DRAIN_WORKERS=true

: > "$LOG_FILE"
WORKER_DRAIN_ENABLED=false
SHOULD_DRAIN_WORKERS=false
PROTECTED_MUTATED=false
PROTECTED_IDENTITY_VERIFIED=false
PROTECTED_QUEUE_PAUSED=false
if run_protected_release_flow; then
  echo 'expected protected-off to reject disabled worker drain'
  exit 1
fi
if grep -q '^DOCKER pull ' "$LOG_FILE"; then exit 1; fi
WORKER_DRAIN_ENABLED=true
SHOULD_DRAIN_WORKERS=true

CUTOVER_MODE=protected-on-bounded
sed -i 's/^FETCH_PROXY_MODE=disabled$/FETCH_PROXY_MODE=tag/' .env
: > "$LOG_FILE"
PROTECTED_MUTATED=false
PROTECTED_IDENTITY_VERIFIED=false
PROTECTED_QUEUE_PAUSED=false
if run_protected_release_flow; then
  echo 'expected protected-on to reject mixed capture flags'
  exit 1
fi
sed -i 's/^FETCH_PROXY_MODE=tag$/FETCH_PROXY_MODE=disabled/' .env

for phase in pull migration drain stop handoff health effective-env canary canary-counts manifest-missing manifest-tampered manifest-preexisting manifest-stale worker-missing; do
  failure_mode=protected-off
  case "$phase" in
    canary|canary-counts|manifest-*|worker-missing) failure_mode=protected-on-bounded ;;
  esac
  if run_case "$phase" "$failure_mode"; then
    echo "expected $failure_mode failure for $phase"
    exit 1
  fi
  if grep -q ':rollback' "$LOG_FILE"; then exit 1; fi
  case "$phase" in
    migration|stop|handoff|health|effective-env|canary|canary-counts|manifest-*|worker-missing)
      grep -q '^UPDATE v9.9.9 v9.9.9 .* false disabled false$' "$LOG_FILE"
      ;;
  esac
done
`;

  try {
    writeFileSync(fixturePath, script, { mode: 0o700 });
    const result = spawnSync('bash', [fixturePath], {
      cwd: fixtureDir,
      encoding: 'utf8',
    });
    assert.equal(
      result.status,
      0,
      `protected release POSIX fixture failed:\n${result.stdout}${result.stderr}\noperations:\n${
        readFileSync(resolve(fixtureDir, 'operations.log'), 'utf8')
      }`,
    );
  } finally {
    rmSync(fixtureDir, { force: true, recursive: true });
  }
  return true;
}

const legacy = simulateLegacyFixedPortRecreate();
assert.equal(legacy.duringGap.ok, false, 'legacy fixed-port recreate exposes a refused upstream gap');
assert.equal(legacy.afterStart.ok, true, 'legacy recovers only after the new canonical service starts');

const guarded = simulateCandidateProtectedRecreate();
assert.equal(guarded.duringCanonicalGap.ok, true, 'candidate keeps public upstream available during canonical gap');
assert.equal(guarded.duringCanonicalGap.servedBy, 'candidate-new');
assert.equal(guarded.afterCanonicalStart.ok, true);
assert.equal(guarded.finalCanonicalOnly.ok, true);
assert.equal(guarded.finalCanonicalOnly.servedBy, 'canonical-new');

const rollback = simulateRollbackWhileCandidateProtectsTraffic();
assert.equal(rollback.duringFailedDeploy.ok, true, 'candidate protects public traffic while rollback recreates canonical');
assert.equal(rollback.afterRollback.ok, true);
assert.equal(rollback.afterRollback.servedBy, 'canonical-rollback');

assertWorkflowKeepsGuardBeforeRecreate();
assertRollbackTagIsValidatedBeforeSsh();
assertDeploySshKeyscanIsBoundedAndRetried();
assertDeployTagInputIsNotInterpolatedIntoShellSource();
assertReleaseIdentityContract();
assertBuildOnlyIdentityContract();
assertProtectedModeContract();

const deployEnv = assertWorkflowHardensEnvFile(deployWorkflowPath, 'deploy workflow', 7);
const rollbackEnv = assertWorkflowHardensEnvFile(rollbackWorkflowPath, 'rollback workflow', 3);
const functionalFixtureRan = [
  runEnvHardeningFixture('deploy workflow', deployEnv.hardeningBlock),
  runEnvHardeningFixture('rollback workflow', rollbackEnv.hardeningBlock),
].some(Boolean);
const runtimePolicyFixtureRan = runRuntimePolicyFixture(deployEnv.workflow);
const protectedFixtureRan = runProtectedFlowFixture(deployEnv.workflow);

console.log('deploy handoff readiness fixture PASS');
console.log('deploy/rollback env hardening structural fixture PASS');
console.log(
  functionalFixtureRan
    ? 'deploy/rollback env hardening mode fixture PASS'
    : 'deploy/rollback env hardening mode fixture SKIP (requires POSIX chmod semantics)',
);
console.log(
  runtimePolicyFixtureRan
    ? 'protected runtime effective-policy fixture PASS'
    : 'protected runtime effective-policy fixture SKIP (requires POSIX shell)',
);
console.log(
  protectedFixtureRan
    ? 'protected release POSIX failure matrix PASS'
    : 'protected release POSIX failure matrix SKIP (requires POSIX shell)',
);
