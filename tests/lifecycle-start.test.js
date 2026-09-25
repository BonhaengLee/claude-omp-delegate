import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, readdir, realpath, rm as removeTree, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { doctor, getJob, listJobs, sanitizeDelegateEvent } from '../src/jobs.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE = process.execPath;
const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'job-omp.mjs');
const JOBS = path.join(ROOT, 'src', 'jobs.js');
const BASE_BRIEF = { decisions: 'Keep the test deterministic.', writeScope: ['fixture-only-output'], acceptance: ['the worker reports lifecycle evidence'], constraints: ['do not reset or stash'], verification: ['read persisted job and artifacts'] };
const brief = (mode) => ({ goal: 'JOB_FIXTURE_MODE=' + mode, ...BASE_BRIEF });
const hash = (value) => createHash('sha256').update(value).digest('hex');
async function setup() {
  const previousStateRoot = process.env.OMP_DELEGATE_STATE_DIR;
  const stateRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'omp-lifecycle-state-')));
  const workspace = await realpath(await mkdtemp(path.join(os.tmpdir(), 'omp-lifecycle-workspace-')));
  await writeFile(path.join(stateRoot, 'config.json'), JSON.stringify({ version: 1, executable: FIXTURE }) + '\n', { mode: 0o600 });
  process.env.OMP_DELEGATE_STATE_DIR = stateRoot;
  return { stateRoot, workspace, previousStateRoot };
}
async function cleanup(value) { await removeTree(value.stateRoot, { recursive: true, force: true }); await removeTree(value.workspace, { recursive: true, force: true }); if (value.previousStateRoot === undefined) Reflect.deleteProperty(process.env, 'OMP_DELEGATE_STATE_DIR'); else process.env.OMP_DELEGATE_STATE_DIR = value.previousStateRoot; }
async function runClient(value, wrapper, payload, extra = {}) {
  const code = 'import { startJob } from ' + JSON.stringify(JOBS) + '; Object.defineProperty(process,\'execPath\',{value:process.env.WRAPPER}); try { const result=await startJob(JSON.parse(process.env.PAYLOAD)); process.stdout.write(JSON.stringify({ok:true,result})+\'\\n\'); } catch (error) { process.stdout.write(JSON.stringify({ok:false,error:{code:error?.code,message:error?.message}})+\'\\n\'); process.exitCode=2; }';
  const child = spawn(NODE, ['--input-type=module', '-e', code], { cwd: ROOT, env: { ...process.env, ...extra, OMP_DELEGATE_STATE_DIR: value.stateRoot, OMP_DELEGATE_DEPTH: '0', WRAPPER: wrapper, PAYLOAD: JSON.stringify(payload) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = ''; child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8'); child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1); assert.ok(line, 'client output missing (stderr: ' + stderr + ')'); return { child, exitCode, stderr, ...JSON.parse(line) };
}
async function waitTerminal(workspace, id, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const job = await getJob({ workspace, jobId: id }); if (['completed', 'failed', 'cancelled', 'interrupted'].includes(job.status)) return job; await new Promise((resolve) => setTimeout(resolve, 100)); }
  assert.fail('job did not become terminal: ' + id);
}
async function wrapperFile(value, body, name) {
  const file = path.join(value.stateRoot, name + '.mjs'); await writeFile(file, '#!' + NODE + '\n' + body + '\n', { mode: 0o700 }); await chmod(file, 0o700); return file;
}

test('stale starting handoff is interrupted and late worker cannot spawn OMP', { concurrency: false }, async () => {
  const value = await setup(); const marker = path.join(value.stateRoot, 'omp-spawned');
  const delayed = await wrapperFile(value, 'import { spawn } from \'node:child_process\';\nconst [worker, ...args] = process.argv.slice(2);\nsetTimeout(() => { const child = spawn(process.execPath, [worker, ...args], { stdio: \'inherit\' }); child.on(\'exit\', (code, signal) => process.exit(code ?? (signal ? 143 : 1))); }, 7000);', 'delayed-handoff');
  let client;
  try {
    const code = 'import { startJob } from ' + JSON.stringify(JOBS) + '; Object.defineProperty(process,\'execPath\',{value:process.env.WRAPPER}); try { await startJob(JSON.parse(process.env.PAYLOAD)); } catch {} setInterval(()=>{},1000);';
    client = spawn(NODE, ['--input-type=module', '-e', code], { cwd: ROOT, env: { ...process.env, OMP_DELEGATE_STATE_DIR: value.stateRoot, OMP_DELEGATE_DEPTH: '0', WRAPPER: delayed, PAYLOAD: JSON.stringify({ workspace: value.workspace, brief: brief('success') }), OMP_JOB_FIXTURE_SPAWNED_FILE: marker }, stdio: ['ignore', 'ignore', 'ignore'] });
    let started; process.env.OMP_DELEGATE_STATE_DIR = value.stateRoot;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) { try { const jobs = await listJobs({ workspace: value.workspace }); if (jobs.length) { started = jobs[0]; break; } } catch {} await new Promise((resolve) => setTimeout(resolve, 25)); }
    assert.ok(started, 'starting handoff was not published'); client.kill('SIGKILL'); await new Promise((resolve) => setTimeout(resolve, 100));
    const stale = { ...started, createdAt: new Date(Date.now() - 60000).toISOString() }; const file = path.join(value.stateRoot, 'workspaces', hash(path.resolve(value.workspace)), 'jobs', started.id, 'job.json'); await writeFile(file, JSON.stringify(stale) + '\n', { mode: 0o600 });
    const diagnosed = await doctor({ workspace: value.workspace }); assert.equal(diagnosed.diagnostics[0].recoveryEligible, true);
    const recovered = await doctor({ workspace: value.workspace, recover: started.id }); assert.equal(recovered.status ?? recovered.job?.status, 'interrupted');
    await new Promise((resolve) => setTimeout(resolve, 8000));
    await assert.rejects(readFile(marker, 'utf8')); assert.equal((await getJob({ workspace: value.workspace, jobId: started.id })).status, 'interrupted');
  } finally { if (client && client.exitCode === null) client.kill('SIGKILL'); await cleanup(value); }
});

test('startup failure terminalizes and late worker timeout retains handoff', { concurrency: false }, async () => {
  const value = await setup();
  try {
    const missing = await runClient(value, path.join(value.stateRoot, 'does-not-exist-node'), { workspace: value.workspace, brief: brief('success') });
    assert.equal(missing.ok, false); assert.equal(missing.error.code, 'WORKER_NOT_READY');
    const failed = (await listJobs({ workspace: value.workspace }))[0]; assert.equal(failed.status, 'failed'); assert.equal(failed.error.code, 'WORKER_NOT_READY');
    const failedResult = path.join(value.stateRoot, 'workspaces', hash(path.resolve(value.workspace)), 'jobs', failed.id, 'result.json'); await readFile(failedResult, 'utf8');
    assert.equal((await readdir(path.join(value.stateRoot, 'locks'))).length, 0);
    const delayed = await wrapperFile(value, 'import { spawn } from \'node:child_process\';\nconst [worker, ...args] = process.argv.slice(2);\nsetTimeout(() => { const child = spawn(process.execPath, [worker, ...args], { stdio: \'inherit\' }); child.on(\'exit\', (code, signal) => process.exit(code ?? (signal ? 143 : 1))); }, 7000);', 'delayed-worker');
    const late = await runClient(value, delayed, { workspace: value.workspace, brief: brief('success') });
    assert.equal(late.ok, false); assert.equal(late.error.code, 'WORKER_NOT_READY');
    const lateJob = (await listJobs({ workspace: value.workspace })).find((job) => job.id !== failed.id); assert.ok(lateJob); assert.ok(['starting', 'running', 'completed'].includes(lateJob.status));
    assert.equal((await waitTerminal(value.workspace, lateJob.id, 15000)).status, 'completed');
    const brokenInit = await wrapperFile(value, 'import { spawn } from \'node:child_process\';\nimport { writeFile } from \'node:fs/promises\';\nconst [worker, ...args] = process.argv.slice(2);\nconst index = args.indexOf(\'--job-dir\');\nawait writeFile(args[index + 1] + \'/cancel.json\', \'{broken\', { mode: 0o600 });\nconst child = spawn(process.execPath, [worker, ...args], { stdio: \'inherit\' });\nchild.on(\'exit\', (code, signal) => process.exit(code ?? (signal ? 143 : 1)));', 'broken-init');
    const init = await runClient(value, brokenInit, { workspace: value.workspace, brief: brief('success') });
    assert.equal(init.ok, false); assert.equal(init.error.code, 'WORKER_NOT_READY');
    let initJob = (await listJobs({ workspace: value.workspace })).find((job) => job.id !== failed.id && job.id !== lateJob.id); assert.ok(initJob); initJob = await waitTerminal(value.workspace, initJob.id, 10000); assert.equal(initJob.status, 'failed'); assert.equal(initJob.error.code, 'STATE_CORRUPT');
    await readFile(path.join(value.stateRoot, 'workspaces', hash(path.resolve(value.workspace)), 'jobs', initJob.id, 'result.json'), 'utf8');
  } finally { await cleanup(value); }
});




test('event sanitizer preserves lifecycle evidence without provider secrets or reasoning', () => {
  const value = sanitizeDelegateEvent({ type: 'message_end', provider: 'openai-codex', model: 'gpt-6-astra', thinkingLevel: 'high', credentialId: 'secret', encryptedThinking: 'secret', message: { role: 'assistant', content: [{ type: 'reasoning', text: 'private' }, { type: 'text', text: 'visible' }], metadata: { providerCredentialId: 'secret' } } });
  assert.equal(value.type, 'message_end');
  assert.equal(value.model, 'gpt-6-astra');
  assert.equal(value.thinkingLevel, 'high');
  assert.equal(value.credentialId, undefined);
  assert.equal(value.encryptedThinking, undefined);
  assert.deepEqual(value.message.content, [{ type: 'text', text: 'visible' }]);
  assert.deepEqual(value.message.metadata, {});
});
