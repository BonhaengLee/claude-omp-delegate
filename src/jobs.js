// @ts-check
/** Durable, profile-independent OMP job state and worker coordination. */
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, chmod, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DelegateError, LIMITS, SUPPORTED_OMP_VERSION, TERMINAL, briefSchema, parseBriefOptions, jobIdSchema, jobSchema, resolveModel, workspaceSchema } from './contracts.js';
import { validateSession } from './runner.js';

const MODE_DIR = 0o700;
const MODE_FILE = 0o600;
const VERSION = 1;
const CONFIG_FILE = 'config.json';
const LOCK_FILE = 'lock.json';
const CANCEL_FILE = 'cancel.json';
const MUTATION_DIR = 'mutation.lock';
const READY_FILE = 'ready.json';
const BASELINE_FILE = 'baseline.json';
const RESULT_FILE = 'result.json';
const EVENTS_FILE = 'events.jsonl';
const STDERR_FILE = 'stderr.log';
const WORKER_FILE = fileURLToPath(new URL('./worker.js', import.meta.url));

/** @param {string} code @param {string} message @param {unknown} [details] */
function failure(code, message, details) { return new DelegateError(/** @type {any} */ (code), message, details); }
/** @param {unknown} value @param {string} message */
function assertObject(value, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('STATE_CORRUPT', message);
  return /** @type {Record<string, unknown>} */ (value);
}
/** @param {string} target */
function requireAbsolute(target) {
  if (!workspaceSchema.safeParse(target).success) throw failure('INVALID_INPUT', 'workspace must be an absolute path');
}
/** @param {string} target @param {boolean} [create] */
async function secureDirectory(target, create = true) {
  requireAbsolute(target);
  const resolved = path.resolve(target);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const component of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    let info;
    let created = false;
    try { info = await lstat(current); }
    catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT' || !create) throw failure('STATE_CORRUPT', 'State path is unavailable: ' + current, error);
      try { await mkdir(current, { mode: MODE_DIR }); created = true; }
      catch (mkdirError) { if (/** @type {NodeJS.ErrnoException} */ (mkdirError).code !== 'EEXIST') throw failure('STATE_CORRUPT', 'Cannot create state directory: ' + current, mkdirError); }
      try { info = await lstat(current); } catch (raceError) { throw failure('STATE_CORRUPT', 'State directory disappeared: ' + current, raceError); }
    }
    if (info.isSymbolicLink() || !info.isDirectory()) throw failure('STATE_CORRUPT', 'State path component must be a real directory: ' + current);
    if (created || current === resolved) { try { await chmod(current, MODE_DIR); } catch (error) { throw failure('STATE_CORRUPT', 'Cannot secure state directory: ' + current, error); } }
  }
  return resolved;
}
/** @param {unknown} value @param {string} target */
function parseLockOwner(value, target) {
  const object = assertObject(value, 'Invalid workspace lock: ' + target);
  const allowed = ['version', 'nonce', 'jobId', 'lockKey', 'pid', 'createdAt', 'updatedAt'];
  if (object.version !== VERSION || typeof object.nonce !== 'string' || !jobIdSchema.safeParse(object.nonce).success || typeof object.jobId !== 'string' || !jobIdSchema.safeParse(object.jobId).success || typeof object.lockKey !== 'string' || !workspaceSchema.safeParse(object.lockKey).success || typeof object.pid !== 'number' || !Number.isInteger(object.pid) || object.pid <= 0 || typeof object.createdAt !== 'string' || Object.keys(object).some((key) => !allowed.includes(key))) throw failure('STATE_CORRUPT', 'Workspace lock schema mismatch: ' + target);
  return object;
}
/** @param {string} target */
async function secureExistingFile(target) {
  requireAbsolute(target);
  let info;
  try { info = await lstat(target); } catch (error) { throw failure('STATE_CORRUPT', 'State file is unavailable: ' + target, error); }
  if (info.isSymbolicLink() || !info.isFile()) throw failure('STATE_CORRUPT', 'State file must be regular: ' + target);
  try { await chmod(target, MODE_FILE); } catch (error) { throw failure('STATE_CORRUPT', 'Cannot secure state file: ' + target, error); }
  return target;
}
/** @param {string} target */
async function assertSecurePath(target) {
  requireAbsolute(target);
  const resolved = path.resolve(target);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const component of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    let info;
    try { info = await lstat(current); } catch (error) { throw failure('STATE_CORRUPT', 'State path is unavailable: ' + current, error); }
    if (info.isSymbolicLink()) throw failure('STATE_CORRUPT', 'Symlink in state path is rejected: ' + current);
  }
  return resolved;
}
/** @param {string} target @param {unknown} value */
async function writeJsonAtomic(target, value) {
  const parent = path.dirname(target);
  await secureDirectory(parent);
  try {
    const existing = await lstat(target);
    if (existing.isSymbolicLink()) throw failure('STATE_CORRUPT', 'Refusing to replace symlink: ' + target);
    if (!existing.isFile()) throw failure('STATE_CORRUPT', 'Refusing to replace non-file: ' + target);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT' && !(error instanceof DelegateError)) throw error;
    if (error instanceof DelegateError) throw error;
  }
  const temporary = path.join(parent, '.' + path.basename(target) + '.' + crypto.randomUUID() + '.tmp');
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: MODE_FILE, flag: 'wx' });
    await chmod(temporary, MODE_FILE);
    await rename(temporary, target);
    await chmod(target, MODE_FILE);
  } catch (error) { await removeOwn(temporary).catch(() => {}); throw failure('STATE_CORRUPT', 'Atomic state write failed: ' + target, error); }
}
/** @param {string} target @param {string} value */
async function writeTextAtomic(target, value) {
  const parent = path.dirname(target);
  await secureDirectory(parent);
  try {
    const existing = await lstat(target);
    if (existing.isSymbolicLink()) throw failure('STATE_CORRUPT', 'Refusing to replace symlink: ' + target);
    if (!existing.isFile()) throw failure('STATE_CORRUPT', 'Refusing to replace non-file: ' + target);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT' && !(error instanceof DelegateError)) throw error;
    if (error instanceof DelegateError) throw error;
  }
  const temporary = path.join(parent, '.' + path.basename(target) + '.' + crypto.randomUUID() + '.tmp');
  try {
    await writeFile(temporary, value, { encoding: 'utf8', mode: MODE_FILE, flag: 'wx' });
    await chmod(temporary, MODE_FILE);
    await rename(temporary, target);
    await chmod(target, MODE_FILE);
  } catch (error) { await removeOwn(temporary).catch(() => {}); throw failure('STATE_CORRUPT', 'Atomic state write failed: ' + target, error); }
}
/** @param {string} target Remove only a path that this module just renamed or created. */
async function removeOwn(target) { await rm(target, { recursive: true, force: true }); }
/** @param {string} target */
async function readJson(target) {
  await secureExistingFile(target);
  try { return JSON.parse(await readFile(target, 'utf8')); }
  catch (error) { throw failure('STATE_CORRUPT', 'Invalid JSON state: ' + target, error); }
}
/** @param {string} target @param {import('zod').ZodTypeAny} schema */
async function readSchemaJson(target, schema) {
  const value = await readJson(target);
  const result = schema.safeParse(value);
  if (!result.success) throw failure('STATE_CORRUPT', 'State schema mismatch: ' + target, result.error.issues);
  return result.data;
}
const PRIVATE_EVENT_FIELDS = new Set(['credentialid', 'providercredentialid', 'thinkingsignature', 'encryptedthinking', 'encryptedthinkingcontent', 'encryptedthinkingsignature', 'encryptedreasoning', 'reasoningsignature']);
/** @param {string} key */
function privateEventField(key) { const normalized = key.toLowerCase().replace(/[_-]/g, ''); return PRIVATE_EVENT_FIELDS.has(normalized) || (/^(?:encrypted|ciphertext).*(?:thinking|reasoning)/i.test(key)) || (/(?:thinking|reasoning).*(?:encrypted|ciphertext)$/i.test(key)); }
/** @param {unknown} value @returns {unknown} */
function sanitizeDelegateValue(value) {
  if (Array.isArray(value)) return value.filter((item) => !(item && typeof item === 'object' && ['reasoning', 'thinking', 'reasoning_block', 'encrypted_thinking'].includes(String(item.type ?? '').toLowerCase()))).map((item) => sanitizeDelegateValue(item));
  if (!value || typeof value !== 'object') return value;
  /** @type {Record<string, unknown>} */ const output = {};
  for (const [key, item] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[_-]/g, '');
    if (privateEventField(key) || normalized === 'reasoningcontent' || normalized === 'encryptedreasoningcontent') continue;
    output[key] = sanitizeDelegateValue(item);
  }
  return output;
}
/** @param {unknown} event */
export function sanitizeDelegateEvent(event) { return sanitizeDelegateValue(event); }
/** @param {string} target @param {string[]} lines */
async function appendLines(target, lines) {
  if (lines.length === 0) return;
  const parent = path.dirname(target);
  await secureDirectory(parent);
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink() || !info.isFile()) throw failure('STATE_CORRUPT', 'Log must be a regular file: ' + target);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT' || error instanceof DelegateError) throw error;
  }
  const payload = Buffer.from(lines.map((line) => line.endsWith('\n') ? line : line + '\n').join(''), 'utf8');
  let handle;
  try {
    handle = await open(target, 'a', MODE_FILE);
    let offset = 0;
    while (offset < payload.length) {
      const result = await handle.write(payload, offset, payload.length - offset, null);
      if (result.bytesWritten <= 0) throw new Error('append made no progress');
      offset += result.bytesWritten;
    }
  } catch (error) { throw failure('STATE_CORRUPT', 'Cannot append log: ' + target, error); }
  finally { if (handle) await handle.close(); }
  await chmod(target, MODE_FILE);
}
/** @param {string|Buffer} value */
function hash(value) { return createHash('sha256').update(value).digest('hex'); }
/** @param {string} workspace */
async function resolveWorkspace(workspace) {
  requireAbsolute(workspace);
  let resolved;
  try { resolved = await realpath(workspace); } catch (error) { throw failure('INVALID_INPUT', 'workspace does not exist: ' + workspace, error); }
  let info;
  try { info = await lstat(resolved); } catch (error) { throw failure('INVALID_INPUT', 'workspace is unavailable: ' + resolved, error); }
  if (!info.isDirectory()) throw failure('INVALID_INPUT', 'workspace must be a directory: ' + resolved);
  return resolved;
}
/** @param {string} cwd @param {string} executable @param {string[]} args @param {NodeJS.ProcessEnv} [env] */
async function command(cwd, executable, args, env = process.env) {
  return await new Promise((resolve) => {
    let child;
    try { child = spawn(executable, args, { cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { resolve({ code: null, stdout: '', stderr: String(error) }); return; }
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += String(chunk); if (stdout.length > 1024 * 1024) stdout = stdout.slice(-1024 * 1024); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); if (stderr.length > 64 * 1024) stderr = stderr.slice(-64 * 1024); });
    child.on('error', (error) => resolve({ code: null, stdout, stderr: String(error) }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
/** @param {string} workspace */
async function findGitRoot(workspace) {
  const result = await command(workspace, 'git', ['-C', workspace, 'rev-parse', '--show-toplevel']);
  if (result.code !== 0 || !result.stdout.trim()) return workspace;
  try { return await realpath(result.stdout.trim().split(/\r?\n/)[0]); } catch { return workspace; }
}
/** @param {string} [root] */
async function stateRoot(root = process.env.OMP_DELEGATE_STATE_DIR) {
  const configured = root ?? path.join(os.homedir(), '.local', 'state', 'claude-omp-delegate');
  requireAbsolute(configured);
  return await secureDirectory(path.resolve(configured));
}
/** @param {string} workspace @param {string} [root] */
async function layoutForWorkspace(workspace, root) {
  const state = await stateRoot(root);
  const lockKey = await findGitRoot(workspace);
  const workspaceHash = hash(workspace); const lockHash = hash(lockKey);
  const workspaces = await secureDirectory(path.join(state, 'workspaces'));
  const workspaceRoot = await secureDirectory(path.join(workspaces, workspaceHash));
  const jobsRoot = await secureDirectory(path.join(workspaceRoot, 'jobs'));
  const locksRoot = await secureDirectory(path.join(state, 'locks'));
  return { stateRoot: state, workspace, lockKey, workspaceHash, lockHash, workspaceRoot, jobsRoot, locksRoot, lockDir: path.join(locksRoot, lockHash), configPath: path.join(state, CONFIG_FILE) };
}
/** @param {string} workspace */
async function makeLayout(workspace) { return await layoutForWorkspace(await resolveWorkspace(workspace)); }
/** @param {string} executable */
async function executableVersion(executable) {
  const result = await command(path.dirname(executable), executable, ['--version']);
  if (result.code === null) throw failure('OMP_NOT_FOUND', 'Cannot execute OMP: ' + executable, result.stderr);
  if (result.code !== 0) throw failure('VERSION_UNSUPPORTED', 'OMP --version failed with exit ' + result.code, result.stderr);
  const match = result.stdout.match(/omp[\/ ](?:v)?([0-9]+\.[0-9]+\.[0-9]+)/i);
  if (!match || match[1] !== SUPPORTED_OMP_VERSION) throw failure('VERSION_UNSUPPORTED', 'Expected OMP ' + SUPPORTED_OMP_VERSION + ', got: ' + result.stdout.trim());
  return match[1];
}
/** @param {unknown} value @param {string} target */
function parseConfig(value, target) {
  const object = assertObject(value, 'Invalid config object: ' + target);
  if (object.version !== VERSION || typeof object.executable !== 'string' || !path.isAbsolute(object.executable) || Object.keys(object).some((key) => !['version', 'executable'].includes(key))) throw failure('STATE_CORRUPT', 'Config schema mismatch: ' + target);
  return { version: VERSION, executable: object.executable };
}
/** @param {string} target */
async function readConfig(target) {
  try { return parseConfig(await readJson(target), target); }
  catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT' || (error instanceof DelegateError && /** @type {NodeJS.ErrnoException|undefined} */ (error.details)?.code === 'ENOENT')) return undefined;
    throw error;
  }
}
/** @param {string} workspace */
async function discoverExecutable(workspace) {
  const state = await stateRoot(); const configPath = path.join(state, CONFIG_FILE); const configured = await readConfig(configPath);
  let executable = configured?.executable;
  if (!executable) {
    const candidates = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, 'omp'));
    for (const candidate of candidates) {
      try { await access(candidate, fsConstants.X_OK); executable = await realpath(candidate); const info = await lstat(executable); if (!info.isFile()) executable = undefined; if (executable) break; }
      catch { executable = undefined; }
    }
    if (!executable) throw failure('OMP_NOT_FOUND', 'No executable named omp was found on PATH');
    await executableVersion(executable); await writeJsonAtomic(configPath, { version: VERSION, executable });
  } else {
    try { executable = await realpath(executable); const info = await lstat(executable); if (!info.isFile()) throw new Error('not a file'); await access(executable, fsConstants.X_OK); }
    catch (error) { throw failure('OMP_NOT_FOUND', 'Configured executable is unavailable: ' + (configured?.executable ?? ''), error); }
    await executableVersion(executable);
  }
  return { executable, version: SUPPORTED_OMP_VERSION, configPath };
}
/** @param {string} workspace @param {string} executable @param {string} selector @param {string|undefined} thinking */
async function resolveJobModel(workspace, executable, selector, thinking) {
  const result = await command(workspace, executable, ['config', 'get', 'modelRoles', '--json'], { ...process.env, OMP_DELEGATE_DEPTH: '1' });
  if (result.code !== 0) throw failure('MODEL_NOT_CODEX', 'OMP modelRoles lookup failed with exit ' + result.code, result.stderr);
  let parsed;
  try { parsed = JSON.parse(result.stdout); } catch (error) { throw failure('MODEL_NOT_CODEX', 'OMP modelRoles output was not JSON', error); }
  const object = assertObject(parsed, 'Invalid modelRoles response'); const roles = assertObject(object.value ?? object, 'modelRoles response has no value');
  /** @type {Record<string,string>} */ const strings = {};
  for (const [key, value] of Object.entries(roles)) { if (typeof value !== 'string') throw failure('MODEL_NOT_CODEX', 'Model role is not a string: ' + key); strings[key] = value; }
  try { return resolveModel(strings, selector || '@default', /** @type {any} */ (thinking)); }
  catch (error) { if (error instanceof DelegateError) throw error; throw failure('MODEL_NOT_CODEX', 'Cannot resolve OMP model role', error); }
}
/** @param {string} workspace @returns {Promise<Record<string,string>>} */
async function walkWorkspace(workspace) {
  /** @type {Record<string,string>} */ const files = {};
  /** @param {string} directory */
  async function walk(directory) {
    /** @type {import('node:fs').Dirent[]} */ let entries; try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name === '.git') continue;
      const absolute = path.join(directory, entry.name); const relative = path.relative(workspace, absolute);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) { try { files[relative] = hash(await readFile(absolute)); } catch { files[relative] = 'unreadable'; } }
      else if (entry.isSymbolicLink()) files[relative] = 'symlink';
    }
  }
  await walk(workspace); return files;
}
/** @param {string} workspace */
async function snapshotWorkspace(workspace) {
  const status = await command(workspace, 'git', ['-C', workspace, 'status', '--porcelain=v1', '-z']);
  if (status.code === 0) {
    const diff = await command(workspace, 'git', ['-C', workspace, 'diff', '--no-ext-diff', '--binary']); const tracked = await command(workspace, 'git', ['-C', workspace, 'ls-files', '-s']);
    const names = status.stdout.split('\0').filter(Boolean).map((/** @type {string} */ entry) => { const value = entry.slice(3); const rename = value.lastIndexOf(' -> '); return rename >= 0 ? value.slice(rename + 4) : value; });
    const fileHashes = await walkWorkspace(workspace);
    return { kind: 'git', capturedAt: new Date().toISOString(), status: status.stdout, diff: diff.stdout, hash: hash(status.stdout + '\0' + diff.stdout + '\0' + tracked.stdout), files: names, fileHashes };
  }
  const fileHashes = await walkWorkspace(workspace); return { kind: 'filesystem', capturedAt: new Date().toISOString(), status: '', diff: '', hash: hash(Object.entries(fileHashes).map(([file, value]) => file + ':' + value).join('\n')), files: Object.keys(fileHashes), fileHashes };
}
/** @param {string} workspace @param {string[]} scopes @param {string[]} changed */
function outsideScopes(workspace, scopes, changed) {
  const roots = scopes.map((scope) => path.resolve(workspace, scope));
  return changed.filter((file) => { const absolute = path.resolve(workspace, file); return !roots.some((root) => { const relative = path.relative(root, absolute); return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)); }); });
}
/** @param {string} lockFile */
async function waitForLockOwner(lockFile) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { return parseLockOwner(await readJson(lockFile), lockFile); }
    catch (error) {
      const noent = /** @type {NodeJS.ErrnoException|undefined} */ (error)?.code === 'ENOENT' || (error instanceof DelegateError && /** @type {NodeJS.ErrnoException|undefined} */ (error.details)?.code === 'ENOENT');
      if (!noent) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw failure('WORKSPACE_BUSY', 'Workspace lock is being initialized by another client', { lockFile });
}
/** @param {string} workspace @param {string} nonce @param {string} jobId @param {string} lockKey */
async function acquireLock(workspace, nonce, jobId, lockKey) {
  const layout = await layoutForWorkspace(workspace);
  try { await mkdir(layout.lockDir, { mode: MODE_DIR }); await chmod(layout.lockDir, MODE_DIR); }
  catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'EEXIST') { const lockFile = path.join(layout.lockDir, LOCK_FILE); const owner = await waitForLockOwner(lockFile); throw failure('WORKSPACE_BUSY', 'Workspace already has an active OMP job', owner); }
    throw failure('STATE_CORRUPT', 'Cannot acquire workspace lock', error);
  }
  try {
    const metadata = { version: VERSION, nonce, jobId, lockKey, pid: process.pid, createdAt: new Date().toISOString() };
    await writeJsonAtomic(path.join(layout.lockDir, LOCK_FILE), metadata);
  } catch (error) { throw error; }
  return layout;
}
/** @param {string} workspace @param {string} lockKey @param {string} nonce */
async function releaseLock(workspace, lockKey, nonce) {
  const resolvedWorkspace = await resolveWorkspace(workspace); const layout = await layoutForWorkspace(resolvedWorkspace); if (layout.lockKey !== lockKey) throw failure('STATE_CORRUPT', 'Persisted lock key does not match the current workspace root');
  const lockDir = path.join(layout.locksRoot, layout.lockHash); const lockFile = path.join(lockDir, LOCK_FILE);
  let owner;
  try { owner = parseLockOwner(await readJson(lockFile), lockFile); }
  catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT' || (error instanceof DelegateError && /** @type {NodeJS.ErrnoException|undefined} */ (error.details)?.code === 'ENOENT')) return false; throw error; }
  if (owner.nonce !== nonce || owner.lockKey !== lockKey) return false;
  await assertSecurePath(lockDir);
  try {
    const tombstone = lockDir + '.released.' + crypto.randomUUID();
    await rename(lockDir, tombstone);
    await removeOwn(tombstone);
    return true;
  }
  catch (error) { throw failure('STATE_CORRUPT', 'Cannot release workspace lock', error); }
}
/** @param {string} jobDir */
async function readJobFromDir(jobDir) {
  const resolved = await assertSecurePath(jobDir); const info = await lstat(resolved); if (!info.isDirectory()) throw failure('STATE_CORRUPT', 'Job path is not a directory: ' + resolved);
  const job = await readSchemaJson(path.join(resolved, 'job.json'), jobSchema); if (path.basename(resolved) !== job.id) throw failure('STATE_CORRUPT', 'Job directory id does not match job.json'); return job;
}
/** @param {import('./contracts.js').Job} job @param {{workspace:string,lockKey:string,jobsRoot:string}} layout @param {string} jobDir */
async function validateJobIdentity(job, layout, jobDir) {
  if (job.workspace !== layout.workspace || job.lockKey !== layout.lockKey || path.resolve(jobDir) !== path.join(layout.jobsRoot, job.id)) throw failure('STATE_CORRUPT', 'Persisted job identity does not match its workspace layout: ' + job.id);
  const sessionDir = path.resolve(job.sessionDir); const relativeSession = path.relative(layout.jobsRoot, sessionDir);
  if (!relativeSession || relativeSession === '..' || relativeSession.startsWith('..' + path.sep) || path.isAbsolute(relativeSession)) throw failure('STATE_CORRUPT', 'Session directory is outside this workspace state: ' + job.sessionDir);
  await assertSecurePath(sessionDir);
  const sessionReal = await realpath(sessionDir);
  if (job.sessionFile !== undefined) {
    const sessionFile = path.resolve(job.sessionFile); const relativeFile = path.relative(sessionDir, sessionFile);
    if (!relativeFile || relativeFile === '..' || relativeFile.startsWith('..' + path.sep) || path.isAbsolute(relativeFile)) throw failure('STATE_CORRUPT', 'Session file is outside its session directory: ' + job.sessionFile);
    await secureExistingFile(sessionFile); const fileReal = await realpath(sessionFile); if (path.dirname(fileReal) !== sessionReal) throw failure('STATE_CORRUPT', 'Session file must be directly inside its session directory: ' + job.sessionFile);
  }
}
/** @param {string} jobDir @returns {Promise<import('./contracts.js').Job>} */
async function readValidatedJob(jobDir) { const job = await readJobFromDir(jobDir); const layout = await layoutForWorkspace(job.workspace); await validateJobIdentity(job, layout, jobDir); return job; }
/** @param {string} jobDir @param {string} name */
function pathForJob(jobDir, name) { return path.join(jobDir, name); }
/** @param {string} jobDir @param {string} [nonce] */
async function readCancel(jobDir, nonce) {
  const target = pathForJob(jobDir, CANCEL_FILE);
  try { const object = assertObject(await readJson(target), 'Invalid cancellation intent'); if (object.version !== VERSION || typeof object.requestedAt !== 'string' || typeof object.requesterPid !== 'number' || !Number.isInteger(object.requesterPid) || object.requesterPid <= 0 || typeof object.workerNonce !== 'string') throw failure('STATE_CORRUPT', 'Cancellation intent schema mismatch: ' + target); if (nonce && object.workerNonce !== nonce) throw failure('STATE_CORRUPT', 'Cancellation intent nonce mismatch: ' + target); return true; }
  catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT' || (error instanceof DelegateError && /** @type {NodeJS.ErrnoException|undefined} */ (error.details)?.code === 'ENOENT')) return false; throw error; }
}
/** @param {string} jobDir @param {()=>Promise<unknown>} operation @returns {Promise<unknown>} */
async function withMutationLock(jobDir, operation) {
  const lockDir = pathForJob(jobDir, MUTATION_DIR); const ownerFile = path.join(lockDir, LOCK_FILE); const nonce = crypto.randomUUID(); const deadline = Date.now() + 10000;
  while (true) {
    try { await mkdir(lockDir, { mode: MODE_DIR }); await chmod(lockDir, MODE_DIR); await writeJsonAtomic(ownerFile, { version: VERSION, nonce, pid: process.pid, operation: 'mutation' }); break; }
    catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EEXIST') throw error; if (Date.now() >= deadline) throw failure('STATE_CORRUPT', 'Job mutation lock did not become available: ' + jobDir); await new Promise((resolve) => setTimeout(resolve, 20)); }
  }
  try { return await operation(); }
  finally {
    try { const owner = assertObject(await readJson(ownerFile), 'Invalid mutation lock'); if (owner.nonce === nonce) { const tombstone = lockDir + '.released.' + nonce; await rename(lockDir, tombstone); await removeOwn(tombstone); } }
    catch { /* keep an uncertain mutation lock for fail-closed diagnostics */ }
  }
}
/** @param {string} jobDir */
async function recoverStaleMutationLock(jobDir) {
  const lockDir = pathForJob(jobDir, MUTATION_DIR); const ownerFile = path.join(lockDir, LOCK_FILE); let owner;
  try { owner = assertObject(await readJson(ownerFile), 'Invalid mutation lock'); } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT' || (error instanceof DelegateError && /** @type {NodeJS.ErrnoException|undefined} */ (error.details)?.code === 'ENOENT')) return false;
    return false;
  }
  if (owner.version !== VERSION || typeof owner.nonce !== 'string' || !jobIdSchema.safeParse(owner.nonce).success || owner.operation !== 'mutation' || typeof owner.pid !== 'number' || !Number.isInteger(owner.pid) || owner.pid <= 0) return false;
  const probe = probePid(owner.pid); if (probe.alive || probe.unknown) return false;
  const tombstone = lockDir + '.recovered.' + owner.nonce;
  try { await rename(lockDir, tombstone); } catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return false; throw failure('STATE_CORRUPT', 'Cannot quarantine stale mutation lock', error); }
  await removeOwn(tombstone); return true;
}
/** @param {string} jobDir */
async function initializeJobFiles(jobDir) { await secureDirectory(jobDir); await writeTextAtomic(pathForJob(jobDir, EVENTS_FILE), ''); await writeTextAtomic(pathForJob(jobDir, STDERR_FILE), ''); }
/** @param {string} workspace @param {import('./contracts.js').Brief} brief @param {string} [parentJobId] @param {string} [sessionDir] @param {string} [sessionId] @param {string} [modelOverride] @param {string} [thinkingOverride] */
async function createJob(workspace, brief, parentJobId, sessionDir, sessionId, modelOverride, thinkingOverride) {
  if (process.env.OMP_DELEGATE_DEPTH === '1') throw failure('RECURSION_BLOCKED', 'OMP delegation is already running at depth 1');
  const parsedBrief = briefSchema.safeParse(brief); if (!parsedBrief.success) throw failure('INVALID_INPUT', 'Invalid job brief', parsedBrief.error.issues);
  const layout = await makeLayout(workspace); const executableInfo = await discoverExecutable(layout.workspace);
  const model = await resolveJobModel(layout.workspace, executableInfo.executable, modelOverride ?? parsedBrief.data.model ?? '@default', thinkingOverride ?? parsedBrief.data.thinking);
  const id = crypto.randomUUID(); const nonce = crypto.randomUUID(); const jobDir = path.join(layout.jobsRoot, id); const temporaryDir = path.join(layout.jobsRoot, '.job-' + id + '.tmp'); const actualSessionDir = sessionDir ?? path.join(jobDir, 'sessions'); const temporarySessionDir = sessionDir ?? path.join(temporaryDir, 'sessions');
  const baseline = await snapshotWorkspace(layout.workspace); const now = new Date().toISOString();
  /** @type {import('./contracts.js').Job} */ const job = { version: VERSION, id, workspace: layout.workspace, lockKey: layout.lockKey, status: 'starting', createdAt: now, updatedAt: now, ...(sessionId ? { sessionId } : {}), sessionDir: actualSessionDir, ...(parentJobId ? { parentJobId } : {}), executable: executableInfo.executable, modelRequested: model.model, ompVersion: SUPPORTED_OMP_VERSION, ...(model.thinking ? { thinking: model.thinking } : {}), workerNonce: nonce, warnings: [], activity: 'waiting for detached worker' };
  let lockAcquired = false;
  try {
    await mkdir(temporaryDir, { mode: MODE_DIR }); await chmod(temporaryDir, MODE_DIR); await secureDirectory(temporarySessionDir); await initializeJobFiles(temporaryDir); await writeJsonAtomic(pathForJob(temporaryDir, 'brief.json'), parsedBrief.data); await writeJsonAtomic(pathForJob(temporaryDir, BASELINE_FILE), baseline); await writeJsonAtomic(pathForJob(temporaryDir, 'job.json'), job);
    await acquireLock(layout.workspace, nonce, id, layout.lockKey); lockAcquired = true; await rename(temporaryDir, jobDir);
  } catch (error) {
    await removeOwn(temporaryDir).catch(() => {}); if (lockAcquired) await releaseLock(layout.workspace, layout.lockKey, nonce).catch(() => {}); if (error instanceof DelegateError) throw error; throw failure('STATE_CORRUPT', 'Cannot initialize job state', error);
  }
  return { job, jobDir, executableInfo, brief: parsedBrief.data, baseline, layout };
}
/** @param {string} jobDir @param {string} nonce @param {import('node:child_process').ChildProcess} child */
async function waitReady(jobDir, nonce, child) {
  const target = pathForJob(jobDir, READY_FILE); const deadline = Date.now() + LIMITS.readyMs; const jobId = path.basename(jobDir);
  while (Date.now() < deadline) {
    const current = await readValidatedJob(jobDir);
    try { const value = assertObject(await readJson(target), 'Invalid worker ready marker'); if (value.nonce === nonce && value.jobId === jobId) { const published = await readValidatedJob(jobDir); if (typeof value.pid !== 'number' || value.pid !== child.pid || published.ownerPid !== child.pid || published.status === 'starting') throw failure('WORKER_NOT_READY', 'Worker readiness identity did not match the spawned child for job ' + jobId, { jobId, readyPid: value.pid, childPid: child.pid, ownerPid: published.ownerPid, status: published.status, confirmedDead: false }); return published; } }
    catch (error) { if (error instanceof DelegateError && error.code === 'WORKER_NOT_READY') throw error; if (!(error instanceof DelegateError && /** @type {NodeJS.ErrnoException|undefined} */ (error.details)?.code === 'ENOENT')) throw error; }
    if (TERMINAL.has(current.status)) throw failure('WORKER_NOT_READY', 'Detached worker exited before ready for job ' + jobId + ': ' + (current.error?.message ?? current.status), { jobId, workerAlive: false, status: current.status });
    if (child.exitCode !== null || child.signalCode !== null) {
      const startupError = failure('WORKER_NOT_READY', 'Detached worker exited before readiness for job ' + jobId, { jobId, workerAlive: false, confirmedDead: true });
      try { await terminalizeWorkerFailure(jobDir, nonce, startupError); } catch { /* preserve lock if state cannot be safely committed */ }
      throw startupError;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw failure('WORKER_NOT_READY', 'Detached worker did not become ready within 5 seconds for job ' + jobId, { jobId, workerAlive: child.exitCode === null && child.signalCode === null, confirmedDead: child.exitCode !== null || child.signalCode !== null });
}
/** @param {string} jobDir @param {string} workspace @returns {Promise<import('node:child_process').ChildProcess>} */
async function spawnWorker(jobDir, workspace) {
  return await new Promise((resolve, reject) => {
    let child;
    try { child = spawn(process.execPath, [WORKER_FILE, '--job-dir', jobDir], { cwd: workspace, env: { ...process.env, OMP_DELEGATE_DEPTH: '1' }, detached: true, stdio: 'ignore', shell: false }); }
    catch (error) { reject(failure('WORKER_NOT_READY', 'Cannot spawn detached worker for job ' + path.basename(jobDir), error)); return; }
    const onError = (/** @type {Error} */ error) => { reject(failure('WORKER_NOT_READY', 'Cannot spawn detached worker for job ' + path.basename(jobDir), error)); };
    child.once('error', onError);
    child.once('spawn', () => { child.removeListener('error', onError); child.on('error', () => {}); child.unref(); resolve(child); });
  });
}
/** @param {{workspace:string,brief:import('./contracts.js').Brief}} options */
export async function startJob(options) {
  options = { ...options, brief: parseBriefOptions(options.brief) };
  const created = await createJob(options.workspace, options.brief);
  let child;
  try { child = await spawnWorker(created.jobDir, created.job.workspace); }
  catch (error) { await terminalizeWorkerFailure(created.jobDir, created.job.workerNonce, error).catch(() => {}); throw error; }
  return await waitReady(created.jobDir, created.job.workerNonce, child);
}
/** @param {{workspace:string,jobId?:string,brief:import('./contracts.js').Brief}} options */
export async function followupJob(options) {
  options = { ...options, brief: parseBriefOptions(options.brief) };
  const workspace = await resolveWorkspace(options.workspace); const jobs = await listJobs({ workspace }); /** @type {import('./contracts.js').Job|undefined} */ let parent;
  if (options.jobId !== undefined) { if (!jobIdSchema.safeParse(options.jobId).success) throw failure('INVALID_INPUT', 'jobId must be a UUID'); parent = jobs.find((item) => item.id === options.jobId); if (!parent) throw failure('NOT_FOUND', 'Job not found in workspace: ' + options.jobId); }
  else {
    const grouped = new Map();
    for (const item of jobs) { if (!TERMINAL.has(item.status) || !item.sessionId) continue; const key = item.sessionDir + '\0' + item.sessionId; const list = grouped.get(key) ?? []; list.push(item); grouped.set(key, list); }
    const bySession = new Map();
    const isAncestor = (/** @type {import('./contracts.js').Job} */ ancestor, /** @type {import('./contracts.js').Job} */ descendant) => { let cursor = descendant; const seen = new Set(); while (cursor.parentJobId && !seen.has(cursor.id)) { seen.add(cursor.id); if (cursor.parentJobId === ancestor.id) return true; const next = jobs.find((candidate) => candidate.id === cursor.parentJobId); if (!next) return false; cursor = next; } return false; };
    for (const [key, candidates] of grouped) { let selected = candidates[0]; for (const candidate of candidates.slice(1)) { if (isAncestor(selected, candidate)) selected = candidate; else if (isAncestor(candidate, selected)) continue; else if (candidate.updatedAt > selected.updatedAt || (candidate.updatedAt === selected.updatedAt && (candidate.createdAt > selected.createdAt || (candidate.createdAt === selected.createdAt && candidate.id > selected.id)))) selected = candidate; } bySession.set(key, selected); }
    if (bySession.size === 0) throw failure('NOT_FOUND', 'No resumable OMP session exists for this workspace'); if (bySession.size !== 1) throw failure('AMBIGUOUS_SESSION', 'More than one resumable OMP session exists', [...bySession.values()].map((item) => ({ id: item.id, sessionId: item.sessionId }))); parent = [...bySession.values()][0];
  }
  if (!parent.sessionId) throw failure('RESUME_FAILED', 'Selected job has no persisted OMP session id'); if (!TERMINAL.has(parent.status)) throw failure('WORKSPACE_BUSY', 'Selected job is still active: ' + parent.id);
  try { await validateSession(parent.sessionDir, parent.sessionId, parent.sessionFile); } catch (error) { throw failure('RESUME_FAILED', 'Persisted session cannot be resumed: ' + String(error)); }
  const layout = await layoutForWorkspace(workspace);
  const previousBrief = await readSchemaJson(path.join(layout.jobsRoot, parent.id, 'brief.json'), briefSchema);
  const parsed = briefSchema.safeParse(options.brief); if (!parsed.success) throw failure('INVALID_INPUT', 'Invalid follow-up brief', parsed.error.issues);
  const merged = previousBrief ? { ...parsed.data, decisions: previousBrief.decisions + '\n\nFollow-up: ' + parsed.data.decisions, writeScope: [...new Set([...previousBrief.writeScope, ...parsed.data.writeScope])], acceptance: [...new Set([...previousBrief.acceptance, ...parsed.data.acceptance])], constraints: [...new Set([...previousBrief.constraints, ...parsed.data.constraints])], verification: [...new Set([...previousBrief.verification, ...parsed.data.verification])], model: parsed.data.model ?? parent.modelRequested, thinking: parsed.data.thinking ?? parent.thinking } : parsed.data;
  return await createFollowupJob(workspace, merged, parent);
}
/** @param {string} workspace @param {import('./contracts.js').Brief} brief @param {import('./contracts.js').Job} parent */
async function createFollowupJob(workspace, brief, parent) {
  const layout = await makeLayout(workspace); if (layout.workspace !== parent.workspace || layout.lockKey !== parent.lockKey) throw failure('INVALID_INPUT', 'Parent job belongs to another workspace');
  const executableInfo = await discoverExecutable(layout.workspace); const model = await resolveJobModel(layout.workspace, executableInfo.executable, brief.model ?? parent.modelRequested, brief.thinking ?? parent.thinking);
  const id = crypto.randomUUID(); const nonce = crypto.randomUUID(); const jobDir = path.join(layout.jobsRoot, id); const temporaryDir = path.join(layout.jobsRoot, '.job-' + id + '.tmp'); let spawnedWorker = false; let published = false; let lockAcquired = false;
  try {
    await mkdir(temporaryDir, { mode: MODE_DIR }); await chmod(temporaryDir, MODE_DIR); await initializeJobFiles(temporaryDir); const baseline = await snapshotWorkspace(layout.workspace); const now = new Date().toISOString();
    /** @type {import('./contracts.js').Job} */ const job = { version: VERSION, id, workspace: layout.workspace, lockKey: layout.lockKey, status: 'starting', createdAt: now, updatedAt: now, sessionId: parent.sessionId, sessionDir: parent.sessionDir, sessionFile: parent.sessionFile, ompVersion: SUPPORTED_OMP_VERSION, executable: executableInfo.executable, modelRequested: model.model, ...(model.thinking ? { thinking: model.thinking } : {}), parentJobId: parent.id, workerNonce: nonce, warnings: [], activity: 'waiting for detached worker' };
    await writeJsonAtomic(pathForJob(temporaryDir, 'brief.json'), brief); await writeJsonAtomic(pathForJob(temporaryDir, BASELINE_FILE), baseline); await writeJsonAtomic(pathForJob(temporaryDir, 'job.json'), job); await acquireLock(layout.workspace, nonce, id, layout.lockKey); lockAcquired = true; await rename(temporaryDir, jobDir); published = true;
    const child = await spawnWorker(jobDir, layout.workspace); spawnedWorker = true; return await waitReady(jobDir, nonce, child);
  } catch (error) {
    if (!spawnedWorker) {
      if (published) await terminalizeWorkerFailure(jobDir, nonce, error).catch(() => {});
      else { await removeOwn(temporaryDir).catch(() => {}); if (lockAcquired) await releaseLock(layout.workspace, layout.lockKey, nonce).catch(() => {}); }
    }
    throw error;
  }
}
/** @param {{workspace:string}} options */
export async function listJobs(options) {
  const layout = await makeLayout(options.workspace); let entries;
  try { entries = await readdir(layout.jobsRoot, { withFileTypes: true }); } catch (error) { throw failure('STATE_CORRUPT', 'Cannot list job state', error); }
  /** @type {import('./contracts.js').Job[]} */ const jobs = [];
  for (const entry of entries) { if (entry.isSymbolicLink()) throw failure('STATE_CORRUPT', 'Unexpected symlink in jobs directory: ' + entry.name); if (entry.isDirectory() && entry.name.startsWith('.job-') && entry.name.endsWith('.tmp')) continue; if (!entry.isDirectory()) throw failure('STATE_CORRUPT', 'Unexpected entry in jobs directory: ' + entry.name); const jobDir = path.join(layout.jobsRoot, entry.name); const job = await readJobFromDir(jobDir); await validateJobIdentity(job, layout, jobDir); jobs.push(job); }
  jobs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); return jobs;
}
/** @param {{workspace:string,jobId?:string}} options */
export async function getJob(options) {
  const jobs = await listJobs({ workspace: options.workspace });
  if (options.jobId !== undefined) { if (!jobIdSchema.safeParse(options.jobId).success) throw failure('INVALID_INPUT', 'jobId must be a UUID'); const found = jobs.find((item) => item.id === options.jobId); if (!found) throw failure('NOT_FOUND', 'Job not found in workspace: ' + options.jobId); return found; }
  const found = jobs.find((item) => TERMINAL.has(item.status)); if (!found) throw failure('NOT_FOUND', 'No terminal job exists for this workspace'); return found;
}
/** @param {{workspace:string,jobId?:string}} options */
export async function requestCancel(options) {
  const jobs = await listJobs({ workspace: options.workspace }); const active = jobs.filter((job) => !TERMINAL.has(job.status)); let target;
  if (options.jobId !== undefined) { if (!jobIdSchema.safeParse(options.jobId).success) throw failure('INVALID_INPUT', 'jobId must be a UUID'); target = jobs.find((job) => job.id === options.jobId); if (!target) throw failure('NOT_FOUND', 'Job not found in workspace: ' + options.jobId); if (TERMINAL.has(target.status)) return target; }
  else { if (active.length === 0) return null; if (active.length > 1) throw failure('WORKSPACE_BUSY', 'More than one active job exists for this workspace'); target = active[0]; }
  const jobDir = path.join((await layoutForWorkspace(target.workspace)).jobsRoot, target.id);
  return await withMutationLock(jobDir, async () => { const current = await readValidatedJob(jobDir); if (TERMINAL.has(current.status)) return current; await writeJsonAtomic(pathForJob(jobDir, CANCEL_FILE), { version: VERSION, requestedAt: new Date().toISOString(), requesterPid: process.pid, workerNonce: current.workerNonce }); return current; });
}
/** @param {{workspace:string,jobId:string,timeoutMs?:number}} options */
export async function waitForJob(options) {
  if (!jobIdSchema.safeParse(options.jobId).success) throw failure('INVALID_INPUT', 'jobId must be a UUID'); const deadline = options.timeoutMs === undefined ? Number.POSITIVE_INFINITY : Date.now() + Math.max(0, options.timeoutMs);
  while (true) { const current = await getJob({ workspace: options.workspace, jobId: options.jobId }); if (TERMINAL.has(current.status) || Date.now() >= deadline) return current; await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now())))); }
}
/** @param {number} pid */
function probePid(pid) { try { process.kill(pid, 0); return { alive: true, unknown: false }; } catch (error) { const code = /** @type {NodeJS.ErrnoException} */ (error).code; if (code === 'ESRCH') return { alive: false, unknown: false }; return { alive: false, unknown: true }; } }
/** @param {number} pgid */
function probeGroup(pgid) { try { process.kill(-pgid, 0); return { gone: false, unknown: false }; } catch (error) { const code = /** @type {NodeJS.ErrnoException} */ (error).code; if (code === 'ESRCH') return { gone: true, unknown: false }; return { gone: false, unknown: true }; } }
/** @param {import('./contracts.js').Job} job @returns {Promise<import('./contracts.js').Job>} */
async function recoverJob(job) {
  const recoverableFailure = job.status === 'failed' && job.error?.code === 'CANCEL_UNCONFIRMED';
  if (TERMINAL.has(job.status) && !recoverableFailure) return job;
  const startingUnclaimed = job.status === 'starting' && job.ownerPid === undefined && job.childPgid === undefined && job.heartbeatAt === undefined;
  const state = await stateRoot(); const lockFile = path.join(state, 'locks', hash(job.lockKey), LOCK_FILE); const owner = parseLockOwner(await readJson(lockFile), lockFile);
  if (owner.nonce !== job.workerNonce || owner.jobId !== job.id) throw failure('RECOVERY_UNSAFE', 'Workspace lock owner nonce does not match job');
  const heartbeat = startingUnclaimed ? job.createdAt : job.heartbeatAt;
  if (!heartbeat || Date.now() - Date.parse(heartbeat) < LIMITS.staleMs) throw failure('RECOVERY_UNSAFE', startingUnclaimed ? 'Starting job handoff is not stale' : 'Worker heartbeat is not stale');
  const ownerPid = job.ownerPid ?? (typeof owner.pid === 'number' ? owner.pid : undefined); const ownerProbe = ownerPid === undefined ? { alive: false, unknown: true } : probePid(ownerPid); if (ownerProbe.alive || ownerProbe.unknown) throw failure('RECOVERY_UNSAFE', 'Owner process is alive or cannot be identified');
  if (!startingUnclaimed) {
    if (job.childPgid === undefined) throw failure('RECOVERY_UNSAFE', 'Child process group identity is missing; refusing recovery');
    const group = probeGroup(job.childPgid); if (!group.gone || group.unknown) throw failure('RECOVERY_UNSAFE', 'Child process group is alive or cannot be identified');
  }
  const jobDir = path.join((await layoutForWorkspace(job.workspace)).jobsRoot, job.id); await recoverStaleMutationLock(jobDir);
  return /** @type {Promise<import('./contracts.js').Job>} */ (await withMutationLock(jobDir, async () => {
    const current = await readValidatedJob(jobDir); const currentRecoverable = current.status === 'failed' && current.error?.code === 'CANCEL_UNCONFIRMED'; if (TERMINAL.has(current.status) && !currentRecoverable) return current; if (current.workerNonce !== job.workerNonce) throw failure('RECOVERY_UNSAFE', 'Job nonce changed during recovery');
    const latestOwner = parseLockOwner(await readJson(lockFile), lockFile); if (latestOwner.nonce !== current.workerNonce || latestOwner.jobId !== current.id) throw failure('RECOVERY_UNSAFE', 'Workspace lock changed during recovery');
    const currentUnclaimed = current.status === 'starting' && current.ownerPid === undefined && current.childPgid === undefined && current.heartbeatAt === undefined;
    if (currentUnclaimed !== startingUnclaimed) throw failure('RECOVERY_UNSAFE', 'Job startup ownership changed during recovery');
    const currentHeartbeat = currentUnclaimed ? current.createdAt : current.heartbeatAt; if (!currentHeartbeat || Date.now() - Date.parse(currentHeartbeat) < LIMITS.staleMs) throw failure('RECOVERY_UNSAFE', 'Job age is not stale at commit');
    const latestPid = current.ownerPid ?? (typeof latestOwner.pid === 'number' ? latestOwner.pid : undefined); const latestProbe = latestPid === undefined ? { alive: false, unknown: true } : probePid(latestPid); if (latestProbe.alive || latestProbe.unknown) throw failure('RECOVERY_UNSAFE', 'Owner process is alive or cannot be identified at commit');
    if (!currentUnclaimed) { if (current.childPgid === undefined) throw failure('RECOVERY_UNSAFE', 'Child process group identity is missing at commit'); const latestGroup = probeGroup(current.childPgid); if (!latestGroup.gone || latestGroup.unknown) throw failure('RECOVERY_UNSAFE', 'Child process group is alive or cannot be identified at commit'); }
    const cancelled = await readCancel(jobDir, current.workerNonce); const recoveryStatus = cancelled ? 'cancelled' : 'interrupted'; /** @type {import('./contracts.js').Job} */ const interrupted = { ...current, status: recoveryStatus, updatedAt: new Date().toISOString(), ownerPid: undefined, childPgid: undefined, heartbeatAt: new Date().toISOString(), ...(cancelled ? {} : { error: { code: 'PROCESS_FAILED', message: currentUnclaimed ? 'Client disappeared before detached worker ownership was claimed; no process was started.' : 'Detached worker disappeared after a stale heartbeat; no process was killed.' } }), warnings: [...current.warnings, cancelled ? 'Cancellation was requested before recovery terminalization; cancellation takes precedence over interruption.' : (currentUnclaimed ? 'Recovered only after stale starting handoff and owner PID absence were confirmed; a late worker must not spawn.' : 'Recovered only after owner PID absence and child process-group disappearance were confirmed.')], activity: cancelled ? 'recovered as cancelled' : 'recovered as interrupted' };
    await writeJsonAtomic(pathForJob(jobDir, 'job.json'), interrupted); await releaseLock(current.workspace, current.lockKey, current.workerNonce); return interrupted;
  }));
}
/** @param {import('./contracts.js').Job} job @param {string} state */
async function diagnoseJob(job, state) {
  const reasons = [];
  const startingUnclaimed = job.status === 'starting' && job.ownerPid === undefined && job.childPgid === undefined && job.heartbeatAt === undefined;
  const ageAt = startingUnclaimed ? job.createdAt : job.heartbeatAt;
  const stale = Boolean(ageAt && Date.now() - Date.parse(ageAt) >= LIMITS.staleMs);
  if (!stale) reasons.push(startingUnclaimed ? 'starting handoff is not stale' : 'heartbeat is not stale');
  const lockFile = path.join(state, 'locks', hash(job.lockKey), LOCK_FILE);
  let owner;
  try { owner = parseLockOwner(await readJson(lockFile), lockFile); if (owner.nonce !== job.workerNonce || owner.jobId !== job.id) reasons.push('workspace lock nonce or job id does not match'); }
  catch { reasons.push('workspace lock metadata is unavailable or corrupt'); }
  const ownerPid = job.ownerPid ?? (typeof owner?.pid === 'number' ? owner.pid : undefined);
  const ownerProbe = ownerPid === undefined ? { alive: false, unknown: true } : probePid(ownerPid);
  if (ownerProbe.alive) reasons.push('owner PID is alive'); else if (ownerProbe.unknown) reasons.push('owner PID existence is uncertain'); else if (ownerPid === undefined) reasons.push('owner PID is missing');
  const groupProbe = startingUnclaimed ? { gone: true, unknown: false } : (job.childPgid === undefined ? { gone: false, unknown: true } : probeGroup(job.childPgid));
  if (!startingUnclaimed && job.childPgid === undefined) reasons.push('child process-group identity is missing'); else if (!startingUnclaimed && groupProbe.unknown) reasons.push('child process-group existence is uncertain'); else if (!startingUnclaimed && !groupProbe.gone) reasons.push('child process group is alive');
  const lockMatches = Boolean(owner && owner.nonce === job.workerNonce && owner.jobId === job.id);
  const recoveryEligible = startingUnclaimed ? (stale && lockMatches && !ownerProbe.alive && !ownerProbe.unknown && ownerPid !== undefined) : (stale && lockMatches && !ownerProbe.alive && !ownerProbe.unknown && ownerPid !== undefined && groupProbe.gone && !groupProbe.unknown && job.childPgid !== undefined);
  if (!recoveryEligible && reasons.length === 0) reasons.push('recovery preconditions are incomplete');
  return { id: job.id, status: job.status, startingUnclaimed, heartbeatAt: job.heartbeatAt, stale, ownerPid, ownerProbe, childPgid: job.childPgid, groupProbe, recoveryEligible, reasons };
}
/** @param {import('./contracts.js').Job} job @param {string} state */
async function diagnoseTerminalLock(job, state) {
  const lockFile = path.join(state, 'locks', hash(job.lockKey), LOCK_FILE); let owner;
  try { owner = parseLockOwner(await readJson(lockFile), lockFile); } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT' || (error instanceof DelegateError && /** @type {NodeJS.ErrnoException|undefined} */ (error.details)?.code === 'ENOENT')) return undefined;
    return { id: job.id, status: job.status, terminal: true, lockPresent: true, recoveryEligible: false, reasons: ['terminal job lock metadata is corrupt or unavailable'] };
  }
  const reasons = []; const lockMatches = owner.nonce === job.workerNonce && owner.jobId === job.id && owner.lockKey === job.lockKey; if (!lockMatches) reasons.push('terminal job lock belongs to another job or nonce');
  const ownerPid = /** @type {number} */ (owner.pid); const ownerProbe = probePid(ownerPid); if (ownerProbe.alive) reasons.push('terminal lock owner PID is alive'); else if (ownerProbe.unknown) reasons.push('terminal lock owner PID existence is uncertain');
  const groupProbe = job.childPgid === undefined ? { gone: true, unknown: false } : probeGroup(job.childPgid); if (job.childPgid !== undefined && groupProbe.unknown) reasons.push('terminal child process-group existence is uncertain'); else if (job.childPgid !== undefined && !groupProbe.gone) reasons.push('terminal child process group is alive');
  const recoveryEligible = lockMatches && !ownerProbe.alive && !ownerProbe.unknown && groupProbe.gone && !groupProbe.unknown;
  return { id: job.id, status: job.status, terminal: true, lockPresent: true, ownerPid, ownerProbe, childPgid: job.childPgid, groupProbe, recoveryEligible, reasons: recoveryEligible ? ['terminal job is persisted but its matching workspace lock was not released'] : reasons };
}
/** @param {import('./contracts.js').Job} job */
async function recoverTerminalLock(job) {
  const state = await stateRoot(); const layout = await layoutForWorkspace(job.workspace); const lockFile = path.join(state, 'locks', hash(job.lockKey), LOCK_FILE); const owner = parseLockOwner(await readJson(lockFile), lockFile);
  if (owner.nonce !== job.workerNonce || owner.jobId !== job.id || owner.lockKey !== job.lockKey) throw failure('RECOVERY_UNSAFE', 'Terminal job lock owner nonce does not match job');
  const ownerProbe = probePid(/** @type {number} */ (owner.pid)); if (ownerProbe.alive || ownerProbe.unknown) throw failure('RECOVERY_UNSAFE', 'Terminal lock owner is alive or cannot be identified');
  if (job.childPgid !== undefined) { const group = probeGroup(job.childPgid); if (!group.gone || group.unknown) throw failure('RECOVERY_UNSAFE', 'Terminal child process group is alive or cannot be identified'); }
  const jobDir = path.join(layout.jobsRoot, job.id); await recoverStaleMutationLock(jobDir);
  return /** @type {Promise<import('./contracts.js').Job>} */ (await withMutationLock(jobDir, async () => {
    const current = await readValidatedJob(jobDir); if (!TERMINAL.has(current.status) || current.workerNonce !== job.workerNonce) throw failure('RECOVERY_UNSAFE', 'Terminal job changed during lock recovery');
    const latest = parseLockOwner(await readJson(lockFile), lockFile); if (latest.nonce !== current.workerNonce || latest.jobId !== current.id || latest.lockKey !== current.lockKey) throw failure('RECOVERY_UNSAFE', 'Terminal lock changed during recovery');
    const latestProbe = probePid(/** @type {number} */ (latest.pid)); if (latestProbe.alive || latestProbe.unknown) throw failure('RECOVERY_UNSAFE', 'Terminal lock owner is alive or cannot be identified at commit');
    if (current.childPgid !== undefined) { const latestGroup = probeGroup(current.childPgid); if (!latestGroup.gone || latestGroup.unknown) throw failure('RECOVERY_UNSAFE', 'Terminal child process group is alive or cannot be identified at commit'); }
    await releaseLock(current.workspace, current.lockKey, current.workerNonce); return current;
  }));
}
/** @param {{workspace:string,lockKey:string,jobsRoot:string,lockDir:string,stateRoot:string}} layout */
async function inspectPrepublished(layout) {
  const entries = await readdir(layout.jobsRoot, { withFileTypes: true }); const diagnostics = [];
  for (const entry of entries) {
    if (!(entry.isDirectory() && entry.name.startsWith('.job-') && entry.name.endsWith('.tmp'))) continue;
    const temporaryDir = path.join(layout.jobsRoot, entry.name); const jobFile = path.join(temporaryDir, 'job.json');
    /** @type {import('./contracts.js').Job} */ let job;
    try { job = /** @type {import('./contracts.js').Job} */ (await readSchemaJson(jobFile, jobSchema)); } catch (error) { diagnostics.push({ temporaryDir, recoveryEligible: false, reason: 'temporary job metadata is incomplete or corrupt', error: String(error) }); continue; }
    const lockFile = path.join(layout.lockDir, LOCK_FILE); let owner;
    try { owner = parseLockOwner(await readJson(lockFile), lockFile); } catch { diagnostics.push({ id: job.id, temporaryDir, recoveryEligible: false, reason: 'workspace lock metadata is unavailable or corrupt' }); continue; }
    const unclaimed = job.status === 'starting' && job.ownerPid === undefined && job.childPgid === undefined && job.heartbeatAt === undefined;
    const ownerProbe = probePid(/** @type {number} */ (owner.pid)); const stale = Date.now() - Date.parse(job.createdAt) >= LIMITS.staleMs; const matches = owner.nonce === job.workerNonce && owner.jobId === job.id && job.workspace === layout.workspace && job.lockKey === layout.lockKey;
    const reasons = []; if (!matches) reasons.push('lock/job identity mismatch'); if (!unclaimed) reasons.push('worker ownership or child identity was claimed'); if (!stale) reasons.push('temporary job is not stale'); if (ownerProbe.alive) reasons.push('initiating PID is alive'); if (ownerProbe.unknown) reasons.push('initiating PID existence is uncertain');
    diagnostics.push({ id: job.id, temporaryDir, status: job.status, ownerPid: owner.pid, stale, recoveryEligible: matches && unclaimed && stale && !ownerProbe.alive && !ownerProbe.unknown, reasons });
  }
  return diagnostics;
}
/** @param {{workspace:string,lockKey:string,jobsRoot:string,lockDir:string,stateRoot:string}} layout @param {string} jobId */
async function recoverPrepublished(layout, jobId) {
  const temporaryDir = path.join(layout.jobsRoot, '.job-' + jobId + '.tmp'); const job = await readSchemaJson(path.join(temporaryDir, 'job.json'), jobSchema); const lockFile = path.join(layout.lockDir, LOCK_FILE); const owner = parseLockOwner(await readJson(lockFile), lockFile);
  if (job.id !== jobId || job.workspace !== layout.workspace || job.lockKey !== layout.lockKey || owner.nonce !== job.workerNonce || owner.jobId !== job.id) throw failure('RECOVERY_UNSAFE', 'Pre-publication job or lock identity changed');
  if (job.status !== 'starting' || job.ownerPid !== undefined || job.childPgid !== undefined || job.heartbeatAt !== undefined) throw failure('RECOVERY_UNSAFE', 'Pre-publication worker ownership was claimed');
  if (Date.now() - Date.parse(job.createdAt) < LIMITS.staleMs) throw failure('RECOVERY_UNSAFE', 'Pre-publication job is not stale');
  const ownerProbe = probePid(/** @type {number} */ (owner.pid)); if (ownerProbe.alive || ownerProbe.unknown) throw failure('RECOVERY_UNSAFE', 'Initiating process is alive or cannot be identified');
  const cancelled = await readCancel(temporaryDir, job.workerNonce); await removeOwn(temporaryDir); await releaseLock(layout.workspace, layout.lockKey, /** @type {string} */ (owner.nonce));
  return { status: cancelled ? 'cancelled' : 'interrupted', jobId, prepublication: true, message: cancelled ? 'Recovered an abandoned pre-publication cancellation; no worker was allowed to spawn.' : 'Recovered an abandoned pre-publication job; no worker was allowed to spawn.' };
}
/** @param {{workspace:string,recover?:string}} options */
export async function doctor(options) {
  const layout = await makeLayout(options.workspace); const executableInfo = await discoverExecutable(layout.workspace); let jobs = await listJobs({ workspace: layout.workspace }); let recovered; let prepublication = await inspectPrepublished(layout);
  if (options.recover !== undefined) { if (!jobIdSchema.safeParse(options.recover).success) throw failure('INVALID_INPUT', 'recover must be a UUID'); const target = jobs.find((job) => job.id === options.recover); if (target) { if (TERMINAL.has(target.status)) { const terminalLock = await diagnoseTerminalLock(target, layout.stateRoot); if (!terminalLock) recovered = target; else if (!terminalLock.recoveryEligible) throw failure('RECOVERY_UNSAFE', 'Terminal job lock cannot be safely recovered'); else recovered = await recoverTerminalLock(target); } else recovered = await recoverJob(target); } else { const temporary = prepublication.find((item) => item.id === options.recover); if (!temporary) throw failure('NOT_FOUND', 'Job not found in workspace: ' + options.recover); recovered = await recoverPrepublished(layout, options.recover); } jobs = await listJobs({ workspace: layout.workspace }); prepublication = await inspectPrepublished(layout); }
  const diagnostics = []; for (const job of jobs) { if (!TERMINAL.has(job.status) || job.error?.code === 'CANCEL_UNCONFIRMED') diagnostics.push(await diagnoseJob(job, layout.stateRoot)); if (TERMINAL.has(job.status)) { const terminalLock = await diagnoseTerminalLock(job, layout.stateRoot); if (terminalLock) diagnostics.push(terminalLock); } }
  const active = jobs.filter((job) => !TERMINAL.has(job.status)); return { version: VERSION, status: recovered?.status, job: recovered, workspace: layout.workspace, lockKey: layout.lockKey, stateRoot: layout.stateRoot, configPath: executableInfo.configPath, executable: executableInfo.executable, ompVersion: executableInfo.version, active: active.map((job) => ({ id: job.id, status: job.status, ownerPid: job.ownerPid, childPgid: job.childPgid, heartbeatAt: job.heartbeatAt })), diagnostics, prepublication, jobs: jobs.length, ...(recovered ? { recovered } : {}), warnings: ['State is shared independently of Claude profile configuration; doctor never logs in, updates OMP, or kills an uncertain process.'] };
}
/** @param {string} jobDir @returns {Promise<import('./contracts.js').Job>} */
export async function loadWorkerJob(jobDir) { const job = await readJobFromDir(jobDir); const layout = await layoutForWorkspace(job.workspace); await validateJobIdentity(job, layout, jobDir); return job; }
/** @param {string} workspace @param {string} expectedExecutable */
export async function workerExecutable(workspace, expectedExecutable) { const layout = await makeLayout(workspace); const actual = (await discoverExecutable(layout.workspace)).executable; if (actual !== expectedExecutable) throw failure('STATE_CORRUPT', 'Configured executable changed after job creation'); return actual; }
/** @param {string} jobDir @param {import('./contracts.js').Job} job @returns {Promise<import('./contracts.js').Job>} */
export async function initializeWorker(jobDir, job) {
  const state = await stateRoot(); const lockFile = path.join(state, 'locks', hash(job.lockKey), LOCK_FILE); const owner = parseLockOwner(await readJson(lockFile), lockFile); if (owner.nonce !== job.workerNonce || owner.jobId !== job.id) throw failure('RECOVERY_UNSAFE', 'Workspace lock does not belong to worker');
  return /** @type {Promise<import('./contracts.js').Job>} */ (await withMutationLock(jobDir, async () => { const current = await readValidatedJob(jobDir); if (current.workerNonce !== job.workerNonce || TERMINAL.has(current.status)) return current; const now = new Date().toISOString(); const updatedOwner = { ...owner, pid: process.pid, updatedAt: now }; await writeJsonAtomic(lockFile, updatedOwner); /** @type {import('./contracts.js').Job} */ const running = { ...current, status: (await readCancel(jobDir, current.workerNonce)) ? 'cancelling' : 'running', ownerPid: process.pid, heartbeatAt: now, updatedAt: now, activity: 'OMP worker started' }; await writeJsonAtomic(pathForJob(jobDir, 'job.json'), running); await writeJsonAtomic(pathForJob(jobDir, READY_FILE), { version: VERSION, jobId: running.id, nonce: running.workerNonce, pid: process.pid, at: now }); return running; }));
}
/** @param {string} jobDir @param {string} nonce @param {Partial<import('./contracts.js').Job>} patch */
export async function workerPatch(jobDir, nonce, patch) {
  return await withMutationLock(jobDir, async () => { const current = await readValidatedJob(jobDir); if (current.workerNonce !== nonce || TERMINAL.has(current.status)) return current; /** @type {import('./contracts.js').Job} */ const next = { ...current, ...patch, updatedAt: new Date().toISOString() }; await writeJsonAtomic(pathForJob(jobDir, 'job.json'), next); return next; });
}
/** @param {unknown} error @param {string} [fallback] */
function asJobError(error, fallback = 'WORKER_NOT_READY') {
  if (error instanceof DelegateError) return { code: error.code, message: error.message };
  return { code: /** @type {any} */ (fallback), message: String(error) };
}
/** Terminalize only a job for which no OMP child can be live. @param {string} jobDir @param {string} nonce @param {unknown} error @returns {Promise<import('./contracts.js').Job>} */
export async function terminalizeWorkerFailure(jobDir, nonce, error) {
  return /** @type {Promise<import('./contracts.js').Job>} */ (await withMutationLock(jobDir, async () => {
    const current = await readValidatedJob(jobDir);
    if (TERMINAL.has(current.status)) return current;
    let jobError = asJobError(error); let cancelled = false; try { cancelled = await readCancel(jobDir, nonce); } catch (cancelError) { if (cancelError instanceof DelegateError && cancelError.code === 'STATE_CORRUPT') jobError = asJobError(cancelError); else throw cancelError; }
    const run = { status: cancelled ? 'cancelled' : 'failed', text: '', stderr: '', exitCode: null, verification: [], ...(cancelled ? {} : { error: jobError }), terminationConfirmed: true };
    const resultFile = pathForJob(jobDir, RESULT_FILE);
    const artifact = { version: 1, jobId: current.id, finalText: '', run, evidence: undefined, warnings: ['Worker failed before readiness; no OMP child was started.'] };
    await writeJsonAtomic(resultFile, artifact);
    await writeTextAtomic(pathForJob(jobDir, STDERR_FILE), '');
    /** @type {import('./contracts.js').Job} */ const terminal = { ...current, status: cancelled ? 'cancelled' : 'failed', updatedAt: new Date().toISOString(), ownerPid: undefined, childPgid: undefined, heartbeatAt: new Date().toISOString(), ...(cancelled ? {} : { error: jobError }), result: { ...run, resultFile }, warnings: [...current.warnings, cancelled ? 'Cancellation was requested before startup failure terminalization; cancellation takes precedence.' : 'Worker failed before readiness; no OMP child was started.'], activity: cancelled ? 'cancelled before worker readiness' : 'worker failed before readiness' };
    await writeJsonAtomic(pathForJob(jobDir, 'job.json'), terminal);
    await releaseTerminalLock(jobDir, terminal);
    return terminal;
  }));
}
/** @param {string} jobDir @param {string} nonce @param {Record<string,unknown>} result */
export async function commitWorkerResult(jobDir, nonce, result) {
  return await withMutationLock(jobDir, async () => { const current = await readValidatedJob(jobDir); if (current.workerNonce !== nonce) throw failure('RECOVERY_UNSAFE', 'Worker nonce changed before terminal commit'); if (TERMINAL.has(current.status)) return current; const cancelled = await readCancel(jobDir, nonce); const resultStatus = result.status; const unconfirmed = result.terminationConfirmed === false; const status = unconfirmed ? 'failed' : (cancelled || resultStatus === 'cancelled' ? 'cancelled' : resultStatus === 'completed' ? 'completed' : 'failed'); const error = result.error && typeof result.error === 'object' ? result.error : undefined; /** @type {import('./contracts.js').Job} */ const terminal = jobSchema.parse({ ...current, status, updatedAt: new Date().toISOString(), ownerPid: unconfirmed ? current.ownerPid : undefined, childPgid: unconfirmed ? current.childPgid : undefined, heartbeatAt: new Date().toISOString(), ...(result.sessionId ? { sessionId: result.sessionId } : {}), ...(result.sessionFile ? { sessionFile: result.sessionFile } : {}), ompVersion: SUPPORTED_OMP_VERSION, ...(result.modelActual ? { modelActual: result.modelActual } : {}), ...(error ? { error: /** @type {any} */ (error) } : {}), result, warnings: [...current.warnings, ...(Array.isArray(result.warnings) ? result.warnings.map(String) : []), ...(unconfirmed ? ['Process termination was not confirmed; workspace lock retained.'] : [])], activity: status === 'completed' ? 'OMP completed; review result evidence' : status }); await writeJsonAtomic(pathForJob(jobDir, 'job.json'), terminal); if (!unconfirmed) await releaseTerminalLock(jobDir, terminal); return terminal; });
}
/** @param {string} jobDir @param {string} nonce @param {unknown[]} events */
export async function appendWorkerEvents(jobDir, nonce, events) {
  if (events.length === 0) return;
  const job = await readValidatedJob(jobDir);
  if (job.workerNonce !== nonce || TERMINAL.has(job.status)) return;
  await appendLines(pathForJob(jobDir, EVENTS_FILE), events.map((event) => JSON.stringify(sanitizeDelegateValue(event))));
}
/** @param {string} jobDir @param {string} nonce @param {string} stderr */
export async function writeWorkerStderr(jobDir, nonce, stderr) { const job = await readValidatedJob(jobDir); if (job.workerNonce !== nonce) throw failure('RECOVERY_UNSAFE', 'Worker nonce changed before stderr write'); await writeTextAtomic(pathForJob(jobDir, STDERR_FILE), redactDiagnostic(stderr)); }
/** @param {string} jobDir @param {string} nonce @param {Record<string,unknown>} result */
export async function writeWorkerResultArtifact(jobDir, nonce, result) { return await withMutationLock(jobDir, async () => { const job = await readValidatedJob(jobDir); if (job.workerNonce !== nonce) throw failure('RECOVERY_UNSAFE', 'Worker nonce changed before result write'); const target = pathForJob(jobDir, RESULT_FILE); if (TERMINAL.has(job.status)) { await secureExistingFile(target); return target; } await writeJsonAtomic(target, result); return target; }); }
/** @param {string} workspace @param {string[]} scopes @param {Record<string,unknown>} baseline */
export async function collectAfterEvidence(workspace, scopes, baseline) { const after = await snapshotWorkspace(workspace); const beforeHashes = /** @type {Record<string,string>} */ ((baseline && typeof baseline === 'object' && baseline.fileHashes && typeof baseline.fileHashes === 'object') ? baseline.fileHashes : {}); const afterHashes = /** @type {Record<string,string>} */ (after.fileHashes ?? {}); const changed = [...new Set([...Object.keys(beforeHashes), ...Object.keys(afterHashes)].filter((file) => beforeHashes[file] !== afterHashes[file]))]; return { baseline, after, changed, outsideWriteScope: outsideScopes(workspace, scopes, changed) }; }
/** @param {import('./contracts.js').Job} job @returns {Promise<{brief:import('./contracts.js').Brief,artifacts:{brief:string,events:string,stderr:string,result:string,sessionDir:string}}>} */
export async function jobDetails(job) {
  if (!job || !jobIdSchema.safeParse(job.id).success) throw failure('INVALID_INPUT', 'job must contain a valid UUID');
  const layout = await layoutForWorkspace(job.workspace); const jobDir = path.join(layout.jobsRoot, job.id); const persisted = await readJobFromDir(jobDir);
  if (persisted.id !== job.id || persisted.workspace !== layout.workspace) throw failure('STATE_CORRUPT', 'Job identity does not match persisted workspace');
  await validateJobIdentity(persisted, layout, jobDir);
  const brief = await readBrief(jobDir);
  return { brief, artifacts: { brief: pathForJob(jobDir, 'brief.json'), events: pathForJob(jobDir, EVENTS_FILE), stderr: pathForJob(jobDir, STDERR_FILE), result: pathForJob(jobDir, RESULT_FILE), sessionDir: persisted.sessionDir } };
}
/** @param {string} jobDir */
export async function readBaseline(jobDir) { return await readJson(pathForJob(jobDir, BASELINE_FILE)); }
/** @param {string} jobDir */
export async function readBrief(jobDir) { return await readSchemaJson(pathForJob(jobDir, 'brief.json'), briefSchema); }
/** @param {string} jobDir @param {string} nonce */
export async function cancellationRequested(jobDir, nonce) { return await readCancel(jobDir, nonce); }
/** @param {string} workspace @param {string} lockKey @param {string} nonce */
export async function releaseWorkerLock(workspace, lockKey, nonce) { return await releaseLock(workspace, lockKey, nonce); }
/** @param {string} jobDir @param {string} name */
export function jobPath(jobDir, name) { return pathForJob(jobDir, name); }
export { WORKER_FILE };

/** Terminal success is durable even when workspace-lock cleanup fails.
 * @param {string} jobDir @param {import('./contracts.js').Job} terminal
 */
async function releaseTerminalLock(jobDir, terminal) {
 try { await releaseLock(terminal.workspace, terminal.lockKey, terminal.workerNonce); }
 catch { terminal.warnings.push('Workspace lock cleanup failed; terminal result preserved. Run /omp:doctor before another job.'); await writeJsonAtomic(pathForJob(jobDir,'job.json'),terminal); }
}

/** Best-effort known-credential redaction; arbitrary tool text is not a security boundary.
 * @param {string} text
 */
function redactDiagnostic(text) {
 return text.replace(/(authorization["']?\s*[:=]\s*["']?)(?:(?:bearer|basic)\s+)?[^"'\s,}]+/gi,'$1[REDACTED]')
 .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)["']?\s*[:=]\s*["']?)[^"'\s,}]+/gi,'$1[REDACTED]')
 .replace(/\b(?:sk-(?:proj-)?|gh[pousr]_|github_pat_)[A-Za-z0-9_-]{16,}\b/g,'[REDACTED]')
 .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,'[REDACTED PRIVATE KEY]');
}
