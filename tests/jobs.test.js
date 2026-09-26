import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, watch } from 'node:fs';
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm as removeTree, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DelegateError } from '../src/contracts.js';
import { doctor, followupJob, getJob, jobDetails, listJobs, requestCancel, startJob, waitForJob, writeWorkerResultArtifact, writeWorkerStderr, workerExecutable } from '../src/jobs.js';
import { renderResult, renderStatus } from '../src/render.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'job-omp.mjs');
const CLIENT = path.join(ROOT, 'tests', 'fixtures', 'job-client.mjs');
const NODE = process.execPath;
const BURST_COUNT = 5000;
const BASE_BRIEF = {
  decisions: 'Use the deterministic job fixture and preserve existing files.',
  writeScope: ['fixture-only-output'],
  acceptance: ['the fixture observes the requested lifecycle'],
  constraints: ['do not reset, stash, or overwrite unrelated user changes'],
  verification: ['read the persisted job and session proof'],
};
function briefFor(mode, suffix = '') {
  return { goal: 'JOB_FIXTURE_MODE=' + mode + (suffix ? '\nJOB_FIXTURE_SUFFIX=' + suffix : ''), ...BASE_BRIEF };
}
function codeOf(value) {
  if (!value || typeof value !== 'object') return undefined;
  if (typeof value.code === 'string') return value.code;
  if (value.error && typeof value.error.code === 'string') return value.error.code;
  return undefined;
}
async function rejectsCode(promise, expected) {
  await assert.rejects(promise, (error) => {
    assert.equal(codeOf(error), expected, error instanceof Error ? error.message : String(error));
    return true;
  });
}
async function waitForFile(file, timeoutMs = 5000) {
  try { await access(file, constants.F_OK); return; } catch {}
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const watcher = watch(path.dirname(file));
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for ' + file)), timeoutMs);
      const done = () => { clearTimeout(timer); watcher.close(); resolve(undefined); };
      watcher.on('error', (error) => { clearTimeout(timer); watcher.close(); reject(error); });
      watcher.on('change', (_event, name) => { if (String(name) === path.basename(file)) done(); });
      access(file, constants.F_OK).then(done, () => {});
    });
  } finally { watcher.close(); }
}
function groupGone(pgid) {
  try { process.kill(-pgid, 0); return false; }
  catch (error) { return error?.code === 'ESRCH'; }
}
async function waitForPidGone(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); }
    catch (error) { if (error?.code === 'ESRCH') return; throw error; }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('process remained alive: ' + pid);
}
function workspaceRoot(stateRoot, workspace) {
  return path.join(stateRoot, 'workspaces', createHash('sha256').update(path.resolve(workspace)).digest('hex'));
}
function jobDir(stateRoot, workspace, id) { return path.join(workspaceRoot(stateRoot, workspace), 'jobs', id); }
async function lockMetadataFiles(root) {
  const files = [];
  async function walk(directory) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const child = path.join(directory, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) await walk(child);
      else if (entry.isFile() && !child.includes(path.sep + 'jobs' + path.sep)) {
        try {
          const value = JSON.parse(await readFile(child, 'utf8'));
          if (value && typeof value === 'object' && ('nonce' in value || 'workerNonce' in value)) files.push(child);
        } catch {}
      }
    }
  }
  await walk(root);
  return files;
}
async function setup() {
  const rawStateRoot = await mkdtemp(path.join(os.tmpdir(), 'omp-jobs-state-'));
  const rawWorkspace = await mkdtemp(path.join(os.tmpdir(), 'omp-jobs-workspace-'));
  const stateRoot = await realpath(rawStateRoot);
  const workspace = await realpath(rawWorkspace);
  const markerDir = path.join(stateRoot, 'markers');
  await mkdir(markerDir, { recursive: true, mode: 0o700 });
  await writeFile(path.join(stateRoot, 'config.json'), JSON.stringify({ version: 1, executable: FIXTURE }) + '\n', { mode: 0o600 });
  await chmod(FIXTURE, 0o755);
  const previousStateRoot = process.env.OMP_DELEGATE_STATE_DIR;
  process.env.OMP_DELEGATE_STATE_DIR = stateRoot;
  return { stateRoot, workspace, markerDir, previousStateRoot };
}
function clientProcess(stateRoot, extra, args) {
  return spawn(NODE, [CLIENT, ...args], { cwd: ROOT, env: { ...process.env, OMP_DELEGATE_STATE_DIR: stateRoot, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
}
async function clientResult(child) {
  let stdout = ''; let stderr = '';
  child.stdout?.setEncoding('utf8'); child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk) => { stdout += chunk; });
  child.stderr?.on('data', (chunk) => { stderr += chunk; });
  const exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  assert.ok(line, 'client emitted no JSON (stderr: ' + stderr + ')');
  return { exitCode, stderr, ...JSON.parse(line) };
}
async function waitForChildIdentity(workspace, jobId, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await getJob({ workspace, jobId });
    if (job.ownerPid && job.childPgid) return job;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('worker did not persist ownerPid/childPgid for ' + jobId);
}
async function cancelAny(workspace) {
  let jobs;
  try { jobs = await listJobs({ workspace }); } catch { return true; }
  for (const job of jobs) {
    if (!['starting', 'running', 'cancelling'].includes(job.status)) continue;
    try { await requestCancel({ workspace, jobId: job.id }); } catch {}
    try { await waitForJob({ workspace, jobId: job.id, timeoutMs: 30000 }); } catch {}
  }
  try { return !(await listJobs({ workspace })).some((job) => ['starting', 'running', 'cancelling'].includes(job.status)); }
  catch { return false; }
}
async function cleanup(value) {
  const safe = await cancelAny(value.workspace);
  if (!safe) {
    if (value.previousStateRoot === undefined) delete process.env.OMP_DELEGATE_STATE_DIR;
    else process.env.OMP_DELEGATE_STATE_DIR = value.previousStateRoot;
    throw new Error('refusing to remove state while a worker remains active');
  }
  await removeTree(value.stateRoot, { recursive: true, force: true });
  await removeTree(value.workspace, { recursive: true, force: true });
  if (value.previousStateRoot === undefined) delete process.env.OMP_DELEGATE_STATE_DIR;
  else process.env.OMP_DELEGATE_STATE_DIR = value.previousStateRoot;
}

before(async () => { await chmod(FIXTURE, 0o755); await chmod(CLIENT, 0o755); });
after(() => { delete process.env.OMP_JOB_FIXTURE_READY_FILE; });

test('independent clients serialize one workspace lock and share one state root', async () => {
  const value = await setup();
  const payload = JSON.stringify({ workspace: value.workspace, brief: briefFor('hold') });
  const left = clientProcess(value.stateRoot, { CLAUDE_CONFIG_DIR: path.join(value.stateRoot, 'company') }, ['start', payload]);
  const right = clientProcess(value.stateRoot, { CLAUDE_CONFIG_DIR: path.join(value.stateRoot, 'personal') }, ['start', payload]);
  const results = await Promise.all([clientResult(left), clientResult(right)]);
  try {
    assert.equal(results.filter((item) => item.ok).length, 1, JSON.stringify(results));
    assert.equal(results.filter((item) => codeOf(item) === 'WORKSPACE_BUSY').length, 1, JSON.stringify(results));
    const winner = results.find((item) => item.ok).result;
    assert.ok(winner.id);
    assert.equal((await listJobs({ workspace: value.workspace })).length, 1);
    await requestCancel({ workspace: value.workspace, jobId: winner.id });
    assert.equal((await waitForJob({ workspace: value.workspace, jobId: winner.id, timeoutMs: 30000 })).status, 'cancelled');
  } finally { await cleanup(value); }
});

test('atomic job writes stay valid JSON while a worker is running', async () => {
  const value = await setup();
  const marker = path.join(value.markerDir, 'ready');
  const previous = process.env.OMP_JOB_FIXTURE_READY_FILE;
  process.env.OMP_JOB_FIXTURE_READY_FILE = marker;
  try {
    const started = await startJob({ workspace: value.workspace, brief: briefFor('hold') });
    await waitForFile(marker);
    const file = path.join(jobDir(value.stateRoot, value.workspace, started.id), 'job.json');
    for (let index = 0; index < 25; index += 1) {
      const persisted = JSON.parse(await readFile(file, 'utf8'));
      assert.equal(persisted.id, started.id);
      assert.equal((await listJobs({ workspace: value.workspace }))[0].id, started.id);
    }
    await requestCancel({ workspace: value.workspace, jobId: started.id });
    assert.equal((await waitForJob({ workspace: value.workspace, jobId: started.id, timeoutMs: 30000 })).status, 'cancelled');
  } finally {
    if (previous === undefined) delete process.env.OMP_JOB_FIXTURE_READY_FILE; else process.env.OMP_JOB_FIXTURE_READY_FILE = previous;
    await cleanup(value);
  }
});

test('corrupt JSON is surfaced, not replaced by an empty state', async () => {
  const value = await setup();
  try {
    const started = await startJob({ workspace: value.workspace, brief: briefFor('success') });
    assert.equal((await waitForJob({ workspace: value.workspace, jobId: started.id, timeoutMs: 30000 })).status, 'completed');
    await writeFile(path.join(jobDir(value.stateRoot, value.workspace, started.id), 'job.json'), '{broken', { mode: 0o600 });
    await rejectsCode(listJobs({ workspace: value.workspace }), 'STATE_CORRUPT');
    await rejectsCode(getJob({ workspace: value.workspace, jobId: started.id }), 'STATE_CORRUPT');
  } finally { await cleanup(value); }
});

test('rejects UUID traversal and symlinked state/job paths', async () => {
  const value = await setup();
  try {
    await rejectsCode(getJob({ workspace: value.workspace, jobId: '../../etc/passwd' }), 'INVALID_INPUT');
    const started = await startJob({ workspace: value.workspace, brief: briefFor('success') });
    await waitForJob({ workspace: value.workspace, jobId: started.id, timeoutMs: 30000 });
    const outside = await mkdtemp(path.join(os.tmpdir(), 'omp-jobs-outside-'));
    const original = jobDir(value.stateRoot, value.workspace, started.id);
    const moved = path.join(outside, 'moved');
    await removeTree(original, { recursive: true, force: true });
    await symlink(moved, original, 'dir');
    await rejectsCode(getJob({ workspace: value.workspace, jobId: started.id }), 'STATE_CORRUPT');
    await removeTree(outside, { recursive: true, force: true });
  } finally { await cleanup(value); }
  const realRoot = await mkdtemp(path.join(os.tmpdir(), 'omp-jobs-real-root-'));
  const linkRoot = realRoot + '-link';
  const linkedWorkspace = await mkdtemp(path.join(os.tmpdir(), 'omp-jobs-linked-workspace-'));
  await symlink(realRoot, linkRoot, 'dir');
  const previous = process.env.OMP_DELEGATE_STATE_DIR;
  process.env.OMP_DELEGATE_STATE_DIR = linkRoot;
  try { await rejectsCode(startJob({ workspace: linkedWorkspace, brief: briefFor('success') }), 'STATE_CORRUPT'); }
  finally {
    if (previous === undefined) delete process.env.OMP_DELEGATE_STATE_DIR; else process.env.OMP_DELEGATE_STATE_DIR = previous;
    await removeTree(realRoot, { recursive: true, force: true }); await removeTree(linkRoot, { recursive: true, force: true }); await removeTree(linkedWorkspace, { recursive: true, force: true });
  }
});

test('cancel is linearized before completion, during a held child, and after terminal commit', async () => {
  const value = await setup(); const marker = path.join(value.markerDir, 'ready');
  const previous = process.env.OMP_JOB_FIXTURE_READY_FILE; process.env.OMP_JOB_FIXTURE_READY_FILE = marker;
  try {
    const early = await startJob({ workspace: value.workspace, brief: briefFor('cancel-before') });
    assert.equal((await requestCancel({ workspace: value.workspace, jobId: early.id })).id, early.id);
    assert.equal((await waitForJob({ workspace: value.workspace, jobId: early.id, timeoutMs: 30000 })).status, 'cancelled');
    const running = await startJob({ workspace: value.workspace, brief: briefFor('hold') }); await waitForFile(marker);
    assert.equal((await requestCancel({ workspace: value.workspace, jobId: running.id })).id, running.id);
    assert.equal((await waitForJob({ workspace: value.workspace, jobId: running.id, timeoutMs: 30000 })).status, 'cancelled');
    assert.equal((await requestCancel({ workspace: value.workspace, jobId: running.id })).status, 'cancelled');
    delete process.env.OMP_JOB_FIXTURE_READY_FILE;
    const terminal = await startJob({ workspace: value.workspace, brief: briefFor('success') });
    assert.equal((await waitForJob({ workspace: value.workspace, jobId: terminal.id, timeoutMs: 30000 })).status, 'completed');
    assert.equal((await requestCancel({ workspace: value.workspace, jobId: terminal.id })).status, 'completed');
  } finally {
    if (previous === undefined) delete process.env.OMP_JOB_FIXTURE_READY_FILE; else process.env.OMP_JOB_FIXTURE_READY_FILE = previous;
    await cleanup(value);
  }
});

test('worker records OMP usage once per model response and a secret-free recent tool list', async () => {
  const value = await setup();
  try {
    const started = await startJob({ workspace: value.workspace, brief: briefFor('tools') });
    const done = await waitForJob({ workspace: value.workspace, jobId: started.id, timeoutMs: 30000 });
    assert.equal(done.status, 'completed', JSON.stringify({ status: done.status, error: done.error }));
    assert.deepEqual({ ...done.usage, cost: Math.round((done.usage?.cost ?? 0) * 1e6) / 1e6 }, { input: 300, output: 30, cacheRead: 2000, cacheWrite: 0, totalTokens: 2330, cost: 0.05, messages: 2 });
    assert.deepEqual(done.recentActivity?.map((entry) => entry.replace(/^\+\d+s /, '')), ['bash ok', 'read error']);
    assert.doesNotMatch(JSON.stringify(done.recentActivity), /SECRET_TOKEN|missing\.txt/);
    const saved = process.env.OMP_DELEGATE_LANG; process.env.OMP_DELEGATE_LANG = 'en';
    try {
      const card = renderResult(done, await jobDetails(done));
      assert.match(card.summary, /Tokens: 300 in \/ 30 out \/ 2k cache read · OMP cost estimate \$0\.05 \(2 model responses; estimate from OMP, not a bill\)/);
      const status = await renderStatus([done]);
      assert.match(status.summary, /OMP cost estimate across 1 listed job: \$0\.05/);
    } finally { if (saved === undefined) delete process.env.OMP_DELEGATE_LANG; else process.env.OMP_DELEGATE_LANG = saved; }
  } finally {
    await cleanup(value);
  }
});

test('durable worker drains an ordered event burst before terminal completion', async () => {
  const value = await setup();
  try {
    const started = await startJob({ workspace: value.workspace, brief: briefFor('burst') });
    const done = await waitForJob({ workspace: value.workspace, jobId: started.id, timeoutMs: 30000 });
    assert.equal(done.status, 'completed', JSON.stringify({ id: done.id, status: done.status, error: done.error, activity: done.activity }));

    const eventsPath = path.join(jobDir(value.stateRoot, value.workspace, done.id), 'events.jsonl');
    const events = (await readFile(eventsPath, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(events.length, BURST_COUNT + 5);
    assert.deepEqual(events.slice(0, 3).map((event) => event.type), ['session', 'agent_start', 'turn_start']);
    assert.deepEqual(events.slice(3, 3 + BURST_COUNT).map((event) => event.type), Array.from({ length: BURST_COUNT }, () => 'message_update'));
    assert.deepEqual(events.slice(-2).map((event) => event.type), ['message_end', 'agent_end']);

    const updates = events.slice(3, 3 + BURST_COUNT);
    assert.deepEqual(updates.map(({ sequence, delta }) => ({ sequence, delta })), Array.from({ length: BURST_COUNT }, (_, sequence) => ({ sequence, delta: 'burst-' + sequence })));
    const finalEvent = events.at(-2);
    assert.equal(finalEvent.message?.role, 'assistant');
    assert.equal(finalEvent.message?.stopReason, 'stop');
    assert.equal(finalEvent.message?.content?.[0]?.text, 'BURST_OK:' + done.sessionId + ':' + BURST_COUNT);

    const nativeSession = (await readFile(done.sessionFile, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    const persistedFinal = nativeSession.find((row) => row.type === 'message' && row.message?.role === 'assistant');
    assert.equal(persistedFinal?.message?.content?.[0]?.text, finalEvent.message.content[0].text);
  } finally { await cleanup(value); }
});

test('followup makes a new job, preserves old job, and resumes the same session', async () => {
  const value = await setup();
  try {
    const original = await startJob({ workspace: value.workspace, brief: briefFor('success', 'DECISION=preserved') });
    const first = await waitForJob({ workspace: value.workspace, jobId: original.id, timeoutMs: 30000 });
    assert.equal(first.status, 'completed');
    const before = structuredClone(await getJob({ workspace: value.workspace, jobId: original.id }));
    const next = await followupJob({ workspace: value.workspace, jobId: original.id, brief: briefFor('resume', 'FOLLOWUP=boundary') });
    assert.notEqual(next.id, original.id); assert.equal(next.parentJobId, original.id); assert.equal(next.sessionId, first.sessionId);
    const resumed = await waitForJob({ workspace: value.workspace, jobId: next.id, timeoutMs: 30000 });
    assert.equal(resumed.status, 'completed'); assert.equal(resumed.sessionId, first.sessionId);
    assert.match(String(resumed.result?.text ?? resumed.result?.finalText ?? ''), /RESUME|FOLLOWUP/);
    assert.deepEqual(await getJob({ workspace: value.workspace, jobId: original.id }), before);
  } finally { await cleanup(value); }
});

test('followup without id rejects multiple sessions and accepts one unique session', async () => {
  const value = await setup();
  try {
    const one = await startJob({ workspace: value.workspace, brief: briefFor('success', 'ONE') }); const oneDone = await waitForJob({ workspace: value.workspace, jobId: one.id, timeoutMs: 30000 });
    const two = await startJob({ workspace: value.workspace, brief: briefFor('success', 'TWO') }); const twoDone = await waitForJob({ workspace: value.workspace, jobId: two.id, timeoutMs: 30000 });
    assert.notEqual(oneDone.sessionId, twoDone.sessionId);
    await rejectsCode(followupJob({ workspace: value.workspace, brief: briefFor('resume', 'ambiguous') }), 'AMBIGUOUS_SESSION');
  } finally { await cleanup(value); }
  const unique = await setup();
  try {
    const one = await startJob({ workspace: unique.workspace, brief: briefFor('success', 'UNIQUE') }); const oneDone = await waitForJob({ workspace: unique.workspace, jobId: one.id, timeoutMs: 30000 });
    const child = await followupJob({ workspace: unique.workspace, jobId: one.id, brief: briefFor('resume', 'selected') }); const childDone = await waitForJob({ workspace: unique.workspace, jobId: child.id, timeoutMs: 30000 });
    assert.equal(child.parentJobId, one.id); assert.equal(child.sessionId, oneDone.sessionId);
    const tie = new Date(Date.now() - 1000).toISOString();
    for (const id of [one.id, child.id]) { const persisted = await getJob({ workspace: unique.workspace, jobId: id }); await writeFile(path.join(jobDir(unique.stateRoot, unique.workspace, id), 'job.json'), JSON.stringify({ ...persisted, createdAt: tie, updatedAt: tie }) + '\n', { mode: 0o600 }); }
    const next = await followupJob({ workspace: unique.workspace, brief: briefFor('resume', 'tie-selected') });
    assert.equal(next.parentJobId, child.id); assert.equal(next.sessionId, childDone.sessionId);
    await waitForJob({ workspace: unique.workspace, jobId: next.id, timeoutMs: 30000 });
  } finally { await cleanup(unique); }
});

test('a killed client leaves its detached worker alive', async () => {
  const value = await setup(); const marker = path.join(value.markerDir, 'ready');
  const child = clientProcess(value.stateRoot, { CLAUDE_CONFIG_DIR: path.join(value.stateRoot, 'company'), OMP_JOB_FIXTURE_READY_FILE: marker }, ['start', JSON.stringify({ workspace: value.workspace, brief: briefFor('hold') }), '--stay']);
  let stdout = ''; child.stdout?.setEncoding('utf8');
  const resultPromise = new Promise((resolve, reject) => {
    child.stdout?.on('data', (chunk) => { stdout += chunk; const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1); if (line) { try { resolve(JSON.parse(line)); } catch (error) { reject(error); } } });
    child.once('error', reject);
  });
  try {
    const result = await resultPromise; assert.equal(result.ok, true, stdout); await waitForFile(marker); child.kill('SIGKILL');
    assert.ok(['starting', 'running'].includes((await getJob({ workspace: value.workspace, jobId: result.result.id })).status));
    await requestCancel({ workspace: value.workspace, jobId: result.result.id });
    assert.equal((await waitForJob({ workspace: value.workspace, jobId: result.result.id, timeoutMs: 30000 })).status, 'cancelled');
  } finally { if (child.exitCode === null) child.kill('SIGKILL'); await cleanup(value); }
});

test('doctor refuses live groups and mismatched lock nonce, then recovers a confirmed orphan', async () => {
  const value = await setup(); const marker = path.join(value.markerDir, 'ready');
  const previous = process.env.OMP_JOB_FIXTURE_READY_FILE; process.env.OMP_JOB_FIXTURE_READY_FILE = marker;
  try {
    const held = await startJob({ workspace: value.workspace, brief: briefFor('hold') }); await waitForFile(marker);
    const active = await waitForChildIdentity(value.workspace, held.id);
    process.kill(active.ownerPid, 'SIGKILL'); await waitForPidGone(active.ownerPid);
    const stale = structuredClone(active); stale.heartbeatAt = new Date(Date.now() - 60000).toISOString();
    await writeFile(path.join(jobDir(value.stateRoot, value.workspace, held.id), 'job.json'), JSON.stringify(stale) + '\n', { mode: 0o600 });
    await rejectsCode(doctor({ workspace: value.workspace, recover: held.id }), 'RECOVERY_UNSAFE');
    assert.equal(groupGone(active.childPgid), false); process.kill(-active.childPgid, 'SIGKILL');
    const deadline = Date.now() + 5000; while (Date.now() < deadline && !groupGone(active.childPgid)) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(groupGone(active.childPgid), true);
    const recovered = await doctor({ workspace: value.workspace, recover: held.id }); assert.equal(recovered.job?.status ?? recovered.status, 'interrupted');
    assert.equal((await getJob({ workspace: value.workspace, jobId: held.id })).status, 'interrupted');

    const secondMarker = path.join(value.markerDir, 'ready-second'); process.env.OMP_JOB_FIXTURE_READY_FILE = secondMarker;
    const second = await startJob({ workspace: value.workspace, brief: briefFor('hold') }); await waitForFile(secondMarker);
    const secondActive = await waitForChildIdentity(value.workspace, second.id);
    process.kill(secondActive.ownerPid, 'SIGKILL'); await waitForPidGone(secondActive.ownerPid); const secondStale = structuredClone(secondActive); secondStale.heartbeatAt = new Date(Date.now() - 60000).toISOString();
    await writeFile(path.join(jobDir(value.stateRoot, value.workspace, second.id), 'job.json'), JSON.stringify(secondStale) + '\n', { mode: 0o600 }); process.kill(-secondActive.childPgid, 'SIGKILL');
    const secondDeadline = Date.now() + 5000; while (Date.now() < secondDeadline && !groupGone(secondActive.childPgid)) await new Promise((resolve) => setTimeout(resolve, 20));
    const lockHash = createHash('sha256').update(path.resolve(value.workspace)).digest('hex');
    const lockFiles = await lockMetadataFiles(path.join(value.stateRoot, 'locks', lockHash));
    assert.ok(lockFiles.length, 'lock owner metadata should be persisted');
    const lockFile = lockFiles[0]; const owner = JSON.parse(await readFile(lockFile, 'utf8')); const originalNonce = owner.nonce; owner.nonce = randomUUID();
    await writeFile(lockFile, JSON.stringify(owner) + '\n', { mode: 0o600 }); await rejectsCode(doctor({ workspace: value.workspace, recover: second.id }), 'RECOVERY_UNSAFE');
    owner.nonce = originalNonce; await writeFile(lockFile, JSON.stringify(owner) + '\n', { mode: 0o600 });
    const secondRecovered = await doctor({ workspace: value.workspace, recover: second.id });
    assert.equal(secondRecovered.job?.status ?? secondRecovered.status, 'interrupted');
  } finally {
    if (previous === undefined) delete process.env.OMP_JOB_FIXTURE_READY_FILE; else process.env.OMP_JOB_FIXTURE_READY_FILE = previous;
    await cleanup(value);
  }
});

test('doctor diagnoses and recovers a terminal job with a retained workspace lock', async () => {
  const value = await setup();
  try {
    const started = await startJob({ workspace: value.workspace, brief: briefFor('success', 'terminal-lock') });
    const done = await waitForJob({ workspace: value.workspace, jobId: started.id, timeoutMs: 30000 });
    assert.equal(done.status, 'completed');
    const lockDir = path.join(value.stateRoot, 'locks', createHash('sha256').update(path.resolve(value.workspace)).digest('hex'));
    // Terminal state is published before lock cleanup; inject a retained lock only after cleanup finishes.
    const cleanupDeadline = Date.now() + 15000;
    while (Date.now() < cleanupDeadline) { try { await access(lockDir); } catch (error) { if (error.code === 'ENOENT') break; throw error; } await new Promise(resolve => setTimeout(resolve, 20)); }
    await mkdir(lockDir, { mode: 0o700 });
    await writeFile(path.join(lockDir, 'lock.json'), JSON.stringify({ version: 1, nonce: done.workerNonce, jobId: done.id, lockKey: done.lockKey, pid: 999999, createdAt: new Date().toISOString() }) + '\n', { mode: 0o600 });
    const diagnosed = await doctor({ workspace: value.workspace });
    const retained = diagnosed.diagnostics.find((item) => item.id === done.id && item.terminal);
    assert.equal(retained?.recoveryEligible, true);
    const recovered = await doctor({ workspace: value.workspace, recover: done.id });
    assert.equal(recovered.job?.status ?? recovered.status, 'completed');
    await assert.rejects(access(path.join(lockDir, 'lock.json')));
  } finally { await cleanup(value); }
});

test('company and personal Claude profiles see the same jobs, and empty cancel is null', async () => {
  const value = await setup();
  try {
    const created = await clientResult(clientProcess(value.stateRoot, { CLAUDE_CONFIG_DIR: path.join(value.stateRoot, 'company') }, ['start', JSON.stringify({ workspace: value.workspace, brief: briefFor('success', 'COMPANY') })]));
    assert.equal(created.ok, true, JSON.stringify(created)); const done = await waitForJob({ workspace: value.workspace, jobId: created.result.id, timeoutMs: 30000 });
    const observed = await clientResult(clientProcess(value.stateRoot, { CLAUDE_CONFIG_DIR: path.join(value.stateRoot, 'personal') }, ['status', JSON.stringify({ workspace: value.workspace })]));
    assert.equal(observed.ok, true, JSON.stringify(observed)); assert.ok(observed.result.some((job) => job.id === done.id));
    const unchanged = await requestCancel({ workspace: value.workspace, jobId: done.id });
    assert.equal(unchanged.id, done.id);
    assert.equal(unchanged.status, 'completed');
  } finally { await cleanup(value); }
  const empty = await setup(); try { assert.equal(await requestCancel({ workspace: empty.workspace }), null); await rejectsCode(doctor({ workspace: empty.workspace, recover: randomUUID() }), 'NOT_FOUND'); } finally { await cleanup(empty); }
});

test('lock-release failure preserves terminal result and refuses later artifact overwrite',async()=>{
 const value=await setup();const marker=path.join(value.markerDir,'ready-release-failure');const previous=process.env.OMP_JOB_FIXTURE_READY_FILE;process.env.OMP_JOB_FIXTURE_READY_FILE=marker;
 let lockDir,backup;
 try{
  const started=await startJob({workspace:value.workspace,brief:briefFor('hold')});await waitForFile(marker);await waitForChildIdentity(value.workspace,started.id);
  lockDir=path.join(value.stateRoot,'locks',createHash('sha256').update(path.resolve(value.workspace)).digest('hex'));backup=lockDir+'.owned-backup';await rename(lockDir,backup);await symlink(backup,lockDir,'dir');
  await requestCancel({workspace:value.workspace,jobId:started.id});const done=await waitForJob({workspace:value.workspace,jobId:started.id,timeoutMs:15000});assert.equal(done.status,'cancelled');
  const dir=jobDir(value.stateRoot,value.workspace,done.id);const artifactPath=path.join(dir,'result.json');const original=await readFile(artifactPath,'utf8');assert.equal(JSON.parse(original).run.status,'cancelled');
  await writeWorkerResultArtifact(dir,done.workerNonce,{run:{status:'failed'},evidence:'must-not-replace'});assert.equal(await readFile(artifactPath,'utf8'),original);
  const persisted=await getJob({workspace:value.workspace,jobId:done.id});assert.equal(persisted.status,'cancelled');assert.ok(persisted.warnings.some(w=>w.includes('lock cleanup failed')));
  await removeTree(lockDir);await rename(backup,lockDir);backup=undefined;await doctor({workspace:value.workspace,recover:done.id});
 }finally{
  if(backup){await removeTree(lockDir,{force:true});await rename(backup,lockDir);}
  if(previous===undefined)delete process.env.OMP_JOB_FIXTURE_READY_FILE;else process.env.OMP_JOB_FIXTURE_READY_FILE=previous;await cleanup(value);
 }
});

test('worker rejects executable drift and restricts diagnostics without losing error context',async()=>{
 const value=await setup();let originalConfig;
 try{
  const started=await startJob({workspace:value.workspace,brief:briefFor('success')});const done=await waitForJob({workspace:value.workspace,jobId:started.id,timeoutMs:30000});assert.equal(done.status,'completed');
  const dir=jobDir(value.stateRoot,value.workspace,done.id);const secret='synthetic-'+randomUUID();await writeWorkerStderr(dir,done.workerNonce,'Authorization: Bearer '+secret+'\napi_key="'+secret+'"\nHTTP 401: request rejected');const diagnostic=await readFile(path.join(dir,'stderr.log'),'utf8');assert.ok(!diagnostic.includes(secret));assert.ok(diagnostic.includes('HTTP 401: request rejected'));assert.equal((await stat(path.join(dir,'stderr.log'))).mode&0o777,0o600);assert.equal(done.result.stderr,undefined);
  const configPath=path.join(value.stateRoot,'config.json');originalConfig=await readFile(configPath,'utf8');const alternate=path.join(value.markerDir,'alternate-omp.mjs');await copyFile(FIXTURE,alternate);await chmod(alternate,0o755);await writeFile(configPath,JSON.stringify({version:1,executable:alternate}),{mode:0o600});await rejectsCode(workerExecutable(value.workspace,done.executable),'STATE_CORRUPT');
 }finally{if(originalConfig)await writeFile(path.join(value.stateRoot,'config.json'),originalConfig,{mode:0o600});await cleanup(value);}
});
