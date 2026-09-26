#!/usr/bin/env node
/** Build a self-contained Claude plugin marketplace archive after all gates pass. */
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readlink, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizedTarFlags, tarFlavor, tarMetadataFindings, zipMetadataFindings } from './lib/archive-metadata.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const NODE = process.execPath;

function fail(message) {
  throw new Error('[release:archive] ' + message);
}

function run(command, args, label, maxOutput = 16000, cwd = ROOT) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false, env: { ...process.env, COPYFILE_DISABLE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
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

/** Marketplace shipped inside the offline tgz: points at the bundled plugin directory. */
export const LOCAL_MARKETPLACE_NAME = 'local-omp-delegate';
function localMarketplace(version) {
  return {
    name: LOCAL_MARKETPLACE_NAME,
    owner: { name: 'BonhaengLee' },
    metadata: { description: 'Offline marketplace bundled in the claude-omp-delegate release archive.', version },
    plugins: [{ name: 'omp', source: './plugins/omp', version }],
  };
}

async function sha256File(file) {
  return crypto.createHash('sha256').update(await readFile(file)).digest('hex');
}

async function writeChecksum(file) {
  const hash = await sha256File(file);
  const checksumFile = file + '.sha256';
  await writeFile(checksumFile, hash + '  ' + path.basename(file) + '\n', { encoding: 'utf8', mode: 0o644 });
  if (await readFile(checksumFile, 'utf8') !== hash + '  ' + path.basename(file) + '\n') fail('checksum reread mismatch: ' + path.basename(file));
  return { hash, checksumFile };
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
    await writeFile(path.join(archiveRoot, '.claude-plugin', 'marketplace.json'), JSON.stringify(localMarketplace(packageJson.version), null, 2) + '\n', { mode: 0o644 });
    const flavor = tarFlavor((await run('tar', ['--version'], 'tar version')).stdout);
    await run('tar', ['-czf', archive, ...normalizedTarFlags(flavor), '-C', stage, 'claude-omp-delegate'], 'marketplace archive');
    const tarFindings = tarMetadataFindings(await readFile(archive));
    if (tarFindings.length) fail('archive carries builder account/xattr metadata:\n' + tarFindings.slice(0, 10).join('\n'));
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
    const { hash } = await writeChecksum(archive);
    if (path.basename(checksumFile) !== path.basename(archive) + '.sha256') fail('unexpected checksum name');

    // Plugin-only zip for the `archive` marketplace source: omp/.claude-plugin/plugin.json at one wrapping directory.
    const zipStage = path.join(stage, 'zip');
    await copyEntry(path.join(archiveRoot, 'plugins', 'omp'), path.join(zipStage, 'omp'), archiveRoot);
    const pluginZip = path.join(DIST, 'claude-omp-delegate-omp-' + packageJson.version + '.zip');
    await rm(pluginZip, { force: true });
    await run('zip', ['-X', '-r', '-q', '-y', pluginZip, 'omp'], 'plugin zip', 16000, zipStage);
    const zipFindings = zipMetadataFindings(await readFile(pluginZip));
    if (zipFindings.length) fail('plugin zip carries builder metadata:\n' + zipFindings.slice(0, 10).join('\n'));
    const zipListing = (await run('unzip', ['-Z1', pluginZip], 'plugin zip listing', 1024 * 1024)).stdout.split(/\r?\n/).filter(Boolean);
    for (const item of ['omp/.claude-plugin/plugin.json', 'omp/.mcp.json', 'omp/runtime/server.js', 'omp/runtime/node_modules/@modelcontextprotocol/sdk/package.json']) if (!zipListing.includes(item)) fail('plugin zip is missing ' + item);
    const zipChecksum = await writeChecksum(pluginZip);
    console.log(JSON.stringify({ archive: path.relative(ROOT, archive), sha256: hash, checksum: path.relative(ROOT, checksumFile), entries: listing.length, selfContainedRuntime: true, pluginZip: path.relative(ROOT, pluginZip), pluginZipSha256: zipChecksum.hash, pluginZipEntries: zipListing.length, tarFlavor: flavor }, null, 2));
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
