import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import test from 'node:test';

const source = readFileSync(new URL('../.github/workflows/build-push-image.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function block(key) {
  const match = source.match(new RegExp(`          ${key}: \\|\\n((?:            .*\\n)+)`));
  assert.ok(match, `missing action input ${key}`);
  return match[1];
}

// Evaluate the workflow's actual conditional expressions with synthetic data,
// instead of maintaining a second implementation of its routing decision.
function evaluate(template, enabled) {
  const context = { inputs: { 'sentry-buildkit-secret': enabled, 'extra-build-args': 'PUBLIC=value' },
    secrets: { SENTRY_AUTH_TOKEN: 'synthetic-unit-secret', NPM_PACKAGES_READ_TOKEN: '', GITHUB_TOKEN: 'synthetic-gh-token' },
    github: { run_id: '123', run_attempt: '2', ref_type: 'tag' } };
  return template.replace(/\$\{\{ (.*?) \}\}/g, (_, expression) => evaluateExpression(expression, context));
}
function evaluateExpression(expression, context) {
  const expressionWithValues = expression.replace(/\b(inputs|secrets|github)\.([A-Za-z0-9_-]+)/g,
    (_, object, key) => JSON.stringify(context[object][key]));
  // Expressions are trusted repository source and this test passes only fixed
  // synthetic values. No environment, GitHub token or external input is read.
  return Function('format', `"use strict"; return (${expressionWithValues});`)(
    (format, ...values) => format.replace(/\{(\d+)\}/g, (_, index) => values[Number(index)]));
}

test('default is backwards compatible and the validator executes this test', () => {
  assert.match(source, /sentry-buildkit-secret:\n(?:.*\n){1,4}        default: false\n        type: boolean/);
  const validator = readFileSync(new URL('../.github/workflows/validate-reusable-workflows.yml', import.meta.url), 'utf8');
  assert.match(validator, /node --test scripts\/test-sentry-build-secret\.mjs/);
});
test('opt-in keeps the Sentry value outside build args and supplies it solely as a secret', () => {
  const args = evaluate(block('build-args'), true);
  const secrets = evaluate(block('secrets'), true);
  assert.ok(!args.includes('synthetic-unit-secret'));
  assert.ok(!args.includes('SENTRY_AUTH_TOKEN='));
  assert.ok(args.includes('SENTRY_UPLOAD_RUN=123-2'));
  assert.ok(secrets.includes('SENTRY_AUTH_TOKEN=synthetic-unit-secret'));
});
test('callers without opt-in keep their previous argument and cache behavior', () => {
  const args = evaluate(block('build-args'), false);
  assert.ok(args.includes('SENTRY_AUTH_TOKEN=synthetic-unit-secret'));
  assert.ok(!args.includes('SENTRY_UPLOAD_RUN='));
  assert.ok(!evaluate(block('secrets'), false).includes('synthetic-unit-secret'));
  assert.match(source, /cache-from: type=registry/);
  assert.match(source, /cache-to: type=registry,.*mode=max/);
});
test('opt-in never takes a pre-existing SHA-image shortcut, including a previous manual build', () => {
  const step = source.slice(source.indexOf('      - name: Check if SHA image already exists'), source.indexOf('      - uses: docker/setup-buildx-action'));
  const condition = step.match(/        if: (.+)/)?.[1];
  assert.ok(condition);
  for (const ref of ['tag', 'branch']) {
    const context = { inputs: { 'sentry-buildkit-secret': true }, github: { ref_type: ref } };
    assert.equal(evaluateExpression(condition, context), false);
  }
  assert.equal(evaluateExpression(condition, { inputs: { 'sentry-buildkit-secret': false }, github: { ref_type: 'tag' } }), true);
});
test('tag and OCI identity gates remain part of the path', () => {
  for (const name of ['Require release tag on main', 'Require release tag to advance the previous release', 'Resolve and verify published image identity', 'Upload immutable release identity']) {
    assert.ok(source.includes(`- name: ${name}`));
  }
  assert.match(source, /if \[ "\$OCI_REVISION" != "\$EXPECTED_GIT_SHA" \]/);
});

test('the actual shell rejects argument bypasses without printing their values', () => {
  const start = source.indexOf('      - name: Validate Sentry secret channel');
  const next = source.indexOf('\n      - name:', start + 1);
  const step = source.slice(start, next);
  const run = step.slice(step.indexOf('        run: |\n') + '        run: |\n'.length)
    .split('\n').map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n');
  const shell = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
  assert.ok(process.platform !== 'win32' || existsSync(shell), 'Git Bash required for the real shell fixture');
  for (const [args, code] of [['PUBLIC=value', 0], ['', 0], ['SENTRY_AUTH_TOKEN=synthetic-secret', 1],
    ['PUBLIC=value\n  SENTRY_AUTH_TOKEN =synthetic-secret', 1], ['SENTRY_UPLOAD_RUN=unchanging', 1]]) {
    const result = spawnSync(shell, ['--noprofile', '--norc', '-c', run], { encoding: 'utf8',
      env: { ...process.env, EXTRA_BUILD_ARGS: args } });
    assert.equal(result.status, code, result.stderr);
    assert.ok(!(result.stdout + result.stderr).includes('synthetic-secret'));
    assert.ok(!(result.stdout + result.stderr).includes('unchanging'));
  }
});
