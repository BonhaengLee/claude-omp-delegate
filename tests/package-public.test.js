import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertSourceParity } from '../scripts/check-package.mjs';
import { pathViolations, scanText } from '../scripts/check-public.mjs';

test('package parity rejects stale and missing runtime source files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'omp-package-parity-'));
  const source = path.join(root, 'src');
  const runtime = path.join(root, 'runtime');
  await mkdir(source);
  await mkdir(runtime);
  try {
    await writeFile(path.join(source, 'worker.js'), 'export const version = 1;\n');
    await writeFile(path.join(runtime, 'worker.js'), 'export const version = 1;\n');
    assert.deepEqual(await assertSourceParity(source, runtime), ['worker.js']);

    await writeFile(path.join(source, 'worker.js'), 'export const version = 2;\n');
    await assert.rejects(() => assertSourceParity(source, runtime), /differs from src\/worker\.js/);

    await writeFile(path.join(source, 'extra.js'), 'export const extra = true;\n');
    await assert.rejects(() => assertSourceParity(source, runtime), /source set is stale/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('public scan rejects token-shaped values and personal paths but allows field names', () => {
  assert.deepEqual(scanText('fixture.js', 'const OPENAI_API_KEY = process.env.OPENAI_API_KEY;'), []);
  const fakeToken = ['sk-', 'proj-', '123456789012345678901234'].join('');
  assert.match(scanText('fixture.js', 'const key = "' + fakeToken + '";').join('\n'), /token-shaped secret/);
  const fakePath = ['/Users', 'private-user', 'project'].join('/');
  assert.match(scanText('fixture.js', 'const path = "' + fakePath + '";').join('\n'), /personal absolute path/);
  assert.deepEqual(pathViolations('tests/fixtures/fixture.js'), []);
  assert.match(pathViolations('state/session.json').join('\n'), /private state/);
  assert.match(pathViolations('credentials.json').join('\n'), /credential material/);
});
