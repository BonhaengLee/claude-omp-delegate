import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizedTarFlags, tarFlavor, tarMetadataFindings, zipMetadataFindings } from '../scripts/lib/archive-metadata.mjs';
import { marketplaceFindings, releaseZipUrl, repositoryMarketplace } from '../scripts/set-marketplace-release.mjs';

const flavor = tarFlavor(spawnSync('tar', ['--version'], { encoding: 'utf8' }).stdout);
const env = { ...process.env, COPYFILE_DISABLE: '1' };

test('default tar output leaks a non-root owner; normalized flags produce clean headers', { skip: process.getuid?.() === 0 ? 'running as root: the leak cannot be observed' : false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'omp-archive-meta-'));
  try {
    await mkdir(path.join(root, 'pkg', 'nested'), { recursive: true });
    await writeFile(path.join(root, 'pkg', 'nested', 'file.txt'), 'hello\n');
    const leaky = path.join(root, 'leaky.tgz'); const clean = path.join(root, 'clean.tgz');
    assert.equal(spawnSync('tar', ['-czf', leaky, '-C', root, 'pkg'], { env }).status, 0);
    assert.equal(spawnSync('tar', ['-czf', clean, ...normalizedTarFlags(flavor), '-C', root, 'pkg'], { env }).status, 0);
    const leakyFindings = tarMetadataFindings(await readFile(leaky));
    assert.equal(leakyFindings.length, 3, leakyFindings.join('\n'));
    assert.deepEqual(tarMetadataFindings(await readFile(clean)), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('zip -X omits unix owner extra fields that plain zip records', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'omp-zip-meta-'));
  try {
    await mkdir(path.join(root, 'omp'), { recursive: true });
    await writeFile(path.join(root, 'omp', 'file.txt'), 'hello\n');
    assert.equal(spawnSync('zip', ['-r', '-q', 'plain.zip', 'omp'], { cwd: root, env }).status, 0);
    assert.equal(spawnSync('zip', ['-X', '-r', '-q', 'clean.zip', 'omp'], { cwd: root, env }).status, 0);
    assert.equal(zipMetadataFindings(await readFile(path.join(root, 'plain.zip'))).length, 2);
    assert.deepEqual(zipMetadataFindings(await readFile(path.join(root, 'clean.zip'))), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('repository marketplace entry is a pinned archive release zip', async () => {
  const sha = 'a'.repeat(64);
  assert.deepEqual(marketplaceFindings(repositoryMarketplace('0.1.1', sha)), []);
  assert.equal(releaseZipUrl('0.1.1'), 'https://github.com/BonhaengLee/claude-omp-delegate/releases/download/v0.1.1/claude-omp-delegate-omp-0.1.1.zip');
  const drifted = repositoryMarketplace('0.1.1', sha); drifted.plugins[0].source.url = releaseZipUrl('0.1.0');
  assert.deepEqual(marketplaceFindings(drifted), ['omp archive url must be ' + releaseZipUrl('0.1.1')]);
  assert.deepEqual(marketplaceFindings({ name: 'local-omp-delegate', plugins: [{ name: 'omp', source: './plugins/omp' }] }).length, 4);
});
