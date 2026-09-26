// @ts-check
/** Detached durable worker. The client process is never its owner. */
import { runOmpProcess } from './runner.js';
import { DelegateError, LIMITS, TERMINAL, addUsage, emptyUsage } from './contracts.js';
import { appendWorkerEvents, cancellationRequested, collectAfterEvidence, commitWorkerResult, initializeWorker, loadWorkerJob, sanitizeDelegateEvent, terminalizeWorkerFailure, readBaseline, readBrief, workerExecutable, writeWorkerResultArtifact, writeWorkerStderr, workerPatch } from './jobs.js';

const EVENT_BATCH_MAX = 256;
const EVENT_BATCH_BYTES = 64 * 1024;
const EVENT_FLUSH_MS = 25;

/** @param {unknown} error */
function errorObject(error) {
  if (error instanceof DelegateError) return { code: error.code, message: error.message };
  return { code: 'PROCESS_FAILED', message: String(error) };
}
/** @param {import('./contracts.js').Brief} brief */
function promptFor(brief) {
  return [
    'You are the delegated OMP worker. Preserve existing user changes. Do not commit, reset, stash, or revert unrelated changes.',
    'writeScope is intent and review guidance, not an operating-system sandbox.',
    'Complete the requested goal and leave a concise final answer with changed files and observed verification evidence.',
    'Goal:\n' + brief.goal,
    'Decisions:\n' + brief.decisions,
    'Write scope:\n' + brief.writeScope.join('\n'),
    'Acceptance:\n' + brief.acceptance.join('\n'),
    'Constraints:\n' + brief.constraints.join('\n'),
    'Verification:\n' + brief.verification.join('\n'),
  ].join('\n\n');
}
/** @param {string} jobDir */
export async function runWorker(jobDir) {
  /** @type {import('./contracts.js').Job|undefined} */ let job;
  let nonce;
  try {
    job = await loadWorkerJob(jobDir);
    nonce = job.workerNonce;
    job = await initializeWorker(jobDir, job);
  } catch (error) {
    if (nonce) await terminalizeWorkerFailure(jobDir, nonce, error).catch(() => {});
    throw error;
  }
  if (!job || !nonce) throw new DelegateError('WORKER_NOT_READY', 'Worker initialization returned no job identity');
  if (TERMINAL.has(job.status)) return job;
  const controller = new AbortController();
  /** @type {NodeJS.Timeout|undefined} */ let heartbeatTimer;
  /** @type {NodeJS.Timeout|undefined} */ let cancelTimer;
  let heartbeatBusy = false;
  let spawned = false;
  let runPromise;
  /** @type {Record<string, unknown>|undefined} */ let runResult;
  /** @type {{code:string,message:string}|undefined} */ let backgroundFailure;
  /** @type {{code:string,message:string}|undefined} */ let finalFailure;
  let signalReceived = false;
  let spawnChain = Promise.resolve();
  /** @type {unknown[]} */ let eventBuffer = [];
  let eventBufferBytes = 0;
  /** @type {Partial<import('./contracts.js').Job>|undefined} */ let eventPatch;
  /** @type {Promise<void>|undefined} */ let eventWritePromise;
  let eventWritesClosed = false;
  /** @type {NodeJS.Timeout|undefined} */ let eventFlushTimer;
  /** @type {Promise<unknown>[]} */ const backgroundTasks = [];
  const track = (/** @type {Promise<unknown>} */ task) => {
    backgroundTasks.push(task);
    void task.finally(() => { const index = backgroundTasks.indexOf(task); if (index >= 0) backgroundTasks.splice(index, 1); }).catch(() => {});
  };
  const failBackground = (/** @type {unknown} */ error) => { if (!backgroundFailure) backgroundFailure = errorObject(error); if (!controller.signal.aborted) controller.abort(); };
  /** Wait for the current write before taking another batch; never queue timed batches behind it. */
  const flushEventBatch = async () => {
    while (eventWritePromise) await eventWritePromise;
    if (eventBuffer.length === 0) return;
    const events = eventBuffer;
    const patch = eventPatch;
    eventBuffer = [];
    eventBufferBytes = 0;
    eventPatch = undefined;
    const task = (async () => {
      await appendWorkerEvents(jobDir, nonce, events);
      if (patch) await workerPatch(jobDir, nonce, patch);
    })();
    eventWritePromise = task;
    try { await task; }
    catch (error) { failBackground(error); throw error; }
    finally { eventWritePromise = undefined; scheduleEventFlush(); }
  };
  const scheduleEventFlush = () => {
    if (eventWritesClosed || backgroundFailure || eventFlushTimer || eventWritePromise || eventBuffer.length === 0) return;
    eventFlushTimer = setTimeout(() => {
      eventFlushTimer = undefined;
      void flushEventBatch().catch(() => {});
    }, EVENT_FLUSH_MS);
  };
  let usageTotal = emptyUsage();
  /** @type {string[]} */ let recent = [];
  const startedAt = Date.now();
  const queueEvent = async (/** @type {any} */ event) => {
    if (backgroundFailure) throw new DelegateError(/** @type {any} */ (backgroundFailure.code), backgroundFailure.message);
    const persisted = sanitizeDelegateEvent(event);
    const serialized = JSON.stringify(persisted);
    if (serialized === undefined) throw new DelegateError('PROTOCOL_ERROR', 'OMP event cannot be serialized');
    eventBuffer.push(persisted);
    eventBufferBytes += Buffer.byteLength(serialized, 'utf8') + 1;
    /** @type {Partial<import('./contracts.js').Job>} */ const patch = { activity: String(event.type ?? 'OMP event') };
    if (event.type === 'tool_execution_start') patch.activity = 'tool: ' + String(event.toolName ?? 'unknown');
    if ((event.type === 'message_start' || event.type === 'message_end') && (event.message?.role === 'assistant' || event.role === 'assistant')) {
      const message = event.message ?? event;
      if (message.provider && message.model) patch.modelActual = String(message.provider) + '/' + String(message.model);
      patch.activity = event.type === 'message_start' ? 'assistant response started' : 'assistant output observed';
      if (event.type === 'message_end' && event.message?.usage) { usageTotal = addUsage(usageTotal, event.message.usage); patch.usage = { ...usageTotal }; }
    }
    if (event.type === 'tool_execution_end') {
      // Tool names and outcomes only: arguments and outputs can carry secrets and stay in the sanitized event log.
      const entry = '+' + Math.round((Date.now() - startedAt) / 1000) + 's ' + String(event.toolName ?? 'tool').slice(0, 64) + ' ' + (event.isError === true ? 'error' : 'ok');
      recent = [...recent, entry].slice(-LIMITS.recentActivity);
      patch.recentActivity = recent;
    }
    eventPatch = { ...(eventPatch ?? {}), ...patch };
    if (eventBuffer.length >= EVENT_BATCH_MAX || eventBufferBytes >= EVENT_BATCH_BYTES) await flushEventBatch();
    else scheduleEventFlush();
  };
  const drainEventWrites = async () => {
    eventWritesClosed = true;
    if (eventFlushTimer) { clearTimeout(eventFlushTimer); eventFlushTimer = undefined; }
    await flushEventBatch();
  };
  const onSignal = () => { signalReceived = true; if (!controller.signal.aborted) controller.abort(); };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
  const heartbeat = () => {
    if (heartbeatBusy) return;
    heartbeatBusy = true;
    const task = workerPatch(jobDir, nonce, { heartbeatAt: new Date().toISOString(), ownerPid: process.pid }).catch((error) => { failBackground(error); }).finally(() => { heartbeatBusy = false; });
    track(task);
  };
  heartbeatTimer = setInterval(heartbeat, LIMITS.heartbeatMs);
  const pollCancel = () => {
    const task = cancellationRequested(jobDir, nonce).then(async (requested) => { if (requested && !controller.signal.aborted) { await workerPatch(jobDir, nonce, { status: 'cancelling', activity: 'cancellation requested' }); controller.abort(); } }).catch((error) => { failBackground(error); });
    track(task);
  };
  cancelTimer = setInterval(pollCancel, LIMITS.cancelPollMs);
  const stopBackground = () => { if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = undefined; } if (cancelTimer) { clearInterval(cancelTimer); cancelTimer = undefined; } if (eventFlushTimer) { clearTimeout(eventFlushTimer); eventFlushTimer = undefined; } };
  try {
    const brief = await readBrief(jobDir);
    const baseline = await readBaseline(jobDir);
    const prompt = promptFor(brief);
    const current = await loadWorkerJob(jobDir);
    if (current.status !== 'cancelling') await workerPatch(jobDir, nonce, { status: 'running', activity: 'starting OMP process' });
    const onEvent = (/** @type {any} */ event) => queueEvent(event);
    const onSpawn = (/** @type {number} */ pid) => {
      spawned = true;
      const task = spawnChain.then(async () => { await workerPatch(jobDir, nonce, { childPgid: pid, activity: 'OMP process started' }); }).catch((error) => { failBackground(error); });
      spawnChain = task;
      void spawnChain.catch(() => {});
    };
    const alreadyCancelled = await cancellationRequested(jobDir, nonce);
    if (alreadyCancelled) {
      runResult = { status: 'cancelled', text: '', stderr: '', exitCode: null, verification: [], terminationConfirmed: true };
    } else {
      runPromise = runOmpProcess({ executable: await workerExecutable(current.workspace, current.executable), cwd: current.workspace, sessionDir: current.sessionDir, sessionId: current.sessionId, sessionFile: current.sessionFile, prompt, model: current.modelRequested, thinking: current.thinking, signal: controller.signal, onEvent, onSpawn });
      try { runResult = await runPromise; }
      catch (error) {
        finalFailure = errorObject(error);
        if (!controller.signal.aborted) controller.abort();
        try { runResult = await runPromise; } catch { /* preserve unknown child termination */ }
      }
    }
    await spawnChain;
    stopBackground();
    await drainEventWrites();
    await Promise.allSettled([...backgroundTasks]);
    if (backgroundFailure) throw new DelegateError(/** @type {any} */ (backgroundFailure.code), backgroundFailure.message);
    const evidence = await collectAfterEvidence(job.workspace, brief.writeScope, baseline);
    const warnings = evidence.outsideWriteScope.length > 0 ? ['Observed changes outside writeScope; no ownership is inferred: ' + evidence.outsideWriteScope.join(', ')] : [];
    if (finalFailure) throw new DelegateError(/** @type {any} */ (finalFailure.code), finalFailure.message);
    if (!runResult) throw new DelegateError('PROCESS_FAILED', 'OMP worker returned no result');
    const { stderr: _stderr, ...runWithoutStderr } = runResult;
    const persistedRun = { ...runWithoutStderr, verification: sanitizeDelegateEvent(runResult.verification) };
    const artifact = { version: 1, jobId: job.id, finalText: runResult.text ?? '', run: persistedRun, evidence, warnings, signalReceived };
    const resultFile = await writeWorkerResultArtifact(jobDir, nonce, artifact);
    await writeWorkerStderr(jobDir, nonce, String(runResult.stderr ?? ''));
    const committed = /** @type {import('./contracts.js').Job} */ (await commitWorkerResult(jobDir, nonce, { ...persistedRun, finalText: runResult.text ?? '', resultFile, evidence, warnings }));
    return committed;
  } catch (error) {
    const committed = await loadWorkerJob(jobDir).catch(() => undefined);
    if (committed && TERMINAL.has(committed.status)) return committed;
    finalFailure = finalFailure ?? errorObject(error);
    if (runPromise && !runResult) {
      if (!controller.signal.aborted) controller.abort();
      try { runResult = await runPromise; } catch { /* lock remains because termination is unknown */ }
    }
    stopBackground();
    try { await drainEventWrites(); } catch (drainError) { failBackground(drainError); }
    await Promise.allSettled([...backgroundTasks]);
    const confirmed = runResult ? runResult.terminationConfirmed === true : !spawned;
    let explicitCancel = signalReceived;
    try { explicitCancel = explicitCancel || await cancellationRequested(jobDir, nonce); } catch { /* malformed state remains a failed job, not a cancellation */ }
    const rawResult = /** @type {Record<string, unknown>} */ ({ ...(runResult ?? { status: 'failed', text: '', stderr: '', exitCode: null, verification: [] }), status: explicitCancel ? 'cancelled' : 'failed', error: finalFailure, terminationConfirmed: confirmed });
    const { stderr: failureStderr, ...failureData } = rawResult;
    const result = /** @type {Record<string, unknown>} */ ({ ...failureData, verification: sanitizeDelegateEvent(rawResult.verification) });
    let resultFile;
    try {
      const failureArtifact = { version: 1, jobId: job.id, finalText: String(result.text ?? ''), run: result, evidence: undefined, warnings: ['Worker failure was persisted for review.'], signalReceived };
      resultFile = await writeWorkerResultArtifact(jobDir, nonce, failureArtifact);
      result.resultFile = resultFile;
    } catch { /* preserve lock if the failure artifact cannot be safely written */ }
    try {
      await writeWorkerStderr(jobDir, nonce, String(failureStderr ?? ''));
      return await commitWorkerResult(jobDir, nonce, result);
    } catch (commitError) {
      throw commitError;
    }
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (cancelTimer) clearInterval(cancelTimer);
    process.removeListener('SIGTERM', onSignal);
    process.removeListener('SIGINT', onSignal);
  }
}

const argv = process.argv.slice(2);
const index = argv.indexOf('--job-dir');
if (index !== -1 && argv[index + 1]) {
  runWorker(argv[index + 1]).then(() => { process.exitCode = 0; }).catch((error) => { process.stderr.write(String(error) + '\n'); process.exitCode = 1; });
}
