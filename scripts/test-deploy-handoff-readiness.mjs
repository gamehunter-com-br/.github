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
const deployWorkflowPath = resolve(repoRoot, '.github/workflows/deploy-via-ssh.yml');
const rollbackWorkflowPath = resolve(repoRoot, '.github/workflows/rollback-via-ssh.yml');
const envHardeningStart = '# ENV_FILE_HARDENING_START';
const envHardeningEnd = '# ENV_FILE_HARDENING_END';

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
  const prepareIndex = workflow.indexOf('prepare_public_handoff');
  const recreateIndex = workflow.indexOf('docker compose up -d --no-build --force-recreate \\$ALL_SERVICES');

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
    .replace(/\\\$/g, () => '$');
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
  assert.equal(
    countOccurrences(workflow, 'update_image_tag_env "\\$IMAGE_TAG"'),
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
assertDeployTagInputIsNotInterpolatedIntoShellSource();

const deployEnv = assertWorkflowHardensEnvFile(deployWorkflowPath, 'deploy workflow', 2);
const rollbackEnv = assertWorkflowHardensEnvFile(rollbackWorkflowPath, 'rollback workflow', 1);
const functionalFixtureRan = [
  runEnvHardeningFixture('deploy workflow', deployEnv.hardeningBlock),
  runEnvHardeningFixture('rollback workflow', rollbackEnv.hardeningBlock),
].some(Boolean);

console.log('deploy handoff readiness fixture PASS');
console.log('deploy/rollback env hardening structural fixture PASS');
console.log(
  functionalFixtureRan
    ? 'deploy/rollback env hardening mode fixture PASS'
    : 'deploy/rollback env hardening mode fixture SKIP (requires POSIX chmod semantics)',
);
