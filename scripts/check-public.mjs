#!/usr/bin/env node
/**
 * Validate the explicit public publication surface.
 *
 * This intentionally does not walk verify/, state, session, or generated
 * runtime directories. Those paths are private/build outputs and are not part
 * of the publication candidate set. If a git repository exists, tracked files
 * are checked as a second boundary so an accidentally force-added private file
 * cannot pass.
 */
import { lstat, readFile, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REQUIRED_FILES = [
  '.claude-plugin/marketplace.json',
  '.gitignore',
  'LICENSE',
  'README.md',
  'AGENTS.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'THIRD_PARTY_NOTICES.md',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'plugins/omp/.claude-plugin/plugin.json',
  'plugins/omp/.mcp.json',
];
const REQUIRED_DIRECTORIES = ['src', 'scripts', 'tests', 'plugins/omp/commands', 'plugins/omp/hooks', 'plugins/omp/scripts', 'docs/public', 'licenses'];
const CANDIDATE_FILES = [...REQUIRED_FILES, '.github/workflows/ci.yml', '.github/workflows/omp-compat.yml'];
const CANDIDATE_DIRECTORIES = ['src', 'scripts', 'tests', 'plugins/omp/commands', 'plugins/omp/hooks', 'plugins/omp/scripts', 'docs/public', 'licenses'];
const PRIVATE_SEGMENTS = new Set(['ver' + 'ify', 'state', 'states', 'session', 'sessions', 'credential', 'credentials', 'secret', 'secrets', 'transcript', 'transcripts']);
const GENERATED_SEGMENTS = new Set(['node_modules', 'runtime', 'dist']);

function fail(message) {
  throw new Error('[check-public] ' + message);
}

async function fileInfo(file) {
  try { return await lstat(file); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

async function regularFile(file, label = file) {
  const info = await fileInfo(file);
  if (!info) fail(label + ' is missing');
  if (!info.isFile() || info.isSymbolicLink()) fail(label + ' must be a regular file');
  return info;
}

function relativeSegments(relative) {
  return relative.split('/').filter(Boolean).map((segment) => segment.toLowerCase());
}

/** @param {string} relative */
export function pathViolations(relative) {
  const normalized = relative.replaceAll('\\', '/');
  const segments = relativeSegments(normalized);
  const findings = [];
  if (segments.some((segment) => PRIVATE_SEGMENTS.has(segment))) findings.push('private state/session/credential/transcript path');
  if (segments.some((segment) => GENERATED_SEGMENTS.has(segment))) findings.push('generated dependency/runtime path');
  if (segments.some((segment) => segment === '.env' || segment.startsWith('.env.') || /\.(?:pem|key|p12|pfx|crt)$/i.test(segment))) findings.push('credential material filename');
  if (segments.some((segment) => /^(?:auth|tokens?|secrets?|credentials?)(?:[._-]|$)/i.test(segment))) findings.push('credential material filename');
  return findings;
}

/**
 * Return only high-confidence leaked material. Field names such as apiKey or
 * OPENAI_API_KEY are allowed; a real token-shaped value is not.
 * @param {string} relative
 * @param {string} text
 */
export function scanText(relative, text) {
  const findings = [];
  for (const finding of pathViolations(relative)) findings.push(relative + ': ' + finding);
  const personalPath = /(?:^|[\s"'(=])(?:file:\/\/)?\/(?:Users|home)\/[A-Za-z0-9._-]+(?:[\/\s"',;)]|$)/m;
  if (personalPath.test(text) || /[A-Za-z]:\\Users\\[A-Za-z0-9._-]+(?:\\|$)/m.test(text)) findings.push(relative + ': personal absolute path');
  const tokenPatterns = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /(?:^|[^A-Za-z0-9])sk-(?:proj-|live_|test_)?[A-Za-z0-9]{20,}/,
    /(?:^|[^A-Za-z0-9])(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}/,
    /(?:^|[^A-Za-z0-9])AKIA[0-9A-Z]{16}(?:[^A-Za-z0-9]|$)/,
    /(?:^|[^A-Za-z0-9])xox[baprs]-[A-Za-z0-9-]{20,}/,
    /(?:^|[^A-Za-z0-9])eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?:[^A-Za-z0-9_-]|$)/,
    /(?:^|[^A-Za-z0-9])Bearer\s+[A-Za-z0-9._~-]{32,}(?:[^A-Za-z0-9._~-]|$)/i,
    /(?:^|[^A-Za-z0-9])https?:\/\/[A-Za-z0-9._-]+:[^\s/@]{8,}@[A-Za-z0-9.-]+/i,
  ];
  if (tokenPatterns.some((pattern) => pattern.test(text))) findings.push(relative + ': token-shaped secret');
  return findings;
}

async function walkDirectory(root, relative = '') {
  const entries = (await readdir(path.join(root, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  const files = [];
  for (const entry of entries) {
    const child = relative ? relative + '/' + entry.name : entry.name;
    const info = await lstat(path.join(root, child));
    if (info.isSymbolicLink()) fail(child + ': symbolic links are not publishable');
    if (info.isDirectory()) files.push(...await walkDirectory(root, child));
    else if (info.isFile()) files.push(child);
    else fail(child + ': unsupported filesystem entry');
  }
  return files;
}

async function candidateFiles(root) {
  const files = [];
  for (const relative of CANDIDATE_FILES) {
    const info = await fileInfo(path.join(root, relative));
    if (info) {
      if (!info.isFile() || info.isSymbolicLink()) fail(relative + ' must be a regular file');
      files.push(relative);
    }
  }
  for (const relative of CANDIDATE_DIRECTORIES) {
    const info = await fileInfo(path.join(root, relative));
    if (!info) fail('publish candidate directory is missing: ' + relative);
    if (!info.isDirectory() || info.isSymbolicLink()) fail(relative + ' must be a real directory');
    files.push(...await walkDirectory(root, relative));
  }
  return [...new Set(files)].sort();
}

async function runGitTracked(root) {
  const gitDirectory = await fileInfo(path.join(root, '.git'));
  if (!gitDirectory) return [];
  return await new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', root, 'ls-files', '-z'], { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let stderr = '';
    child.stdout.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (error) => reject(error));
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error('git ls-files failed: ' + stderr.trim()));
      resolve(Buffer.concat(chunks).toString('utf8').split('\0').filter(Boolean));
    });
  });
}

