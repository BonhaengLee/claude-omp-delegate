#!/usr/bin/env node
/** Build a self-contained Claude plugin marketplace archive after all gates pass. */
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readlink, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const NODE = process.execPath;

function fail(message) {
  throw new Error('[release:archive] ' + message);
}

function run(command, args, label, maxOutput = 16000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, shell: false, env: { ...process.env, COPYFILE_DISABLE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stdoutTruncated = false;
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); if (maxOutput > 0 && stdout.length > maxOutput) { stdoutTruncated = true; stdout = stdout.slice(-maxOutput); } });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); if (stderr.length > 16000) stderr = stderr.slice(-16000); });
    child.on('error', (error) => reject(new Error(label + ' could not start: ' + error.message)));
    child.on('close', (code, signal) => {
      if (code === 0) resolve({ stdout, stderr, stdoutTruncated });
      else reject(new Error(label + ' failed (' + (code === null ? 'signal ' + signal : 'exit ' + code) + '): ' + (stderr || stdout).trim()));
    });
  });
}

async function runNode(script) {
  return run(NODE, [script], script);
}

async function copyEntry(source, target, sourceRoot) {
  const info = await lstat(source);
  if (info.isSymbolicLink()) {
    const link = await readlink(source);
    if (path.isAbsolute(link)) fail('archive source has an absolute symlink: ' + source);
    const resolved = path.resolve(path.dirname(source), link);
    const relative = path.relative(sourceRoot, resolved);
    if (relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) fail('archive source symlink escapes its source tree: ' + source);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
    await symlink(link, target);
    return;
  }
  if (info.isDirectory()) {
    await mkdir(target, { recursive: true, mode: 0o755 });
    for (const child of await readdir(source)) await copyEntry(path.join(source, child), path.join(target, child), sourceRoot);
    return;
  }
  if (!info.isFile()) fail('archive source is not a regular file: ' + source);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
  await cp(source, target, { force: true });
  await chmod(target, 0o644);
}

async function archiveListing(archive) {
  const result = await run('tar', ['-tzf', archive], 'archive listing check', 1024 * 1024);
  if (result.stdoutTruncated) fail('archive listing exceeded its bound; refusing a partial privacy check');
  return result.stdout.split(/\r?\n/).filter(Boolean);
}

async function main() {
  await runNode('scripts/package-plugin.mjs');
  await runNode('scripts/check-package.mjs');
  await runNode('scripts/check-public.mjs');
  const packageJson = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  if (!packageJson.version || !/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(packageJson.version)) fail('package.json version is not archive-safe');
  await mkdir(DIST, { recursive: true, mode: 0o755 });
  const stage = await mkdtemp(path.join(DIST, '.archive-stage-'));
  const archiveRoot = path.join(stage, 'claude-omp-delegate');
  const archive = path.join(DIST, 'claude-omp-delegate-' + packageJson.version + '-marketplace.tgz');
  const checksumFile = archive + '.sha256';
  try {
    const entries = ['.claude-plugin', 'plugins/omp', 'LICENSE', 'README.md', 'AGENTS.md', 'CONTRIBUTING.md', 'SECURITY.md', 'THIRD_PARTY_NOTICES.md', 'docs/public', 'licenses', 'package.json'];
    for (const relative of entries) {
      const source = path.join(ROOT, relative);
      try { await lstat(source); } catch (error) { fail('archive source is unavailable: ' + relative + ': ' + error.message); }
      await copyEntry(source, path.join(archiveRoot, relative), ROOT);
    }
    await run('tar', ['-czf', archive, '-C', stage, 'claude-omp-delegate'], 'marketplace archive');
    const listing = await archiveListing(archive);
    if (listing.some((item) => item.split('/').some((part) => part.startsWith('._')))) fail('archive contains AppleDouble metadata');
    const required = [
      'claude-omp-delegate/.claude-plugin/marketplace.json',
      'claude-omp-delegate/plugins/omp/.mcp.json',
      'claude-omp-delegate/plugins/omp/runtime/server.js',
      'claude-omp-delegate/plugins/omp/runtime/node_modules/@modelcontextprotocol/sdk/package.json',
    ];
    for (const item of required) if (!listing.includes(item)) fail('archive is missing ' + item);
    for (const forbidden of ['verify/', 'docs/implementation-plan.md', 'claude-omp-delegate/node_modules/', 'plugins/omp/runtime-stage-']) {
      if (listing.some((item) => item.includes(forbidden))) fail('archive contains forbidden private/generated path ' + forbidden);
    }
    const hash = crypto.createHash('sha256').update(await readFile(archive)).digest('hex');
    await writeFile(checksumFile, hash + '  ' + path.basename(archive) + '\n', { encoding: 'utf8', mode: 0o644 });
    const checksumText = await readFile(checksumFile, 'utf8');
    if (checksumText !== hash + '  ' + path.basename(archive) + '\n') fail('archive checksum reread mismatch');
    console.log(JSON.stringify({ archive: path.relative(ROOT, archive), sha256: hash, checksum: path.relative(ROOT, checksumFile), entries: listing.length, selfContainedRuntime: true }, null, 2));
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
