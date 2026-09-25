#!/usr/bin/env node
/**
 * Build the Claude plugin's self-contained runtime.
 *
 * The runtime is replaced only when its ownership manifest is valid. Unknown
 * files in an existing runtime are a hard error; this prevents packaging from
 * deleting user files or credentials accidentally.
 */
import { copyFile, chmod, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_ROOT = path.join(ROOT, 'plugins', 'omp');
const RUNTIME = path.join(PLUGIN_ROOT, 'runtime');
const LICENSE_ROOT = path.join(ROOT, 'licenses');
const MANIFEST_NAME = '.package-manifest.json';
const MARKER = 'claude-omp-delegate-runtime';
const MANIFEST_VERSION = 1;
const LICENSE_FILES = Object.freeze([
  'openai-codex-plugin-cc-LICENSE.txt',
  'openai-codex-plugin-cc-NOTICE.txt',
  'codex-delegate-mcp-LICENSE.txt',
]);
const LICENSE_SUMS = 'SHA256SUMS.txt';

function fail(message) {
  throw new Error('[package-plugin] ' + message);
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

function safeRoot(value) {
  if (typeof value !== 'string' || value.length === 0 || path.isAbsolute(value) || value.includes('\\') || value.includes('/') || value.split('/').includes('..') || value.split('/').includes('.')) {
    fail('manifest contains an unsafe generated path: ' + String(value));
  }
  return value;
}

async function readManifest(runtime) {
  const marker = path.join(runtime, MANIFEST_NAME);
  await regularFile(marker, 'runtime ownership manifest');
  let value;
  try { value = JSON.parse(await readFile(marker, 'utf8')); }
  catch (error) { fail('runtime ownership manifest is invalid JSON: ' + error.message); }
  if (!value || typeof value !== 'object' || value.marker !== MARKER || value.version !== MANIFEST_VERSION || !Array.isArray(value.outputs)) {
    fail('runtime ownership manifest is not a recognized generated manifest');
  }
  const outputs = value.outputs.map(safeRoot);
  const allowed = new Set(['package.json', 'package-lock.json', 'node_modules', 'licenses', 'THIRD_PARTY_NOTICES.md', MANIFEST_NAME]);
  if (!outputs.every((output) => allowed.has(output) || /^[A-Za-z0-9._-]+\.js$/.test(output))) fail('runtime ownership manifest has an unrecognized output root');
  if (!outputs.includes(MANIFEST_NAME) || new Set(outputs).size !== outputs.length) fail('runtime ownership manifest has invalid output roots');
  return { ...value, outputs };
}

async function existingRuntimeState() {
  let info;
  try { info = await lstat(RUNTIME); }
  catch (error) {
    if (error?.code === 'ENOENT') return { exists: false };
    fail('runtime path cannot be inspected: ' + error.message);
  }
  if (info.isSymbolicLink() || !info.isDirectory()) fail('runtime path must be a real directory');
  const children = await readdir(RUNTIME);
  if (children.length === 0) return { exists: true, outputs: [] };
  if (!children.includes(MANIFEST_NAME)) fail('existing runtime is not owned by package-plugin; refusing to replace it');
  const manifest = await readManifest(RUNTIME);
  const outputSet = new Set(manifest.outputs);
  for (const child of children) if (!outputSet.has(child)) fail('existing runtime contains an unowned file: ' + child);
  return { exists: true, outputs: manifest.outputs };
}

async function copyRegular(source, target) {
  await regularFile(source, source);
  await copyFile(source, target);
  await chmod(target, 0o644);
}

async function npmCi(cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn('npm', ['ci', '--omit=dev', '--ignore-scripts'], { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
      if (Buffer.byteLength(stderr) > 16 * 1024) stderr = stderr.slice(-16 * 1024);
    });
    child.on('error', (error) => reject(new Error('npm ci could not start: ' + error.message)));
    child.on('close', (code, signal) => {
      if (code === 0) resolve(undefined);
      else reject(new Error('npm ci failed (' + (code === null ? 'signal ' + signal : 'exit ' + code) + '): ' + stderr.trim()));
    });
  });
}

async function verifyLicenseSet() {
  await realDirectory(LICENSE_ROOT, 'canonical licenses directory');
  const sums = new Map();
  let sumText;
  try { sumText = await readFile(path.join(LICENSE_ROOT, LICENSE_SUMS), 'utf8'); }
  catch (error) { fail('canonical license checksum file is unavailable: ' + error.message); }
  for (const line of sumText.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^([0-9a-f]{64}) {2}([^\s]+)$/.exec(line);
    if (!match) fail('canonical license checksum line is invalid');
    sums.set(match[2], match[1]);
  }
  const hashes = {};
  for (const name of LICENSE_FILES) {
    const file = path.join(LICENSE_ROOT, name);
    await regularFile(file, 'canonical license ' + name);
    const bytes = await readFile(file);
    const actual = crypto.createHash('sha256').update(bytes).digest('hex');
    if (sums.get(name) !== actual) fail('canonical license checksum mismatch: ' + name);
    hashes[name] = actual;
  }
  if (sums.size !== LICENSE_FILES.length) fail('canonical license checksum file must list exactly the packaged license texts');
  return hashes;
}

