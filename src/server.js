#!/usr/bin/env node
// @ts-check
/** MCP runtime adapter for the durable, profile-independent OMP job engine. */
import process from 'node:process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { DelegateError, toolSchemas } from './contracts.js';
import * as jobEngine from './jobs.js';
import { envelope, renderAmbiguous, renderBusy, renderCancel, renderDoctor, renderError, renderJson, renderProgress, renderResult, renderStatus } from './render.js';

export const SERVER_VERSION = '0.1.0';
export const SERVER_NAME = 'claude-omp-delegate';

/** @typedef {{
 * startJob: typeof jobEngine.startJob,
 * followupJob: typeof jobEngine.followupJob,
 * listJobs: typeof jobEngine.listJobs,
 * getJob: typeof jobEngine.getJob,
 * requestCancel: typeof jobEngine.requestCancel,
 * waitForJob: typeof jobEngine.waitForJob,
 * doctor: typeof jobEngine.doctor,
 * jobDetails: typeof jobEngine.jobDetails,
 * }} JobOperations */
/** @typedef {import('./contracts.js').Job} Job */

/** @type {JobOperations} */
const defaultOperations = {
  startJob: jobEngine.startJob,
  followupJob: jobEngine.followupJob,
  listJobs: jobEngine.listJobs,
  getJob: jobEngine.getJob,
  requestCancel: jobEngine.requestCancel,
  waitForJob: jobEngine.waitForJob,
  doctor: jobEngine.doctor,
  jobDetails: jobEngine.jobDetails,
};

const MUTATING_TOOLS = new Set(['omp_start', 'omp_followup']);

/** @param {unknown} error */
function asDelegateError(error) {
  if (error instanceof DelegateError) return error;
  const value = /** @type {any} */ (error);
  if (value?.name === 'ZodError') return new DelegateError('INVALID_INPUT', 'Invalid tool input', value.issues);
  return new DelegateError('PROCESS_FAILED', value?.message ? String(value.message) : String(error));
}

/** @param {string} name @param {unknown} args @returns {any} */
function parseToolInput(name, args) {
  const schema = /** @type {any} */ (toolSchemas)[name];
  if (!schema) throw new DelegateError('INVALID_INPUT', 'Unknown OMP tool: ' + name);
  const parsed = schema.safeParse(args);
  if (!parsed.success) throw new DelegateError('INVALID_INPUT', 'Invalid input for ' + name, parsed.error.issues);
  return parsed.data;
}

/** @param {unknown} extra */
function requestAlreadyDisconnected(extra) {
  const value = /** @type {any} */ (extra);
  return value?.signal?.aborted === true;
}

/** @param {string} name @param {Record<string,unknown>} args @param {any} extra @param {JobOperations} operations */
async function invokeTool(name, args, extra, operations) {
  const input = parseToolInput(name, args);
  // A disconnected mutating request is rejected before the durable worker is created.
  // Once a worker is ready the engine owns its lifetime; no MCP AbortSignal is forwarded.
  if (MUTATING_TOOLS.has(name) && requestAlreadyDisconnected(extra)) {
    throw new DelegateError('INVALID_INPUT', 'MCP request disconnected before starting; no job was created.');
  }
  if (name === 'omp_start') {
    const job = await operations.startJob(input);
    const details = await operations.jobDetails(job);
    return renderProgress(job, details);
  }
  if (name === 'omp_followup') {
    const job = await operations.followupJob(input);
    const details = await operations.jobDetails(job);
    return renderProgress(job, details);
  }
  if (name === 'omp_status') {
    const jobs = await operations.listJobs(input);
    return await renderStatus(jobs, { detailsResolver: operations.jobDetails });
  }
  if (name === 'omp_result') {
    const job = await operations.getJob(input);
    const details = await operations.jobDetails(job);
    return renderResult(job, details);
  }
  if (name === 'omp_cancel') {
    const job = /** @type {Job|null} */ (await operations.requestCancel(input));
    if (!job) return renderCancel(null);
    const details = await operations.jobDetails(job);
    return renderCancel(job, details);
  }
  if (name === 'omp_doctor') {
    const report = await operations.doctor(input);
    return renderDoctor(report);
  }
  throw new DelegateError('INVALID_INPUT', 'Unknown OMP tool: ' + name);
}

