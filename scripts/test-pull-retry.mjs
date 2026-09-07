#!/usr/bin/env node
/**
 * O pull da imagem no VPS precisa sobreviver a um erro transitorio do registro.
 *
 * Em 07/09/2026 o deploy da v2.111.3 do gamehunter-backend (run 34149730367,
 * tentativa 1) morreu 13 s depois de comecar: `Login Succeeded` e, um segundo
 * depois, `backend Error error from registry: unauthorized` no
 * `docker compose pull`. A imagem estava publicada no GHCR desde 17:57:19 e o
 * rerun manual do mesmo job passou sem mudar nada. Sem retry, todo soluco do
 * GHCR vira deploy vermelho esperando um humano clicar em rerun.
 *
 * As fixtures rodam o shell REAL extraido do heredoc do workflow (bloco
 * PULL_RETRY_START/END), com `\$` desescapado como o runner faz — mesma regra
 * do test-deploy-handoff-readiness.mjs. Copia testada e copia validada.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflowPath = resolve(repoRoot, '.github/workflows/deploy-via-ssh.yml');
const workflow = readFileSync(workflowPath, 'utf8').replace(/\r\n/g, '\n');

const posixShellFixturesAvailable = process.platform !== 'win32' ||
  process.env.GAMEHUNTER_FORCE_POSIX_FIXTURES === '1';

function extractPullRetryBlock() {
  const start = workflow.indexOf('            # PULL_RETRY_START');
  const end = workflow.indexOf('            # PULL_RETRY_END');
  assert.ok(start > -1 && end > start, 'deploy-via-ssh.yml must delimit the pull retry helper with PULL_RETRY markers');
  return workflow
    .slice(start, end)
    .replace(/\\\$/g, () => '$')
    .split('\n')
    .map((line) => (line.startsWith('            ') ? line.slice(12) : line))
    .join('\n');
}

/**
 * CONTRATO ESTRUTURAL: todo pull de imagem passa pelo helper; o login inicial
 * usa a mesma funcao que o retry usa para se reautenticar.
 */
function assertEveryPullGoesThroughRetry() {
  const pulls = workflow.match(/^\s*(?:pull_with_retry )?docker (?:compose )?pull\b.*$/gm) || [];
  assert.ok(pulls.length >= 2, `expected the standard and protected pull sites, found ${pulls.length}`);
  for (const line of pulls) {
    assert.match(line, /pull_with_retry docker (?:compose )?pull/, `bare image pull must go through pull_with_retry: ${line.trim()}`);
  }
  assert.ok(workflow.includes('            registry_login\n'), 'initial docker login must reuse registry_login so the retry re-authenticates the same way');
  assert.equal(
    (workflow.match(/docker login ghcr\.io/g) || []).length,
    1,
    'docker login must be defined once, inside registry_login',
  );
}

function runFixture(prefix, script) {
  const dir = mkdtempSync(resolve(tmpdir(), prefix));
  const file = resolve(dir, 'fixture.sh');
  try {
    writeFileSync(file, script, { mode: 0o700 });
    return spawnSync('bash', [file], { cwd: dir, encoding: 'utf8' });
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

/**
 * FIXTURE: docker() falha nas duas primeiras tentativas com a mensagem real do
 * GHCR e passa na terceira; o retry re-loga entre tentativas e o deploy segue.
 * Com falha permanente, o helper desiste na terceira e devolve 1 com a
 * mensagem de FAIL — falha real continua vermelha.
 */
function runPullRetryFixtures() {
  const block = extractPullRetryBlock();
  assert.match(block, /max_attempts=3/, 'pull retry must try three times');
  assert.match(block, /registry_login \|\|/, 'pull retry must re-login between attempts without dying on a login hiccup');
  if (!posixShellFixturesAvailable) return false;

  const fixture = (failUntil) => `#!/usr/bin/env bash
set -euo pipefail
GHCR_PULL_TOKEN=t0ken
GH_OWNER=gamehunter-com-br
ATTEMPTS=0
LOGINS=0
sleep() { echo "sleep $1"; }
docker() {
  case "$1" in
    login)
      LOGINS=$((LOGINS + 1))
      return 0
      ;;
    compose|pull)
      ATTEMPTS=$((ATTEMPTS + 1))
      if [ "$ATTEMPTS" -lt "${failUntil}" ]; then
        echo 'Error response from daemon: error from registry: unauthorized' >&2
        return 1
      fi
      echo "pulled on attempt $ATTEMPTS"
      return 0
      ;;
    *) return 1 ;;
  esac
}
${block}
if pull_with_retry docker compose pull backend workers; then rc=0; else rc=$?; fi
echo "rc=$rc ATTEMPTS=$ATTEMPTS LOGINS=$LOGINS"
exit 0
`;

  const transient = runFixture('gh-pull-retry-ok-', fixture(3));
  assert.equal(transient.status, 0, `transient fixture must run:\n${transient.stdout}${transient.stderr}`);
  assert.match(transient.stdout, /pulled on attempt 3/, 'third attempt must succeed');
  assert.match(transient.stdout, /rc=0 ATTEMPTS=3 LOGINS=2/, `two re-logins and success:\n${transient.stdout}`);
  assert.match(transient.stdout, /sleep 10\nsleep 30/, 'delays must be 10 s then 30 s');
  assert.match(transient.stderr, /pull attempt 1\/3 failed: docker compose pull backend workers/);
  assert.match(transient.stderr, /pull attempt 2\/3 failed/);
  assert.doesNotMatch(transient.stderr, /FAIL: image pull failed/);

  const permanent = runFixture('gh-pull-retry-fail-', fixture(99));
  assert.equal(permanent.status, 0, `permanent fixture must run:\n${permanent.stdout}${permanent.stderr}`);
  assert.match(permanent.stdout, /rc=1 ATTEMPTS=3 LOGINS=2/, `permanent failure must stop after three attempts:\n${permanent.stdout}`);
  assert.match(permanent.stderr, /FAIL: image pull failed after 3 attempts/);
  return true;
}

assertEveryPullGoesThroughRetry();
const ran = runPullRetryFixtures();
console.log(ran ? 'image pull retry fixture PASS' : 'image pull retry fixture SKIP (requires POSIX shell)');
