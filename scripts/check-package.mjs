#!/usr/bin/env node
/**
 * Verify that the generated plugin runtime is complete, fresh, production-only,
 * and usable without resolving dependencies from the project checkout.
 */
import { cp, lstat, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(ROOT, 'src');
const PLUGIN = path.join(ROOT, 'plugins', 'omp');
const RUNTIME = path.join(PLUGIN, 'runtime');
const MANIFEST_NAME = '.package-manifest.json';
const EXPECTED_TOOLS = ['omp_cancel', 'omp_doctor', 'omp_followup', 'omp_result', 'omp_start', 'omp_status'];
const LICENSE_FILES = ['openai-codex-plugin-cc-LICENSE.txt', 'openai-codex-plugin-cc-NOTICE.txt', 'codex-delegate-mcp-LICENSE.txt', 'SHA256SUMS.txt'];

function fail(message) {
  throw new Error('[check-package] ' + message);
}

async function regularFile(file, label = file) {
  let info;
  try { info = await lstat(file); }
  catch (error) { fail(label + ' is unavailable: ' + error.message); }
  if (!info.isFile() || info.isSymbolicLink()) fail(label + ' must be a regular file');
}

async function realDirectory(directory, label = directory) {
  let info;
  try { info = await lstat(directory); }
  catch (error) { fail(label + ' is unavailable: ' + error.message); }
  if (!info.isDirectory() || info.isSymbolicLink()) fail(label + ' must be a real directory');
}

async function readJson(file, label = file) {
  await regularFile(file, label);
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { fail(label + ' is invalid JSON: ' + error.message); }
}

async function exists(file) {
  try { await lstat(file); return true; }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

/**
 * Compare the direct source files with generated runtime files. Keeping this
 * helper exported makes the stale-source boundary testable without a build.
 * @param {string} sourceDir
 * @param {string} runtimeDir
 */
export async function assertSourceParity(sourceDir = SOURCE, runtimeDir = RUNTIME) {
  await realDirectory(sourceDir, 'source directory');
  await realDirectory(runtimeDir, 'generated runtime');
  const sourceEntries = (await readdir(sourceDir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  const runtimeEntries = (await readdir(runtimeDir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  const sourceFiles = [];
  for (const entry of sourceEntries) {
    if (entry.isSymbolicLink() || !entry.isFile()) fail('source contains a non-regular entry: ' + entry.name);
    if (!entry.name.endsWith('.js')) fail('source contains a non-JavaScript entry: ' + entry.name);
    sourceFiles.push(entry.name);
  }
  const runtimeSourceFiles = runtimeEntries.filter((entry) => entry.isFile() && entry.name.endsWith('.js')).map((entry) => entry.name);
  if (JSON.stringify(sourceFiles) !== JSON.stringify(runtimeSourceFiles)) {
    fail('generated runtime source set is stale (source=' + JSON.stringify(sourceFiles) + ', runtime=' + JSON.stringify(runtimeSourceFiles) + ')');
  }
  for (const name of sourceFiles) {
    await regularFile(path.join(sourceDir, name), 'source ' + name);
    await regularFile(path.join(runtimeDir, name), 'runtime ' + name);
    const sourceBytes = await readFile(path.join(sourceDir, name));
    const runtimeBytes = await readFile(path.join(runtimeDir, name));
    if (Buffer.compare(sourceBytes, runtimeBytes) !== 0) fail('generated runtime source differs from src/' + name);
  }
  return sourceFiles;
}

async function assertManifest(sourceFiles) {
  const manifest = await readJson(path.join(RUNTIME, MANIFEST_NAME), 'runtime manifest');
  if (manifest.marker !== 'claude-omp-delegate-runtime' || manifest.version !== 1 || manifest.productionOnly !== true || manifest.credentialsIncluded !== false) {
    fail('runtime manifest does not identify a production-only generated runtime');
  }
  if (JSON.stringify(manifest.sourceFiles) !== JSON.stringify(sourceFiles)) fail('runtime manifest sourceFiles do not match src');
  const expectedOutputs = [...sourceFiles, 'package.json', 'package-lock.json', 'node_modules', 'licenses', 'THIRD_PARTY_NOTICES.md', MANIFEST_NAME].sort();
  if (JSON.stringify([...manifest.outputs].sort()) !== JSON.stringify(expectedOutputs)) fail('runtime manifest outputs are incomplete or unexpected');
  if (JSON.stringify(manifest.licenseFiles) !== JSON.stringify(['openai-codex-plugin-cc-LICENSE.txt', 'openai-codex-plugin-cc-NOTICE.txt', 'codex-delegate-mcp-LICENSE.txt', 'SHA256SUMS.txt'])) fail('runtime manifest license inventory is incomplete');
  return manifest;
}

async function assertProductionDependencies() {
  const rootPackage = await readJson(path.join(ROOT, 'package.json'), 'root package.json');
  const runtimePackage = await readJson(path.join(RUNTIME, 'package.json'), 'runtime package.json');
  if (JSON.stringify(runtimePackage.dependencies) !== JSON.stringify(rootPackage.dependencies)) fail('runtime production dependencies differ from root package.json');
  const rootLock = await readFile(path.join(ROOT, 'package-lock.json'));
  const runtimeLock = await readFile(path.join(RUNTIME, 'package-lock.json'));
  if (Buffer.compare(rootLock, runtimeLock) !== 0) fail('runtime package-lock.json differs from root lockfile');
  for (const dependency of ['@modelcontextprotocol/sdk', 'zod']) await regularFile(path.join(RUNTIME, 'node_modules', ...dependency.split('/'), 'package.json'), 'runtime dependency ' + dependency);
  for (const developmentOnly of ['typescript', '@types/node']) {
    if (await exists(path.join(RUNTIME, 'node_modules', ...developmentOnly.split('/')))) fail('development dependency was copied into runtime node_modules: ' + developmentOnly);
  }
  for (const name of LICENSE_FILES) await regularFile(path.join(RUNTIME, 'licenses', name), 'runtime license ' + name);
  const sourceLicenseDir = path.join(ROOT, 'licenses');
  for (const name of LICENSE_FILES) {
    const sourcePath = path.join(sourceLicenseDir, name);
    const runtimePath = path.join(RUNTIME, 'licenses', name);
    if (Buffer.compare(await readFile(sourcePath), await readFile(runtimePath)) !== 0) fail('runtime license differs from canonical licenses/' + name);
  }
  const checksum = await readFile(path.join(RUNTIME, 'licenses', 'SHA256SUMS.txt'), 'utf8');
  for (const line of checksum.trim().split(/\r?\n/)) {
    const match = /^([0-9a-f]{64}) {2}([^\s]+)$/.exec(line);
    if (!match) fail('runtime license checksum file is invalid');
    const actual = crypto.createHash('sha256').update(await readFile(path.join(RUNTIME, 'licenses', match[2]))).digest('hex');
    if (actual !== match[1]) fail('runtime license checksum mismatch: ' + match[2]);
  }
}

async function runIsolatedMcp(runtimeDir) {
  const isolated = await mkdtemp(path.join(os.tmpdir(), 'claude-omp-package-check-'));
  const home = path.join(isolated, 'home');
  const state = path.join(isolated, 'state');
  await cp(runtimeDir, isolated, { recursive: true, force: true });
  const stderr = [];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(isolated, 'server.js')],
    cwd: isolated,
    env: { PATH: process.env.PATH ?? '', HOME: home, OMP_DELEGATE_DEPTH: '0', OMP_DELEGATE_STATE_DIR: state },
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (chunk) => stderr.push(String(chunk)));
  const client = new Client({ name: 'claude-omp-package-check', version: '1.0.0' });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const tools = listed.tools.map((tool) => tool.name).sort();
    if (JSON.stringify(tools) !== JSON.stringify(EXPECTED_TOOLS)) fail('isolated packaged MCP tools differ: ' + JSON.stringify(tools));
    return { initialized: true, tools };
  } catch (error) {
    const diagnostic = stderr.join('').trim();
    fail('isolated packaged MCP initialize/tools/list failed: ' + (error?.message ?? String(error)) + (diagnostic ? ' (' + diagnostic.slice(-2000) + ')' : ''));
  } finally {
    await client.close().catch(() => {});
    await rm(isolated, { recursive: true, force: true });
  }
}

/** @param {string} [root] */
export async function checkPackageAt(root = ROOT) {
  if (root !== ROOT) fail('checkPackageAt currently supports the project root only');
  const sourceFiles = await assertSourceParity();
  const manifest = await assertManifest(sourceFiles);
  await assertProductionDependencies();
  const mcp = await runIsolatedMcp(RUNTIME);
  return { sourceFiles, productionDependencies: true, mcp, manifestVersion: manifest.version };
}

async function main() {
  console.log(JSON.stringify(await checkPackageAt(), null, 2));
}

const filename = fileURLToPath(import.meta.url);
let isMain = false;
if (process.argv[1]) {
  try { isMain = path.resolve(process.argv[1]) === path.resolve(filename); } catch {}
}
if (isMain) main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
