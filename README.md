# gamehunter-com-br/.github

**Reusable workflows + composite actions** centralizados pro ecossistema GameHunter
(8 repos: backend, frontend, admin, design, contracts, api-client, integrations,
scrapers).

Substitui workflows duplicados em cada repo por chamadas a este `.github`,
reduzindo ~1.000 LoC YAML e centralizando manutenção de pipeline.

## Reusable workflows disponíveis

### `.github/workflows/promote-release.yml`

Cria a próxima tag semver (`vX.Y.Z`) a partir do último tag existente.

**Inputs:**
- `bump` (string, choice: patch/minor/major) — tipo de bump.
- `ref` (string, default `main`) — branch/SHA pra tagar (deve ser ancestor de main).

**Secrets:**
- `RELEASE_TAG_TOKEN` — PAT com permissão `contents: write` que dispara workflows downstream (`GITHUB_TOKEN` não dispara).

**Stub no consumer (~12 LoC):**

```yaml
name: Promote Release
on:
  workflow_dispatch:
    inputs:
      bump:
        description: 'Semver bump'
        required: true
        default: patch
        type: choice
        options: [patch, minor, major]
      ref:
        description: 'Branch or commit SHA'
        required: true
        default: main
        type: string

jobs:
  promote:
    uses: gamehunter-com-br/.github/.github/workflows/promote-release.yml@v1
    with:
      bump: ${{ inputs.bump }}
      ref: ${{ inputs.ref }}
    secrets:
      RELEASE_TAG_TOKEN: ${{ secrets.RELEASE_TAG_TOKEN }}
```

> ⚠️ **Note:** This reusable creates the tag but does NOT bump `package.json`
> version. Bump it manually on a PR before triggering promote-release, or
> the next `npm publish` will fail with E409 conflict.

### `.github/workflows/publish-package.yml`

Publica package npm no GitHub Packages quando tag `vX.Y.Z` é pushada.

**Inputs:**
- `node-version` (string, default `'22'`)
- `runner` (string, default `blacksmith-4vcpu-ubuntu-2404`)
- `build-command` (string, default `npm run build`)
- `publish-command` (string, default `npm publish`)
- `needs-cross-repo-deps` (boolean, default `false`) — set `true` se package depende de outros `@gamehunter-com-br/*` (usa `NPM_PACKAGES_READ_TOKEN` em `npm ci`).

**Secrets:**
- `NPM_PACKAGES_READ_TOKEN` (opcional) — required quando `needs-cross-repo-deps=true`.

**Stub no consumer (~17 LoC):**

```yaml
name: Publish to GitHub Packages

on:
  push:
    tags:
      - 'v*'

permissions:
  contents: read
  packages: write

jobs:
  publish:
    uses: gamehunter-com-br/.github/.github/workflows/publish-package.yml@v1
    permissions:
      contents: read
      packages: write
    with:
      needs-cross-repo-deps: true   # opcional
    secrets:
      NPM_PACKAGES_READ_TOKEN: ${{ secrets.NPM_PACKAGES_READ_TOKEN }}
```

> ⚠️ **`permissions: packages: write` é OBRIGATÓRIO no caller** — o reusable
> declara permissions internamente, mas o GITHUB_TOKEN default tem
> `packages: read`, e callers de reusable workflows herdam o token do
> caller. Sem o block `permissions:` na stub, o run falha com
> `startup_failure` (não chega nem ao step de `npm publish`).

### `.github/workflows/deploy-via-ssh.yml`

Deploya uma imagem GHCR no VPS via Docker Compose.

**Inputs F3-77 para workers:**

- `extra-services` (string, default `''`) - services adicionais no compose, ex.: `workers`.
- `deploy-workers` (string, default `auto`) - `auto`, `true` ou `false`. Em `false`, remove `workers` da lista
  efetiva; em `true`, adiciona `workers` para backend. Em `auto`, o reusable compara o tag atual com o tag semver
  anterior e so reinicia `workers` quando mudam paths de runtime de jobs/workers: `src/queue/`, `src/workers/`,
  `src/services/jobs/`, `src/services/admin/job-runs.js`, `src/services/job-ledger-cleanup.js`, `src/db/`,
  `scripts/deploy-*`, `docker-compose.yml`, lock/package ou os workflows de deploy/build.
- `worker-drain-enabled` (string, default `'true'`) - quando `true` e `workers` esta na lista efetiva, roda
  `npm run deploy:workers:drain` antes do restart.
- `worker-drain-timeout-minutes` (string, default `'15'`) - timeout do drain.

O drain roda depois da migration do backend, usando a nova imagem ja pullada, e antes de `docker compose up` recriar
`workers`. Em sucesso de health, o workflow chama `npm run deploy:workers:resume`; em rollback/falha, o trap tenta
retomar a fila em best-effort. Exit codes do drain: `0` libera, `20` bloqueia por politica, `21` timeout, `22` estado
inseguro e `1` erro tecnico.

Use override `deploy-workers=true` quando a release docs/API-only ainda precisa reiniciar workers por operacao manual.
Use `deploy-workers=false` quando a mudanca de backend nao toca runtime dos workers e o diff automatico for
conservador demais.

## Política de versionamento

- Reusable workflows são pinned por **tag semver** (`@v1`) em produção, ou por
  **SHA** durante adoção/rollout canary.
- Bumps:
  - **Patch** — bug fix interno (mesmo contrato de inputs/outputs).
  - **Minor** — novo input opcional; backward-compatible.
  - **Major** — input/output renamed/removed; breaking pra consumers.
- Cada major bump precisa janela de comunicação aos owners dos 8 repos.

## Rollout canary

Adoção de novo reusable segue padrão:

1. **Canary**: `gamehunter-integrations` (lib menos crítica) migra primeiro,
   pinned por SHA.
2. **Wave 1 (libs publicáveis)**: contracts, api-client, scrapers em paralelo.
3. **Wave 2 (apps + design)**: backend → frontend → admin (sequencial), design.

Workflows antigos preservados como `*.yml.OLD` por 30 dias antes de deletar.
