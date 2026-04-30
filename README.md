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
