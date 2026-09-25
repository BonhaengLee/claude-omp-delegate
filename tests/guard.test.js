import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, realpath, rmdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GUARD = path.join(ROOT, 'plugins', 'omp', 'scripts', 'guard.cjs');

async function runGuard(value, raw = false) {
  const child = spawn(process.execPath, [GUARD], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.end(raw ? value : JSON.stringify(value));
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  return { code, stdout, stderr };
}

async function removeEmptyDirectory(directory) {
  await rmdir(directory);
}

test('mutating start/followup are blocked in Plan mode and malformed input fails closed', async () => {
  const workspace = await realpath(await mkdtemp(path.join(os.tmpdir(), 'omp-guard-')));
  try {
    const plan = await runGuard({
      tool_name: 'mcp__plugin_omp_omp__omp_start',
      permission_mode: 'plan',
      cwd: workspace,
      tool_input: { workspace },
    });
    assert.equal(plan.code, 2);
    assert.match(plan.stderr, /Plan mode/);
    assert.equal(plan.stdout, '');

    const followup = await runGuard({
      tool_name: 'mcp__plugin_omp_omp__omp_followup',
      permission_mode: 'default',
      cwd: workspace,
      tool_input: { workspace },
    });
    assert.equal(followup.code, 0, followup.stderr);
    assert.equal(followup.stdout, '');

    const missingMode = await runGuard({
      tool_name: 'mcp__plugin_omp_omp__omp_start',
      cwd: workspace,
      tool_input: { workspace },
    });
    assert.equal(missingMode.code, 2);
    assert.match(missingMode.stderr, /unknown|missing/i);

    const malformed = await runGuard('{not-json', true);
    assert.equal(malformed.code, 2);
    assert.match(malformed.stderr, /valid JSON/);
  } finally {
    await removeEmptyDirectory(workspace);
  }
});

test('workspace path must resolve to the hook cwd while queries stay available in Plan mode', async () => {
  const cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), 'omp-guard-cwd-')));
  const other = await realpath(await mkdtemp(path.join(os.tmpdir(), 'omp-guard-other-')));
  try {
    const mismatch = await runGuard({
      tool_name: 'mcp__plugin_omp_omp__omp_start',
      permission_mode: 'default',
      cwd,
      tool_input: { workspace: other },
    });
    assert.equal(mismatch.code, 2);
    assert.match(mismatch.stderr, /same directory/);

    for (const tool_name of ['mcp__plugin_omp_omp__omp_status', 'mcp__plugin_omp_omp__omp_result', 'mcp__plugin_omp_omp__omp_cancel', 'mcp__plugin_omp_omp__omp_doctor']) {
      const query = await runGuard({ tool_name, permission_mode: 'plan' });
      assert.equal(query.code, 0, tool_name + ': ' + query.stderr);
      assert.equal(query.stderr, '');
    }
  } finally {
    await Promise.all([
      removeEmptyDirectory(cwd),
      removeEmptyDirectory(other),
    ]);
  }
});

test('unknown permission mode and unknown hook shape are denied', async () => {
  const workspace = await realpath(await mkdtemp(path.join(os.tmpdir(), 'omp-guard-mode-')));
  try {
    const unknownMode = await runGuard({
      tool_name: 'mcp__plugin_omp_omp__omp_followup',
      permission_mode: 'futureMode',
      cwd: workspace,
      tool_input: { workspace },
    });
    assert.equal(unknownMode.code, 2);
    assert.match(unknownMode.stderr, /unknown/);

    const unknownShape = await runGuard({ permission_mode: 'plan' });
    assert.equal(unknownShape.code, 2);
    assert.match(unknownShape.stderr, /tool_name/);
  } finally {
    await removeEmptyDirectory(workspace);
  }
});
