import assert from 'node:assert/strict';
import { test, before } from 'node:test';
import { chmod, mkdtemp, mkdir, readFile, rm, stat, access, realpath, copyFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEventState, messageText, reduceOmpEvent, runOmpProcess } from '../src/runner.js';
import { DelegateError, LIMITS } from '../src/contracts.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'fake-omp.mjs');
const REAL_FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'omp-real-18.3.0.jsonl');

before(async () => {
  // The fake uses a portable env-based Node shebang, so executable mode is the only
  // platform-dependent setup needed by the spawn boundary.
  await chmod(FIXTURE, 0o755);
});

async function withTempRun(prompt, options, callback) {
  const workspace = await mkdtemp(path.join(tmpdir(), 'omp-runner-'));
  const sessionDir = path.join(workspace, 'sessions');
  await mkdir(sessionDir);
  try {
    const result = await runOmpProcess({
      executable: FIXTURE,
      cwd: workspace,
      sessionDir,
      prompt,
      model: 'openai-codex/fake-18.3',
      thinking: 'low',
      startupMs: 1000,
      termMs: 100,
      killMs: 1000,
      ...options,
    });
    return await callback({ result, workspace, sessionDir });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function waitForFile(file, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(file, constants.F_OK);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  assert.fail(`timed out waiting for ${file}`);
}

function pidIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function waitForDead(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidIsAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`process ${pid} survived termination deadline`);
}

function reduceEvents(events) {
  const state = createEventState();
  for (const event of events) reduceOmpEvent(state, event);
  return state;
}

function readFixtureRuns() {
  return readFile(REAL_FIXTURE, 'utf8').then((text) => {
    const events = text.trim().split(/\r?\n/).map((line) => JSON.parse(line));
    const runs = [];
    let current = [];
    for (const event of events) {
      if (event.type === 'session' && current.length) {
        runs.push(current);
        current = [];
      }
      current.push(event);
    }
    if (current.length) runs.push(current);
    return runs;
  });
}

test('reduces sanitized OMP 18.3 JSONL and preserves retry/error/nonterminal proof', async () => {
  const [firstRun, secondRun] = await readFixtureRuns();
  const first = reduceEvents(firstRun);
  assert.equal(first.sessionId, '<redacted-id>');
  assert.equal(first.terminal, true);
  assert.equal(messageText(first.assistant), 'OMP_CHILD_OK');
  assert.equal(first.assistant.stopReason, 'stop');
  assert.ok(first.terminalSequence > first.assistantSequence);

  const resumed = reduceEvents(secondRun);
  assert.equal(resumed.sessionId, '<redacted-id>');
  assert.equal(messageText(resumed.assistant), 'OMP_RESUME_OK:OMP_DECISION_READ_ONLY');
  assert.equal(resumed.terminal, true);

  const retry = reduceEvents([
    { type: 'session', version: 3, id: 'retry' },
    { type: 'agent_start' },
    { type: 'error', message: 'temporary transport failure' },
    { type: 'agent_end', isTerminal: false },
    { type: 'agent_start' },
    { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], stopReason: 'stop' } },
    { type: 'agent_end', isTerminal: true },
  ]);
  assert.equal(retry.terminal, true);
  assert.equal(messageText(retry.assistant), 'ok');

  const nonterminal = reduceEvents([
    { type: 'session', version: 3, id: 'nonterminal' },
    { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'partial' }], stopReason: 'stop' } },
    { type: 'agent_end', isTerminal: false },
  ]);
  assert.equal(nonterminal.terminal, false);
  assert.equal(messageText(nonterminal.assistant), 'partial');

  const missingFinal = reduceEvents([
    { type: 'session', version: 3, id: 'missing-final' },
    { type: 'agent_end', isTerminal: true },
  ]);
  assert.equal(missingFinal.terminal, true);
  assert.equal(missingFinal.assistant, undefined);

  const error = reduceEvents([
    { type: 'session', version: 3, id: 'error' },
    { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'failed' }], stopReason: 'error' } },
    { type: 'agent_end', isTerminal: true },
  ]);
  assert.equal(error.terminal, true);
  assert.equal(error.assistant.stopReason, 'error');

  const mismatch = createEventState();
  reduceOmpEvent(mismatch, { type: 'session', version: 3, id: 'one' });
  assert.throws(
    () => reduceOmpEvent(mismatch, { type: 'session', version: 3, id: 'two' }),
    (thrown) => thrown instanceof DelegateError && thrown.code === 'SESSION_INVALID',
  );
});

test('accepts a real fixture-shaped terminal run and requires title/header session proof', async () => {
  await withTempRun('success', {}, async ({ result, sessionDir }) => {
    assert.equal(result.status, 'completed');
    assert.equal(result.text, 'FAKE_OK');
    assert.equal(result.error, undefined);
    assert.ok(result.sessionId);
    assert.ok(result.sessionFile);
    const session = await readFile(result.sessionFile, 'utf8');
    const [title, header] = session.trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(title.type, 'title');
    assert.equal(header.type, 'session');
    assert.equal(header.version, 3);
    assert.equal(header.id, result.sessionId);
    assert.equal(path.dirname(result.sessionFile), await realpath(sessionDir));
    assert.equal((await stat(result.sessionFile)).isFile(), true);
  });
});

