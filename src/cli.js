#!/usr/bin/env node
// @ts-check
/** Minimal CLI waiter/doctor adapter; all job state lives in src/jobs.js. */
import process from 'node:process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DelegateError, jobIdSchema, workspaceSchema } from './contracts.js';
import * as jobEngine from './jobs.js';
import { renderError, renderJson, renderDoctor, renderProgress, renderResult } from './render.js';

/** @typedef {import('./contracts.js').Job} Job */
/** @typedef {{
 * waitForJob: typeof jobEngine.waitForJob,
 * jobDetails: typeof jobEngine.jobDetails,
 * doctor: typeof jobEngine.doctor,
 * }} CliOperations */
/** @type {CliOperations} */
const defaultOperations = { waitForJob: jobEngine.waitForJob, jobDetails: jobEngine.jobDetails, doctor: jobEngine.doctor };

/** @param {string} value @param {string} flag */
function requireValue(value, flag) {
  if (!value || value.startsWith('--')) throw new DelegateError('INVALID_INPUT', flag + ' requires a value');
  return value;
}

/** @param {string} value */
function timeoutValue(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new DelegateError('INVALID_INPUT', '--timeout-ms must be a non-negative integer');
  return parsed;
}

/** @param {string[]} argv */
export function parseCliArgs(argv) {
  const command = argv[0];
  if (command !== 'wait' && command !== 'doctor') throw new DelegateError('INVALID_INPUT', 'Only wait and doctor commands are supported');
  if (command === 'wait') {
    const rawJobId = argv[1];
    if (!rawJobId || rawJobId.startsWith('--') || !jobIdSchema.safeParse(rawJobId).success) throw new DelegateError('INVALID_INPUT', 'wait requires a validated UUID jobId');
    /** @type {{command:'wait',jobId:string,workspace:string,timeoutMs?:number}} */
    const parsed = { command: 'wait', jobId: rawJobId, workspace: '' };
    let workspaceSeen = false;
    let timeoutSeen = false;
    for (let index = 2; index < argv.length; index += 1) {
      const token = argv[index];
      if (token === '--workspace') {
        if (workspaceSeen) throw new DelegateError('INVALID_INPUT', 'Duplicate --workspace');
        parsed.workspace = requireValue(argv[++index], '--workspace');
        workspaceSeen = true;
      } else if (token === '--timeout-ms') {
        if (timeoutSeen) throw new DelegateError('INVALID_INPUT', 'Duplicate --timeout-ms');
        parsed.timeoutMs = timeoutValue(requireValue(argv[++index], '--timeout-ms'));
        timeoutSeen = true;
      } else {
        throw new DelegateError('INVALID_INPUT', 'Unknown wait option: ' + token);
      }
    }
    if (!workspaceSeen || !workspaceSchema.safeParse(parsed.workspace).success) throw new DelegateError('INVALID_INPUT', '--workspace must be an absolute path');
    return parsed;
  }

  /** @type {{command:'doctor',workspace:string,recover?:string}} */
  const parsed = { command: 'doctor', workspace: '' };
  let workspaceSeen = false;
  let recoverSeen = false;
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--workspace') {
      if (workspaceSeen) throw new DelegateError('INVALID_INPUT', 'Duplicate --workspace');
      parsed.workspace = requireValue(argv[++index], '--workspace');
      workspaceSeen = true;
    } else if (token === '--recover') {
      if (recoverSeen) throw new DelegateError('INVALID_INPUT', 'Duplicate --recover');
      const recover = requireValue(argv[++index], '--recover');
      if (!jobIdSchema.safeParse(recover).success) throw new DelegateError('INVALID_INPUT', '--recover must be a validated UUID');
      parsed.recover = recover;
      recoverSeen = true;
    } else {
      throw new DelegateError('INVALID_INPUT', 'Unknown doctor option: ' + token);
    }
  }
  if (!workspaceSeen || !workspaceSchema.safeParse(parsed.workspace).success) throw new DelegateError('INVALID_INPUT', '--workspace must be an absolute path');
  return parsed;
}

/** @param {string[]} [argv] @param {CliOperations} [operations] */
export async function executeCli(argv = process.argv.slice(2), operations = defaultOperations) {
  try {
    const parsed = parseCliArgs(argv);
    if (parsed.command === 'wait') {
      const job = await operations.waitForJob({ workspace: parsed.workspace, jobId: parsed.jobId, ...(parsed.timeoutMs === undefined ? {} : { timeoutMs: parsed.timeoutMs }) });
      const details = await operations.jobDetails(job);
      const rendered = ['completed', 'failed', 'cancelled', 'interrupted'].includes(job.status) ? renderResult(job, details) : renderProgress(job, details);
      return { exitCode: 0, envelope: rendered };
    }
    const report = await operations.doctor({ workspace: parsed.workspace, ...(parsed.recover ? { recover: parsed.recover } : {}) });
    return { exitCode: 0, envelope: renderDoctor(report) };
  } catch (error) {
    return { exitCode: 1, envelope: renderError(error) };
  }
}

/** @param {string[]} [argv] @param {{stdout?:{write:(value:string)=>void}}} [io] @param {CliOperations} [operations] */
export async function main(argv = process.argv.slice(2), io = process, operations = defaultOperations) {
  const result = await executeCli(argv, operations);
  if (!io.stdout) throw new DelegateError('PROCESS_FAILED', 'stdout is unavailable');
  io.stdout.write(renderJson(result.envelope));
  return result.exitCode;
}

const filename = fileURLToPath(import.meta.url);
let isMain = false;
if (process.argv[1]) {
  try { isMain = realpathSync(process.argv[1]) === realpathSync(filename); } catch {}
}
if (isMain) main().then((code) => { process.exitCode = code; });