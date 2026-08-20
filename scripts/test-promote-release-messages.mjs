#!/usr/bin/env node
/**
 * O promote-release precisa dizer QUAL coisa quebrou.
 *
 * Em 20/08/2026 ele reprovou o release do gamehunter-frontend v3.47.3 no passo
 * `Require release ref on main`, cujo nome e cuja unica mensagem mandam conferir
 * se o commit esta na main. O commit estava (556a263e, ancestor de origin/main).
 * A causa era RELEASE_TAG_TOKEN invalido: o `git fetch` autenticado morreu na
 * primeira linha, com exit 128, e sob `set -e` o script terminou ANTES de
 * imprimir o `::error::`. Sobrou o nome do passo como unica pista, apontando
 * para o lugar errado.
 *
 * As fixtures rodam o shell REAL extraido do workflow, nao uma copia — mesma
 * regra do test-deploy-handoff-readiness.mjs. Copia testada e copia validada.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflowPath = resolve(repoRoot, '.github/workflows/promote-release.yml');
// O clone no Windows chega com CRLF (core.autocrlf). O extrator casa em LF,
// entao normaliza antes — senao o teste "passa" por nao achar nada.
const workflow = readFileSync(workflowPath, 'utf8').replace(/\r\n/g, '\n');

const posixShellFixturesAvailable = process.platform !== 'win32' ||
  process.env.GAMEHUNTER_FORCE_POSIX_FIXTURES === '1';

/**
 * O bloco `run:` de um passo, dedentado e com as interpolacoes `${{ }}` do
 * Actions resolvidas para valores de fixture — o shell exatamente como o runner
 * o executa.
 */
function extractRunBlock(stepName) {
  const marker = `      - name: ${stepName}\n`;
  const start = workflow.indexOf(marker);
  assert.ok(start > -1, `workflow must define the step "${stepName}"`);
  const runIdx = workflow.indexOf('        run: |\n', start);
  assert.ok(runIdx > -1, `step "${stepName}" must have a run block`);
  const bodyStart = runIdx + '        run: |\n'.length;
  // Para no PROXIMO item da lista de steps, seja ele `- name:` ou `- uses:`.
  // Casar so em `- name:` engolia o checkout inteiro para dentro da fixture.
  const nextStep = workflow.indexOf('\n      - ', bodyStart);
  const body = workflow.slice(bodyStart, nextStep > -1 ? nextStep : undefined);

  return body
    .split('\n')
    .map((line) => (line.startsWith('          ') ? line.slice(10) : line))
    .join('\n')
    .replace(/\$\{\{ inputs\.ref \}\}/g, 'main')
    .replace(/\$\{\{ inputs\.bump \}\}/g, 'patch')
    .trimEnd();
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
 * GUARD 1 — presenca nao e validade.
 *
 * `[ -z "$TOKEN" ]` sai verde com PAT expirado ou revogado, que e o modo de
 * falha provavel de um PAT. No run que motivou este teste, este passo saiu
 * `success` com o token ja quebrado, e quem gritou foi o passo seguinte, por
 * acidente e com a mensagem errada.
 */
function assertTokenGuardChecksValidity() {
  const block = extractRunBlock('Require release token');
  assert.match(
    block,
    /git ls-remote|gh api|curl/,
    'Require release token must PROVE the token works, not just that it is non-empty',
  );

  if (!posixShellFixturesAvailable) return false;

  // git que aceita qualquer coisa: token presente e valido -> passa.
  const ok = runFixture('gh-token-ok-', `#!/usr/bin/env bash
export RELEASE_TAG_TOKEN=t0ken
export GITHUB_REPOSITORY=gamehunter-com-br/gamehunter-frontend
git() { return 0; }
export -f git 2>/dev/null || true
${block}
`);
  assert.equal(ok.status, 0, `valid token must pass:\n${ok.stdout}${ok.stderr}`);

  // git que recusa a credencial: token presente porem invalido -> reprova AQUI.
  const bad = runFixture('gh-token-bad-', `#!/usr/bin/env bash
export RELEASE_TAG_TOKEN=expirado
export GITHUB_REPOSITORY=gamehunter-com-br/gamehunter-frontend
git() {
  echo 'remote: Invalid username or token. Password authentication is not supported for Git operations.' >&2
  return 128
}
export -f git 2>/dev/null || true
${block}
`);
  assert.notEqual(bad.status, 0, 'invalid token must fail the token guard');
  const badOut = `${bad.stdout}${bad.stderr}`;
  assert.match(badOut, /::error::/, 'invalid token must emit a GitHub error annotation');
  assert.match(
    badOut,
    /RELEASE_TAG_TOKEN/,
    'the token failure must name RELEASE_TAG_TOKEN so nobody goes looking at the commit',
  );
  return true;
}

/**
 * GUARD 2 — fetch morto e ref fora da main sao fatos diferentes.
 *
 * O `::error::` de ancestralidade so pode aparecer quando o veredito de
 * ancestralidade foi de fato calculado. Se o fetch morreu, a mensagem tem que
 * falar de fetch.
 */
function assertRefGuardSeparatesFetchFromVerdict() {
  if (!posixShellFixturesAvailable) return false;
  const block = extractRunBlock('Require release ref on main');

  // fetch morre (token recusado). NAO pode culpar a ancestralidade.
  const fetchDied = runFixture('gh-ref-fetch-', `#!/usr/bin/env bash
export RELEASE_TAG_TOKEN=expirado
export GITHUB_REPOSITORY=gamehunter-com-br/gamehunter-frontend
git() {
  if [ "\$1" = fetch ]; then
    echo 'fatal: Authentication failed' >&2
    return 128
  fi
  return 0
}
export -f git 2>/dev/null || true
${block}
`);
  assert.notEqual(fetchDied.status, 0, 'a dead fetch must fail the step');
  const fetchOut = `${fetchDied.stdout}${fetchDied.stderr}`;
  assert.match(fetchOut, /::error::/, 'a dead fetch must emit an error annotation, not die silently');
  assert.doesNotMatch(
    fetchOut,
    /not reachable from origin\/main/,
    'a dead fetch must NOT accuse the commit of being off main — that was the 20/08/2026 bug',
  );

  // fetch ok, mas HEAD realmente nao esta na main -> a mensagem de ancestralidade.
  const notAncestor = runFixture('gh-ref-anc-', `#!/usr/bin/env bash
export RELEASE_TAG_TOKEN=t0ken
export GITHUB_REPOSITORY=gamehunter-com-br/gamehunter-frontend
git() {
  if [ "\$1" = fetch ]; then return 0; fi
  if [ "\$1" = merge-base ]; then return 1; fi
  return 0
}
export -f git 2>/dev/null || true
${block}
`);
  assert.notEqual(notAncestor.status, 0, 'a non-ancestor ref must fail the step');
  assert.match(
    `${notAncestor.stdout}${notAncestor.stderr}`,
    /not reachable from origin\/main/,
    'a real ancestry failure must still say so',
  );
  return true;
}

const tokenFixtureRan = assertTokenGuardChecksValidity();
const refFixtureRan = assertRefGuardSeparatesFetchFromVerdict();

console.log(
  tokenFixtureRan
    ? 'promote-release token validity fixture PASS'
    : 'promote-release token validity fixture SKIP (requires POSIX shell)',
);
console.log(
  refFixtureRan
    ? 'promote-release fetch-vs-ancestry fixture PASS'
    : 'promote-release fetch-vs-ancestry fixture SKIP (requires POSIX shell)',
);