/** @param {string} name @param {unknown} args @param {any} extra @param {JobOperations} operations */
export async function runTool(name, args, extra, operations = defaultOperations) {
  try {
    const result = await invokeTool(name, /** @type {Record<string,unknown>} */ (args), extra, operations);
    return { content: [{ type: /** @type {const} */ ('text'), text: renderJson(result) }] };
  } catch (error) {
    const failure = asDelegateError(error);
    if (failure.code === 'WORKSPACE_BUSY') {
      const input = /** @type {any} */ (args);
      const workspace = typeof input?.workspace === 'string' ? input.workspace : undefined;
      if (workspace) {
        try {
          const jobs = await operations.listJobs({ workspace });
          const current = jobs.find((job) => !['completed', 'failed', 'cancelled', 'interrupted'].includes(job.status));
          if (current) {
            const details = await operations.jobDetails(current);
            const busy = renderBusy(current, details);
            return { content: [{ type: /** @type {const} */ ('text'), text: renderJson(busy) }], isError: true };
          }
        } catch {
          // Preserve the safe WORKSPACE_BUSY error when the concurrent card is unavailable.
        }
      }
    }
    if (failure.code === 'AMBIGUOUS_SESSION') {
      const input=/** @type {any} */(args);const details=/** @type {any} */(failure.details);
      if(typeof input?.workspace==='string'&&Array.isArray(details?.candidates)){
        try{
          const entries=await Promise.all(details.candidates.map(async(/** @type {{id:string}} */candidate)=>{
            const job=await operations.getJob({workspace:input.workspace,jobId:candidate.id});
            return {job,details:await operations.jobDetails(job)};
          }));
          return {content:[{type:/** @type {const} */('text'),text:renderJson(renderAmbiguous(entries))}],isError:true};
        }catch{/* Preserve the original ambiguity; never choose a fallback session. */}
      }
    }
    const result = renderError(failure);
    return { content: [{ type: /** @type {const} */ ('text'), text: renderJson(result) }], isError: true };
  }
}

/** @param {{operations?:JobOperations,recursionBlocked?:boolean}} [options] */
export function buildServer(options = {}) {
  const operations = options.operations ?? defaultOperations;
  const recursionBlocked = options.recursionBlocked ?? process.env.OMP_DELEGATE_DEPTH === '1';
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: 'Start OMP work only through explicit omp_start/omp_followup calls. Review the resulting diff and acceptance yourself.' },
  );

  if (recursionBlocked) {
    console.error('OMP delegation disabled: OMP_DELEGATE_DEPTH=1 prevents recursive delegation; read-only MCP transport remains available.');
    // McpServer installs listTools lazily when the first tool is registered. Keep
    // the stdio transport MCP-valid while exposing an intentionally empty catalog.
    server.server.registerCapabilities({ tools: { listChanged: false } });
    server.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
    return server;
  }

  /** @type {(name:string, config:any, callback:any) => unknown} */
  const registerTool = (name, config, callback) => server.registerTool(name, config, callback);

  registerTool('omp_start', {
    title: 'Start OMP implementation',
    description: 'Start one durable OMP worker. workspace must be an existing absolute path; brief must contain the approved goal, decisions, write scope, acceptance, constraints, and verification.',
    inputSchema: toolSchemas.omp_start,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async (/** @type {any} */ args, /** @type {any} */ extra) => runTool('omp_start', args, extra, operations));

  registerTool('omp_status', {
    title: 'Show OMP status',
    description: 'Show active and recent OMP jobs for an existing absolute workspace. This is read-only and works across Claude profiles.',
    inputSchema: toolSchemas.omp_status,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (/** @type {any} */ args, /** @type {any} */ extra) => runTool('omp_status', args, extra, operations));

  registerTool('omp_result', {
    title: 'Show OMP result',
    description: 'Show a compact Korean result envelope for one terminal OMP job, or the most recent terminal job when jobId is omitted. Raw logs remain in artifact paths.',
    inputSchema: toolSchemas.omp_result,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (/** @type {any} */ args, /** @type {any} */ extra) => runTool('omp_result', args, extra, operations));

  registerTool('omp_followup', {
    title: 'Continue an OMP session',
    description: 'Create a new durable job that explicitly resumes a persisted OMP session. No fresh-session fallback is performed.',
    inputSchema: toolSchemas.omp_followup,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async (/** @type {any} */ args, /** @type {any} */ extra) => runTool('omp_followup', args, extra, operations));

  registerTool('omp_cancel', {
    title: 'Cancel an OMP job',
    description: 'Request cancellation of one active OMP job. The worker confirms process-group termination; existing workspace changes are not rolled back.',
    inputSchema: toolSchemas.omp_cancel,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async (/** @type {any} */ args, /** @type {any} */ extra) => runTool('omp_cancel', args, extra, operations));

  registerTool('omp_doctor', {
    title: 'Diagnose OMP installation',
    description: 'Check OMP executable/version, state, platform, and hook presence. On first use this may initialize shared state/config.json; never logs in, changes accounts, or updates OMP.',
    inputSchema: toolSchemas.omp_doctor,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (/** @type {any} */ args, /** @type {any} */ extra) => runTool('omp_doctor', args, extra, operations));

  return server;
}

/** @param {{operations?:JobOperations,recursionBlocked?:boolean}} [options] */
export async function startServer(options = {}) {
  const server = buildServer(options);
  await server.connect(new StdioServerTransport());
  return server;
}

const filename = fileURLToPath(import.meta.url);
let isMain = false;
if (process.argv[1]) {
  try { isMain = realpathSync(process.argv[1]) === realpathSync(filename); } catch {}
}
if (isMain) await startServer();