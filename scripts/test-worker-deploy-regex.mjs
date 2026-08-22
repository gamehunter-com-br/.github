import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workflow = readFileSync(join(root, '.github/workflows/deploy-via-ssh.yml'), 'utf8');
const match = workflow.match(/WORKER_DEPLOY_RE='([^']+)'/);

assert.ok(match, 'deploy-via-ssh.yml must define WORKER_DEPLOY_RE');

const workerDeployPattern = new RegExp(match[1]);

const positiveCases = [
  'src/queue/scheduled-jobs.ts',
  'src/workers/main.ts',
  'src/services/jobs/worker-deploy-drain-service.ts',
  'src/services/affiliates/composed-confidence.js',
  'src/services/affiliates/base-affiliate-runner.js',
  'src/services/admin/job-runs.js',
  'src/services/job-ledger-cleanup.js',
  'src/db/pg-database.ts',
  'scripts/deploy-drain-workers.ts',
  'docker-compose.yml',
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
  'src/api/admin-games-management.js',
  'src/services/external/github-client.js',
  '.github/workflows/ci.yml',
];

for (const file of negativeCases) {
  assert.equal(workerDeployPattern.test(file), false, `${file} should not force worker deploy`);
}

console.log('worker deploy regex contract: ok');