function notices(sourceFiles, hashes) {
  const lines = [
    '# Runtime third-party notices',
    '',
    'This packaged runtime contains project source plus the production dependency closure installed from the pinned root lockfile.',
    'No user configuration, authentication material, transcript, log, or environment dump is packaged.',
    '',
    '## Runtime source inventory',
    '',
    ...sourceFiles.map((file) => '- ' + file + ' (project runtime source).'),
    '',
    '## Adapted upstream process boundary',
    '',
    '- runner.js adapts the process and stream boundary from Andrei Lungeanu at commit 0ab0c42c4fdbc3fca2cf923bb8b23fefdd056e0c; see licenses/codex-delegate-mcp-LICENSE.txt.',
    '- OpenAI codex-plugin-cc at commit db52e28f4d9ded852ab3942cea316258ae4ef346 was consulted for manifest and hook conventions; its complete Apache license and notice are included under licenses/.',
    '- Canonical license texts are copied from licenses/ and checked against licenses/SHA256SUMS.txt before packaging.',
    '',
    '## License checksums',
    '',
    ...Object.entries(hashes).map(([name, hash]) => '- ' + hash + '  ' + name),
    '',
  ];
  return lines.join('\n');
}

async function buildStage(sourceFiles, packageJson, hashes) {
  const stage = path.join(PLUGIN_ROOT, '.runtime-stage-' + crypto.randomUUID());
  await mkdir(stage, { recursive: true, mode: 0o755 });
  try {
    for (const source of sourceFiles) await copyRegular(path.join(ROOT, 'src', source), path.join(stage, source));
    await copyRegular(path.join(ROOT, 'package.json'), path.join(stage, 'package.json'));
    await copyRegular(path.join(ROOT, 'package-lock.json'), path.join(stage, 'package-lock.json'));
    const licenses = path.join(stage, 'licenses');
    await mkdir(licenses, { mode: 0o755 });
    for (const name of LICENSE_FILES) await copyRegular(path.join(LICENSE_ROOT, name), path.join(licenses, name));
    await writeFile(path.join(licenses, LICENSE_SUMS), LICENSE_FILES.map((name) => hashes[name] + '  ' + name).join('\n') + '\n', { encoding: 'utf8', mode: 0o644 });
    await writeFile(path.join(stage, 'THIRD_PARTY_NOTICES.md'), notices(sourceFiles, hashes), { encoding: 'utf8', mode: 0o644 });
    await npmCi(stage);
    const outputs = [...sourceFiles, 'package.json', 'package-lock.json', 'node_modules', 'licenses', 'THIRD_PARTY_NOTICES.md', MANIFEST_NAME];
    const manifest = {
      marker: MARKER,
      version: MANIFEST_VERSION,
      generatedAt: new Date().toISOString(),
      package: packageJson.name,
      sourceFiles,
      licenseFiles: [...LICENSE_FILES, LICENSE_SUMS],
      licenseSha256: hashes,
      outputs,
      install: ['npm', 'ci', '--omit=dev', '--ignore-scripts'],
      productionOnly: true,
      credentialsIncluded: false,
    };
    await writeFile(path.join(stage, MANIFEST_NAME), JSON.stringify(manifest, null, 2) + '\n', { encoding: 'utf8', mode: 0o644 });
    return stage;
  } catch (error) {
    await rm(stage, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function main() {
  await realDirectory(ROOT, 'project root');
  await realDirectory(path.join(ROOT, 'src'), 'source directory');
  await mkdir(PLUGIN_ROOT, { recursive: true, mode: 0o755 });
  await realDirectory(PLUGIN_ROOT, 'plugin directory');
  const packageJsonPath = path.join(ROOT, 'package.json');
  await regularFile(packageJsonPath, 'root package.json');
  let packageJson;
  try { packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')); }
  catch (error) { fail('root package.json is invalid JSON: ' + error.message); }
  if (!packageJson || typeof packageJson.name !== 'string' || !packageJson.dependencies || typeof packageJson.dependencies !== 'object') fail('root package.json lacks production dependency metadata');
  await regularFile(path.join(ROOT, 'package-lock.json'), 'root package-lock.json');
  const hashes = await verifyLicenseSet();
  const sourceEntries = await readdir(path.join(ROOT, 'src'));
  const sourceFiles = [];
  for (const source of sourceEntries.sort()) {
    const file = path.join(ROOT, 'src', source);
    const info = await lstat(file);
    if (info.isSymbolicLink() || !info.isFile()) fail('src must contain only regular source files: ' + source);
    if (!source.endsWith('.js')) fail('src contains a non-JavaScript file that cannot be packaged: ' + source);
    sourceFiles.push(source);
  }
  if (!sourceFiles.includes('server.js')) fail('src/server.js is required for the packaged MCP entrypoint');
  if (!sourceFiles.includes('cli.js')) fail('src/cli.js is required for the packaged waiter entrypoint');
  const previous = await existingRuntimeState();
  const stage = await buildStage(sourceFiles, packageJson, hashes);
  try {
    if (previous.exists) await rm(RUNTIME, { recursive: true, force: false });
    await rename(stage, RUNTIME);
  } catch (error) {
    await rm(stage, { recursive: true, force: true }).catch(() => {});
    throw new Error('could not replace generated runtime: ' + error.message);
  }
  console.log(JSON.stringify({ plugin: 'omp', runtime: path.relative(ROOT, RUNTIME), sourceFiles, productionInstall: true, licenseTexts: LICENSE_FILES.length, checksums: true }, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