/** @param {string} root */
export async function checkPublicAt(root = ROOT) {
  const packageJsonPath = path.join(root, 'package.json');
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
  if (packageJson.private !== true) fail('package.json must remain private:true; this project does not publish to npm');
  if (packageJson.license !== 'MIT') fail('package.json must declare the MIT license');
  const repositoryUrl = packageJson.repository?.url;
  if (!['https://github.com/BonhaengLee/claude-omp-delegate.git', 'git+https://github.com/BonhaengLee/claude-omp-delegate.git', 'https://github.com/BonhaengLee/claude-omp-delegate'].includes(repositoryUrl)) fail('package.json repository metadata must point to BonhaengLee/claude-omp-delegate');
  if (packageJson.homepage !== 'https://github.com/BonhaengLee/claude-omp-delegate#readme') fail('package.json homepage metadata is missing or incorrect');
  const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
  if (lock.name !== packageJson.name || lock.version !== packageJson.version || lock.packages?.['']?.name !== packageJson.name || lock.packages?.['']?.version !== packageJson.version) fail('package-lock metadata does not match package.json');
  for (const relative of REQUIRED_FILES) await regularFile(path.join(root, relative), relative);
  const pluginManifest = JSON.parse(await readFile(path.join(root, 'plugins', 'omp', '.claude-plugin', 'plugin.json'), 'utf8'));
  if (pluginManifest.version !== packageJson.version) fail('plugins/omp/.claude-plugin/plugin.json version must equal package.json version');
  for (const relative of REQUIRED_DIRECTORIES) {
    const info = await fileInfo(path.join(root, relative));
    if (!info?.isDirectory() || info.isSymbolicLink()) fail(relative + ' must be a real directory');
  }
  const files = await candidateFiles(root);
  const findings = [];
  for (const relative of files) {
    const text = await readFile(path.join(root, relative), 'utf8');
    findings.push(...scanText(relative, text));
  }
  const tracked = await runGitTracked(root);
  for (const relative of tracked) {
    const forbidden = pathViolations(relative);
    if (forbidden.length) findings.push(relative + ': tracked ' + forbidden.join(', '));
    if (relative === 'docs/implementation-plan.md' || relative === 'plugins/omp/runtime' || relative.startsWith('plugins/omp/runtime/') || relative === 'verify' || relative.startsWith('verify/') || relative === 'node_modules' || relative.startsWith('node_modules/')) findings.push(relative + ': private/generated path is tracked');
  }
  if (findings.length) fail(findings.join('\n'));
  return { files, trackedFilesChecked: tracked.length, privatePathsExcluded: ['verify', 'docs/implementation-plan.md', 'plugins/omp/runtime', 'node_modules'] };
}

async function main() {
  console.log(JSON.stringify(await checkPublicAt(), null, 2));
}

const filename = fileURLToPath(import.meta.url);
let isMain = false;
if (process.argv[1]) {
  try { isMain = path.resolve(process.argv[1]) === path.resolve(filename); } catch {}
}
if (isMain) main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
