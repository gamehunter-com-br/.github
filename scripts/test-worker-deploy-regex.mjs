import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
// O clone no Windows chega com CRLF (core.autocrlf); normaliza antes de extrair.
const workflow = readFileSync(join(root, '.github/workflows/deploy-via-ssh.yml'), 'utf8').replace(/\r\n/g, '\n');
const match = workflow.match(/WORKER_DEPLOY_RE='([^']+)'/);

assert.ok(match, 'deploy-via-ssh.yml must define WORKER_DEPLOY_RE');

const workerDeployPattern = new RegExp(match[1]);

// Qualquer arquivo de runtime reinicia os workers. A lista fechada anterior deixava de fora
// src/services/hardware-catalog-service.js (fix de discovery de hardware de 07/09/2026), src/lib e
// config, todos importados por jobs que rodam no processo de workers.
const positiveCases = [
  'src/queue/scheduled-jobs.ts',
  'src/workers/main.ts',
  'src/services/jobs/worker-deploy-drain-service.ts',
  'src/services/affiliates/composed-confidence.js',
  'src/services/affiliates/base-affiliate-runner.js',
  'src/services/admin/job-runs.js',
  'src/services/job-ledger-cleanup.js',
  'src/services/hardware-catalog-service.js',
  'src/services/hardware-coverage-service.js',
  'src/services/external/github-client.js',
  'src/api/admin-games-management.js',
  'src/lib/http-client.js',
  'src/db/pg-database.ts',
  'config/env.ts',
  'scripts/deploy-drain-workers.ts',
  'scripts/run-hardware-discovery.js',
  'docker-compose.yml',
  'Dockerfile',
  'package.json',
  'pnpm-lock.yaml',
  '.github/workflows/deploy.yml',
  '.github/workflows/build-image.yml',
];

for (const file of positiveCases) {
  assert.ok(workerDeployPattern.test(file), `${file} should force worker deploy`);
}

const negativeCases = [
  'README.md',
  'docs/runbooks/deploy.md',
  'test/fixtures/guardrails/sample.json',
  'agent-workflows/commands/gh.release.md',
  '.github/workflows/ci.yml',
  '.github/dependabot.yml',
];

for (const file of negativeCases) {
  assert.equal(workerDeployPattern.test(file), false, `${file} should not force worker deploy`);
}

console.log('worker deploy regex contract: ok');

// ---------------------------------------------------------------------------
// Fixture do passo "Resolve worker deploy mode": roda o shell REAL extraido do
// workflow (entre WORKER_AUTO_MODE_START/END) num repositorio git temporario com
// tags duplicadas no mesmo commit, o caso que deixou os workers na versao velha
// no deploy da v2.111.1 (07/09/2026, run 34139971702: "auto compare
// v2.111.2..v2.111.1", diff vazio, MODE=false).
// ---------------------------------------------------------------------------
const posixShellFixturesAvailable = process.platform !== 'win32' ||
  process.env.GAMEHUNTER_FORCE_POSIX_FIXTURES === '1';

function extractAutoModeBlock() {
  const start = workflow.indexOf('            # WORKER_AUTO_MODE_START');
  const end = workflow.indexOf('            # WORKER_AUTO_MODE_END');
  assert.ok(start > -1 && end > start, 'deploy-via-ssh.yml must delimit the auto mode block with WORKER_AUTO_MODE markers');
  return workflow
    .slice(start, end)
    .split('\n')
    .map((line) => (line.startsWith('            ') ? line.slice(12) : line))
    .join('\n');
}

function runAutoModeFixture() {
  const block = extractAutoModeBlock();
  assert.match(block, /candidate_commit/, 'auto mode must compare candidate tag commits, not only tag names');
  assert.match(block, /MODE=true\n\s*REASON="auto fail-safe/, 'auto mode must fail safe to MODE=true when it cannot compare');
  if (!posixShellFixturesAvailable) return false;

  const dir = mkdtempSync(resolve(tmpdir(), 'gh-worker-auto-mode-'));
  try {
    const script = `#!/usr/bin/env bash
set -euo pipefail
export GIT_AUTHOR_NAME=fixture GIT_AUTHOR_EMAIL=fixture@example.com
export GIT_COMMITTER_NAME=fixture GIT_COMMITTER_EMAIL=fixture@example.com
git init -q repo
cd repo
mkdir -p src/services docs
echo a > src/services/a.js; git add -A; git commit -qm c1; git tag v1.0.0
echo d > docs/x.md; git add -A; git commit -qm c2; git tag v1.0.1; git tag v1.0.2
echo h > src/services/hardware-catalog-service.js; git add -A; git commit -qm c3; git tag v1.0.3; git tag v1.0.4

resolve_auto() {
  SERVICE=backend
  MODE=auto
  REASON="manual override"
  CHANGED_FILES=""
  TAG="$1"
${block}
  echo "$1 mode=$MODE reason=$REASON"
}
resolve_auto v1.0.4
resolve_auto v1.0.2
resolve_auto v1.0.0
resolve_auto sha-abc1234
`;
    const file = resolve(dir, 'fixture.sh');
    writeFileSync(file, script, { mode: 0o700 });
    const result = spawnSync('bash', [file], { cwd: dir, encoding: 'utf8' });
    assert.equal(result.status, 0, `auto mode fixture failed:\n${result.stdout}${result.stderr}`);
    const lines = result.stdout.trim().split('\n');
    // v1.0.4 duplica v1.0.3 (mesmo commit): a anterior real e a v1.0.2, e o diff traz src/ -> true.
    assert.equal(lines[0], 'v1.0.4 mode=true reason=auto compare v1.0.2..v1.0.4');
    // v1.0.2 duplica v1.0.1: anterior real v1.0.0, diff so em docs/ -> false.
    assert.equal(lines[1], 'v1.0.2 mode=false reason=auto compare v1.0.0..v1.0.2');
    // Primeira tag: nada para comparar -> fail-safe true.
    assert.equal(lines[2], 'v1.0.0 mode=true reason=auto fail-safe: nenhuma tag semver anterior aponta para outro commit');
    // Tag sha-*: nao e semver -> fail-safe true.
    assert.equal(lines[3], 'sha-abc1234 mode=true reason=auto fail-safe: tag sha-abc1234 nao e semver resolvivel');
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
  return true;
}

const ran = runAutoModeFixture();
console.log(`worker deploy auto mode fixture: ${ran ? 'ok' : 'skipped (POSIX shell fixtures unavailable)'}`);