test('rejects malformed, oversize, and truncated UTF-8 JSONL as protocol errors', async () => {
  for (const mode of ['malformed', 'oversize', 'truncated-utf8']) {
    await withTempRun(mode, {}, async ({ result }) => {
      assert.equal(result.status, 'failed', mode);
      assert.equal(result.error?.code, 'PROTOCOL_ERROR', mode);
      assert.equal(result.terminationConfirmed, true, mode);
    });
  }
});

test('rejects terminal error, nonterminal, and missing-final output', async () => {
  for (const mode of ['error', 'nonterminal', 'missing-final']) {
    await withTempRun(mode, {}, async ({ result }) => {
      assert.equal(result.status, 'failed', mode);
      assert.equal(result.error?.code, 'OUTPUT_INCOMPLETE', mode);
      assert.equal(result.terminationConfirmed, true, mode);
    });
  }
});

test('accepts a retry after a transient error event', async () => {
  await withTempRun('retry', {}, async ({ result }) => {
    assert.equal(result.status, 'completed');
    assert.equal(result.text, 'RETRY_OK');
    assert.equal(result.error, undefined);
    assert.equal(result.modelActual, 'openai-codex/fake-18.3');
  });
});

test('rejects missing session files and mismatched session headers', async () => {
  for (const mode of ['missing-session', 'session-mismatch']) {
    await withTempRun(mode, {}, async ({ result }) => {
      assert.equal(result.status, 'failed', mode);
      assert.equal(result.error?.code, 'SESSION_INVALID', mode);
    });
  }
});

test('bounds stderr to the configured tail and handles a child stdin EPIPE', async () => {
  await withTempRun('stderr-bounds', {}, async ({ result }) => {
    assert.equal(result.status, 'failed');
    assert.equal(result.error?.code, 'PROCESS_FAILED');
    assert.equal(result.exitCode, 7);
    assert.equal(Buffer.byteLength(result.stderr), LIMITS.stderrBytes);
    assert.match(result.stderr, /STDERR_END$/);
  });

  await withTempRun(`epipe\n${'payload '.repeat(1024 * 1024)}`, { startupMs: 2000 }, async ({ result }) => {
    assert.equal(result.status, 'failed');
    assert.equal(result.error?.code, 'PROCESS_FAILED');
    assert.match(result.error?.message ?? '', /EPIPE/i);
  });
});

test('reports a missing executable without throwing from the subprocess boundary', async () => {
  await withTempRun('missing-executable', { executable: path.join(path.dirname(FIXTURE), 'does-not-exist') }, async ({ result }) => {
    assert.equal(result.status, 'failed');
    assert.equal(result.error?.code, 'PROCESS_FAILED');
    assert.match(result.error?.message ?? '', /ENOENT|not found/i);
  });
});

test('cancels a real grandchild by process group and confirms termination', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'omp-runner-tree-'));
  const sessionDir = path.join(workspace, 'sessions');
  const pidFile = path.join(workspace, 'grandchild.pid');
  await mkdir(sessionDir);
  const controller = new AbortController();
  let leaderPid;
  try {
    const runPromise = runOmpProcess({
      executable: FIXTURE,
      cwd: workspace,
      sessionDir,
      prompt: `grandchild\n${pidFile}`,
      model: 'openai-codex/fake-18.3',
      thinking: 'low',
      signal: controller.signal,
      onSpawn: (pid) => { leaderPid = pid; },
      startupMs: 1000,
      termMs: 50,
      killMs: 1000,
    });
    await waitForFile(pidFile);
    assert.ok(leaderPid && pidIsAlive(leaderPid), 'detached OMP leader should be alive');
    const grandchildPid = Number((await readFile(pidFile, 'utf8')).trim());
    assert.ok(Number.isInteger(grandchildPid) && pidIsAlive(grandchildPid), 'grandchild should be alive before cancellation');
    controller.abort();
    const result = await runPromise;
    assert.equal(result.status, 'cancelled');
    assert.equal(result.terminationConfirmed, true);
    await waitForDead(grandchildPid);
    assert.equal(pidIsAlive(leaderPid), false, 'leader should be terminated');
  } finally {
    if (leaderPid && pidIsAlive(leaderPid)) {
      try { process.kill(-leaderPid, 'SIGKILL'); } catch {}
    }
    await rm(workspace, { recursive: true, force: true });
  }
});

test('returns cancellation without spawning when already aborted', async () => {
  const controller = new AbortController();
  controller.abort();
  await withTempRun('success', { signal: controller.signal }, async ({ result }) => {
    assert.equal(result.status, 'cancelled');
    assert.equal(result.terminationConfirmed, true);
    assert.equal(result.exitCode, null);
  });
});


