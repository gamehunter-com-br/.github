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
- `needs-cross-repo-deps` (boolean, default `false`) — set `true` se o package
  depende de outros `@gamehunter-com-br/*`; o `npm ci` usa o secret opcional e
  faz fallback para o `GITHUB_TOKEN` do caller.

**Secrets:**
- `NPM_PACKAGES_READ_TOKEN` (opcional) — usado quando presente; caso contrário,
  o install usa o `GITHUB_TOKEN` do caller. O repositório consumidor precisa de
  acesso de leitura ao package em **Manage Actions access** para esse fallback.

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
- `release-identity-enabled` (boolean, default `false`) - depois do pull, valida os labels OCI e o repo digest
  da imagem e persiste atomicamente `GH_RELEASE_TAG`, `GH_GIT_SHA` e `GH_IMAGE_DIGEST` no `.env`, junto de
  `IMAGE_TAG`. O deploy falha fechado se qualquer parte da tupla estiver ausente ou malformada. Use somente em
  runtimes que consomem a identidade da release; o rollback reutiliza a mesma validação.
- `public-readiness-checks` (string, default `''`) - F1-175: lista separada por espaco de `host:/path`
  validada no VPS via nginx local (`curl --resolve host:443:127.0.0.1`) depois do health local e antes de
  declarar deploy saudavel. Vazio usa defaults por service: backend valida
  `gamehunter.com.br:/api/health` e `gamehunter.com.br:/api/rpc/health`; frontend valida
  `gamehunter.com.br:/`; admin valida `admin.gamehunter.com.br:/`. Use `none` apenas quando o service nao tem
  rota publica por nginx.
- `public-readiness-timeout-seconds` (string, default `'90'`) - tempo maximo do gate publico/nginx. Falha aciona
  o rollback ja existente do reusable.

O drain roda depois da migration do backend, usando a nova imagem ja pullada, e antes de `docker compose up` recriar
`workers`. Em sucesso de health, o workflow chama `npm run deploy:workers:resume`; em rollback/falha, o trap tenta
retomar a fila em best-effort. Exit codes do drain: `0` libera, `20` bloqueia por politica, `21` timeout, `22` estado
inseguro e `1` erro tecnico.

Para `backend` e `frontend`, o reusable agora protege o handoff de porta fixa antes de recriar o container canonico.
Ele sobe um candidato temporario em porta local alternativa, valida health e checks publicos do proprio servico, adiciona
essa porta ao upstream nginx como fallback, e so entao executa `docker compose up --force-recreate` na porta canonica.
Depois que a porta canonica nova passa, o candidato e removido do upstream e parado. Em falha, o rollback recria a tag
anterior enquanto o candidato continua protegendo o upstream publico. Readiness pos-restart sozinho nao e considerado
traffic-safe para servicos atras de nginx em porta fixa.

Depois do `docker compose up`, o reusable nao encerra apenas com o health local do container. O gate F1-175 tambem prova
que o nginx local consegue servir as rotas publicas configuradas sem `connect() failed`/upstream indisponivel. Isso evita
declarar deploy verde enquanto Cloudflare ou o usuario ainda receberiam 502/504 por upstream recusado no edge/origem.

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
