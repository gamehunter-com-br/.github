#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflowPath = resolve(repoRoot, '.github/workflows/deploy-via-ssh.yml');

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
  const workflow = readFileSync(workflowPath, 'utf8');
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
  assert.match(workflow, /rollback_service/);
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

console.log('deploy handoff readiness fixture PASS');