test('does not claim cancellation when the live process group cannot be signalled', async () => {
  const workspace = await realpath(await mkdtemp(path.join(tmpdir(), 'omp-runner-denied-')));
  const sessionDir = path.join(workspace, 'sessions');
  const pidFile = path.join(workspace, 'grandchild.pid');
  await mkdir(sessionDir);
  const controller = new AbortController();
  const actualKill = process.kill.bind(process);
  let leaderPid;
  try {
    const running = runOmpProcess({executable:FIXTURE,cwd:workspace,sessionDir,prompt:'grandchild\n'+pidFile,signal:controller.signal,onSpawn:pid=>{leaderPid=pid;},termMs:30,killMs:70});
    await waitForFile(pidFile);
    process.kill = (pid, signal) => {
      if(pid===-leaderPid && signal!==0)throw Object.assign(new Error('fixture signal permission denied'),{code:'EPERM'});
      return actualKill(pid,signal);
    };
    controller.abort();
    const result=await running;
    assert.equal(result.status,'failed');
    assert.equal(result.error.code,'CANCEL_UNCONFIRMED');
    assert.equal(result.terminationConfirmed,false);
    assert.equal(pidIsAlive(leaderPid),true);
  } finally {
    process.kill=actualKill;
    if(leaderPid){try{actualKill(-leaderPid,'SIGKILL');}catch{}}
    if(leaderPid)await waitForDead(leaderPid);
    await rm(workspace,{recursive:true,force:true});
  }
});

test('known malformed lifecycle events fail closed but legacy absent terminal flag uses order',()=>{
 for(const event of [{type:'session',version:99,id:'wrong-version'},{type:'tool_execution_start',toolName:'eval'},{type:'tool_execution_end',toolCallId:'unmatched',isError:false},{type:'agent_end',isTerminal:'false'},{type:'message_end',message:{role:'assistant',content:[{type:'text',text:42}],stopReason:'stop'}}])assert.throws(()=>reduceOmpEvent(createEventState(),event),{code:'PROTOCOL_ERROR'});
 const legacy=createEventState();reduceOmpEvent(legacy,{type:'message_end',message:{role:'assistant',content:[{type:'text',text:'legacy final'}],stopReason:'stop'}});reduceOmpEvent(legacy,{type:'agent_end'});assert.equal(legacy.terminal,true);assert.ok(legacy.terminalSequence>legacy.assistantSequence);
});

test('unknown events do not disable the session startup deadline', async()=>{
 const controller=new AbortController();const cleanup=setTimeout(()=>controller.abort(),3000);let observed=false;
 try{await withTempRun('unknown-startup',{signal:controller.signal,onEvent:event=>{if(event.type==='unknown_future_event')observed=true;}},({result})=>{
  assert.equal(observed,true);assert.equal(result.status,'failed');assert.equal(result.error.code,'STARTUP_TIMEOUT');assert.equal(result.terminationConfirmed,true);
 });}finally{clearTimeout(cleanup);}
});

test('resume pins the recorded transcript and rejects same-id duplicates before spawning',async()=>{
 await withTempRun('ok',{},async({result,workspace,sessionDir})=>{
  const duplicate=path.join(sessionDir,'duplicate.jsonl');await copyFile(result.sessionFile,duplicate);let spawned=false;
  const options={executable:FIXTURE,cwd:workspace,sessionDir,sessionId:result.sessionId,sessionFile:result.sessionFile,prompt:'ok',onSpawn:()=>{spawned=true;}};
  const ambiguous=await runOmpProcess(options);assert.equal(ambiguous.error.code,'RESUME_FAILED');assert.equal(spawned,false);
  await rm(result.sessionFile);
  const replaced=await runOmpProcess(options);assert.equal(replaced.error.code,'RESUME_FAILED');assert.equal(spawned,false);
 });
});

test('retired process groups are never signalled while escaped stdio remains unconfirmed',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'omp-escaped-'));const pidFile=path.join(dir,'pid');const controller=new AbortController();const originalKill=process.kill;let leader;let escaped;const signals=[];
 process.kill=function(pid,signal){if(pid===-leader&&signal!==0)signals.push(signal);return originalKill(pid,signal);};
 try{
  await withTempRun('escaped-stdio\n'+pidFile,{signal:controller.signal,termMs:30,killMs:100,onSpawn:pid=>{leader=pid;void(async()=>{await waitForFile(pidFile);escaped=Number(await readFile(pidFile,'utf8'));await waitForDead(pid);controller.abort();})();}},({result})=>{
   assert.equal(result.error.code,'CANCEL_UNCONFIRMED');assert.equal(result.terminationConfirmed,false);assert.deepEqual(signals,[]);
  });
 }finally{process.kill=originalKill;if(escaped){originalKill(-escaped,'SIGKILL');await waitForDead(escaped);}await rm(dir,{recursive:true,force:true});}
});
