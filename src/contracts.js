import { z } from 'zod';
import path from 'node:path';
export const SUPPORTED_OMP_VERSION = '18.3.0';
export const LIMITS = Object.freeze({ lineBytes: 16 * 1024 * 1024, stderrBytes: 64 * 1024, previewBytes: 2048, startupMs: 120000, termMs: 5000, killMs: 5000, readyMs: 5000, heartbeatMs: 2000, staleMs: 30000, cancelPollMs: 250 });
export const THINKING = /** @type {const} */ (['off','minimal','low','medium','high','xhigh','max','auto']);
export const STATUSES = /** @type {const} */ (['starting','running','cancelling','completed','failed','cancelled','interrupted']);
export const TERMINAL = new Set(['completed','failed','cancelled','interrupted']);
export const ERROR_CODES = /** @type {const} */ (['PROTOCOL_ERROR','OUTPUT_INCOMPLETE','SESSION_INVALID','RESUME_FAILED','STATE_CORRUPT','WORKSPACE_BUSY','CANCEL_UNCONFIRMED','OMP_NOT_FOUND','VERSION_UNSUPPORTED','MODEL_NOT_CODEX','INVALID_INPUT','NOT_FOUND','AMBIGUOUS_SESSION','STARTUP_TIMEOUT','WORKER_NOT_READY','PROCESS_FAILED','UNSUPPORTED_PLATFORM','RECURSION_BLOCKED','RECOVERY_UNSAFE']);
export const workspaceSchema = z.string().min(1).refine(path.isAbsolute, 'workspace must be absolute');
export const jobIdSchema = z.string().uuid();
export const modelSchema = z.string().regex(/^openai-codex\/[A-Za-z0-9][A-Za-z0-9._-]*$/, 'Only exact openai-codex/<id> selectors are allowed');
const text = z.string().trim().min(1);
export const briefSchema = z.object({goal:text,decisions:text,writeScope:z.array(text).min(1),acceptance:z.array(text).min(1),constraints:z.array(text).min(1),verification:z.array(text).min(1),model:modelSchema.optional(),thinking:z.enum(THINKING).optional()}).strict();
export const toolSchemas = {
 omp_start:z.object({workspace:workspaceSchema,brief:briefSchema}).strict(),
 omp_followup:z.object({workspace:workspaceSchema,jobId:jobIdSchema.optional(),brief:briefSchema}).strict(),
 omp_status:z.object({workspace:workspaceSchema}).strict(),
 omp_result:z.object({workspace:workspaceSchema,jobId:jobIdSchema.optional()}).strict(),
 omp_cancel:z.object({workspace:workspaceSchema,jobId:jobIdSchema.optional()}).strict(),
 omp_doctor:z.object({workspace:workspaceSchema}).strict()
};
/** @typedef {z.infer<typeof briefSchema>} Brief */
/** @typedef {typeof STATUSES[number]} JobStatus */
/** @typedef {typeof ERROR_CODES[number]} ErrorCode */
/** @typedef {{code: ErrorCode, message: string}} JobError */
/** @typedef {{version:1,id:string,workspace:string,lockKey:string,status:JobStatus,createdAt:string,updatedAt:string,sessionId?:string,sessionDir:string,sessionFile?:string,ompVersion?:string,executable:string,modelRequested:string,modelActual?:string,thinking?:string,parentJobId?:string,workerNonce:string,ownerPid?:number,childPgid?:number,heartbeatAt?:string,result?:Record<string,unknown>,error?:JobError,warnings:string[],activity?:string}} Job */
export class DelegateError extends Error {
 /** @param {ErrorCode} code @param {string} message @param {unknown} [details] */
 constructor(code,message,details){super(message);this.name='DelegateError';this.code=code;this.details=details;}
}
/** Shared leading-option grammar; strings are data, never shell input.
 * @param {string|string[]} input
 */
