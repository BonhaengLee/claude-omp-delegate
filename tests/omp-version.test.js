import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OMP_ALLOW_UNSUPPORTED_ENV, OMP_COMPAT, classifyOmpVersion } from '../src/contracts.js';
import { doctor } from '../src/jobs.js';
import { renderDoctor, renderError } from '../src/render.js';

test('classifies OMP versions against the compatibility range', () => {
  assert.deepEqual(OMP_COMPAT.tested.map((version) => classifyOmpVersion(version).status), OMP_COMPAT.tested.map(() => 'tested'));
  assert.deepEqual(classifyOmpVersion('18.3.9'), { status: 'untested', accepted: true, warning: 'OMP 18.3.9 is inside the supported range but has no recorded host verification (tested: ' + OMP_COMPAT.tested.join(', ') + ').' });
  assert.deepEqual(classifyOmpVersion('18.9.0').accepted, true);
  for (const version of ['18.2.11', '19.0.0', '20.1.0', '18.3', 'garbage']) {
    const verdict = classifyOmpVersion(version);
    assert.deepEqual([verdict.status, verdict.accepted], ['unsupported', false], version);
  }
  const forced = classifyOmpVersion('19.0.0', true);
  assert.deepEqual([forced.status, forced.accepted], ['unsupported', true]);
  assert.match(forced.warning ?? '', new RegExp(OMP_ALLOW_UNSUPPORTED_ENV + '=1'));
});

/** @param {string} versionLine */
async function withFakeOmp(versionLine, env, run) {
  const stateRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'omp-version-state-')));
  const workspace = await realpath(await mkdtemp(path.join(os.tmpdir(), 'omp-version-ws-')));
  const executable = path.join(stateRoot, 'omp');
  await writeFile(executable, '#!/usr/bin/env node\nif (process.argv.includes("--version")) { process.stdout.write(' + JSON.stringify(versionLine + '\n') + '); process.exit(0); }\nprocess.exit(2);\n');
  await chmod(executable, 0o755);
  await writeFile(path.join(stateRoot, 'config.json'), JSON.stringify({ version: 1, executable }) + '\n', { mode: 0o600 });
  const saved = { state: process.env.OMP_DELEGATE_STATE_DIR, allow: process.env[OMP_ALLOW_UNSUPPORTED_ENV] };
  process.env.OMP_DELEGATE_STATE_DIR = stateRoot;
  if (env.allow) process.env[OMP_ALLOW_UNSUPPORTED_ENV] = '1'; else delete process.env[OMP_ALLOW_UNSUPPORTED_ENV];
  try { return await run(workspace); }
  finally {
    if (saved.state === undefined) delete process.env.OMP_DELEGATE_STATE_DIR; else process.env.OMP_DELEGATE_STATE_DIR = saved.state;
    if (saved.allow === undefined) delete process.env[OMP_ALLOW_UNSUPPORTED_ENV]; else process.env[OMP_ALLOW_UNSUPPORTED_ENV] = saved.allow;
    await rm(stateRoot, { recursive: true, force: true }); await rm(workspace, { recursive: true, force: true });
  }
}

test('doctor accepts a newer in-range OMP and reports the actual version with a warning', async () => {
  await withFakeOmp('omp/18.3.9', {}, async (workspace) => {
    const report = await doctor({ workspace });
    assert.deepEqual([report.ompVersion, report.ompVersionStatus], ['18.3.9', 'untested']);
    assert.equal(report.warnings.filter((warning) => warning.startsWith('OMP 18.3.9 is inside the supported range')).length, 1);
    assert.match(renderDoctor(report).summary, /OMP 버전: 18\.3\.9 \(지원 범위 안 · 호스트 검증 기록 없음\)/);
  });
});

test('doctor refuses an out-of-range OMP with install guidance, and the override downgrades it to a warning', async () => {
  await withFakeOmp('omp/19.0.0', {}, async (workspace) => {
    const error = await doctor({ workspace }).then(() => undefined, (caught) => caught);
    assert.equal(error?.code, 'VERSION_UNSUPPORTED');
    const rendered = renderError(error);
    assert.deepEqual(rendered.nextActions.filter((action) => action.includes('https://omp.sh/install')).length, 1);
    assert.deepEqual(rendered.nextActions.filter((action) => action.includes(OMP_ALLOW_UNSUPPORTED_ENV + '=1')).length, 1);
  });
  await withFakeOmp('omp/19.0.0', { allow: true }, async (workspace) => {
    const report = await doctor({ workspace });
    assert.deepEqual([report.ompVersion, report.ompVersionStatus], ['19.0.0', 'unsupported']);
  });
});