export function parseRunOptions(input){
 let rest=(Array.isArray(input)?input.join(' '):input).trimStart();
 /** @type {{model?:string,thinking?:typeof THINKING[number],text:string}} */
 const result={text:''};const seen=new Set();
 while(rest.startsWith('--')){
  const match=/^(--[^\s]+)(?:\s+([^\s]+))?([\s\S]*)$/.exec(rest);
  if(!match)throw new DelegateError('INVALID_INPUT','Invalid leading option');
  const [,flag,rawValue,remainder]=match;
  if(flag!=='--model'&&flag!=='--thinking')throw new DelegateError('INVALID_INPUT','Unknown option: '+flag);
  if(seen.has(flag))throw new DelegateError('INVALID_INPUT','Duplicate option: '+flag);
  if(!rawValue||rawValue.startsWith('--'))throw new DelegateError('INVALID_INPUT','Missing value for '+flag);
  const value=rawValue.replace(/^(['"])(.*)\1$/,'$2');seen.add(flag);
  if(flag==='--model')result.model=modelSchema.parse(value);else result.thinking=z.enum(THINKING).parse(value);
  rest=remainder.trimStart();
 }
 result.text=rest;return result;
}
/** Normalize the slash command's verbatim leading options at the jobs boundary.
 * Structured MCP callers may also supply model/thinking; conflicting values fail.
 * @param {Brief} brief @returns {Brief}
 */
export function parseBriefOptions(brief){
 try{
  const base=briefSchema.parse(brief);const parsed=parseRunOptions(base.goal);
  if(base.model&&parsed.model&&base.model!==parsed.model)throw new DelegateError('INVALID_INPUT','Conflicting model overrides');
  if(base.thinking&&parsed.thinking&&base.thinking!==parsed.thinking)throw new DelegateError('INVALID_INPUT','Conflicting thinking overrides');
  return briefSchema.parse({...base,goal:parsed.text,model:parsed.model??base.model,thinking:parsed.thinking??base.thinking});
 }catch(error){if(error instanceof DelegateError)throw error;throw new DelegateError('INVALID_INPUT',String(error));}
}

export const jobSchema = z.object({
 version:z.literal(1),id:jobIdSchema,workspace:workspaceSchema,lockKey:workspaceSchema,status:z.enum(STATUSES),createdAt:z.string().datetime(),updatedAt:z.string().datetime(),sessionId:z.string().min(1).optional(),sessionDir:workspaceSchema,sessionFile:workspaceSchema.optional(),ompVersion:z.string().optional(),executable:workspaceSchema,modelRequested:modelSchema,modelActual:modelSchema.optional(),thinking:z.enum(THINKING).optional(),parentJobId:jobIdSchema.optional(),workerNonce:jobIdSchema,ownerPid:z.number().int().positive().optional(),childPgid:z.number().int().positive().optional(),heartbeatAt:z.string().datetime().optional(),result:z.record(z.unknown()).optional(),error:z.object({code:z.enum(ERROR_CODES),message:z.string()}).strict().optional(),warnings:z.array(z.string()),activity:z.string().optional()
}).strict();
/** Resolve configured aliases without changing global config or providers.
 * @param {Record<string,string>} roles @param {string} [selector] @param {typeof THINKING[number]} [thinking]
 */
export function resolveModel(roles,selector='@default',thinking){
 const seen=new Set();let resolved=selector;let configuredThinking;
 while(resolved.startsWith('@')){
  const alias=resolved.slice(1);if(seen.has(alias))throw new DelegateError('MODEL_NOT_CODEX','Model role cycle: '+alias);
  seen.add(alias);const value=roles[alias];if(typeof value!=='string'||!value)throw new DelegateError('MODEL_NOT_CODEX','Missing model role: '+alias);
  resolved=value;
 }
 const split=resolved.lastIndexOf(':');
 if(split>resolved.indexOf('/')){configuredThinking=z.enum(THINKING).parse(resolved.slice(split+1));resolved=resolved.slice(0,split);}
 if(!modelSchema.safeParse(resolved).success)throw new DelegateError('MODEL_NOT_CODEX','Default model is not an exact Codex selector: '+resolved);
 return {model:resolved,thinking:thinking??configuredThinking};
}
