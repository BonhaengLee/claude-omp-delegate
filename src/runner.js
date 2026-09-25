// Process boundary adapted from Andrei Lungeanu, codex-delegate-mcp
// 0ab0c42c4fdbc3fca2cf923bb8b23fefdd056e0c, MIT; see THIRD_PARTY_NOTICES.md.
// Changed: OMP event dialect, strict EOF/session proof, no hard cap, confirmed group cancellation.
import { spawn } from 'node:child_process';
import { readdir, realpath, lstat, chmod } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { DelegateError, LIMITS } from './contracts.js';
/** @typedef {{role?:string,content?:Array<{type:string,text?:string}>,stopReason?:string,provider?:string,model?:string}} Message */
/** @typedef {{sessionId?:string,assistant?:Message,terminal:boolean,sequence:number,terminalSequence:number,assistantSequence:number,pending:Set<string>,verification:Array<Record<string,unknown>>,activity:string}} EventState */
/** @returns {EventState} */
export function createEventState(){return {terminal:false,sequence:0,terminalSequence:-1,assistantSequence:-1,pending:new Set(),verification:[],activity:''};}
/** @param {EventState} state @param {any} event */
export function reduceOmpEvent(state,event){
 if(!event||typeof event!=='object'||typeof event.type!=='string')throw new DelegateError('PROTOCOL_ERROR','JSONL event must have a type');
 state.sequence++;
 if(event.type==='session'){
  if(event.version!==3)throw new DelegateError('PROTOCOL_ERROR','Unsupported stream session header version');
  if(typeof event.id!=='string'||!event.id)throw new DelegateError('PROTOCOL_ERROR','Missing session id');
  if(state.sessionId&&state.sessionId!==event.id)throw new DelegateError('SESSION_INVALID','Session changed within one run');
  state.sessionId=event.id;
 }
 if(event.type==='agent_start'||event.type==='turn_start'){state.terminal=false;}
 if(event.type==='message_end'&&event.message?.role==='assistant'){
  if(!Array.isArray(event.message.content)||event.message.content.some(/** @param {any} block */block=>!block||typeof block.type!=='string'||block.type==='text'&&typeof block.text!=='string'))throw new DelegateError('PROTOCOL_ERROR','Invalid assistant content');
  if(typeof event.message.stopReason!=='string')throw new DelegateError('PROTOCOL_ERROR','Missing assistant stopReason');
  state.assistant=event.message;state.assistantSequence=state.sequence;state.terminal=false;
 }
 if(event.type==='tool_execution_start'){
  if(typeof event.toolCallId!=='string'||!event.toolCallId||typeof event.toolName!=='string'||!event.toolName)throw new DelegateError('PROTOCOL_ERROR','Invalid tool execution identity');
  if(typeof event.toolCallId==='string')state.pending.add(event.toolCallId);
  state.activity=String(event.toolName??'tool');state.terminal=false;
 }
 if(event.type==='tool_execution_end'){
  if(typeof event.toolCallId!=='string'||!state.pending.has(event.toolCallId)||typeof event.isError!=='boolean')throw new DelegateError('PROTOCOL_ERROR','Invalid or unmatched tool completion');
  state.pending.delete(event.toolCallId);
  // Tool payloads are retained as evidence, not converted to PASS from assistant prose.
  const cells=event.result?.details?.cells;
  const observed=Array.isArray(cells)?cells.map(cell=>({scope:'eval-cell',status:cell.status??null,exitCode:cell.exitCode??null,commands:(cell.statusEvents??[]).filter(/** @param {any} item */item=>item.op==='run').map(/** @param {any} item */item=>item.cmd),commandVerdict:'unconfirmed: cell success alone is not subprocess/acceptance PASS'})):[];
  state.verification.push({tool:event.toolName??null,toolCallId:event.toolCallId??null,isError:event.isError??null,observed,result:event.result??null});
 }
 if(event.type==='agent_end'){
  if(event.isTerminal!==undefined&&typeof event.isTerminal!=='boolean')throw new DelegateError('PROTOCOL_ERROR','isTerminal must be boolean when present');
  state.terminal=event.isTerminal!==false;
  state.terminalSequence=state.sequence;
 }
 return state;
}
/** @param {Message|undefined} message */
export function messageText(message){return (message?.content??[]).filter(x=>x.type==='text').map(x=>x.text??'').join('\n');}
/** Reads only the header (OMP writes title before session), never credential records.
 * @param {string} file
 */
async function readSessionHeader(file){
 const stream=createReadStream(file,{encoding:'utf8'});const lines=createInterface({input:stream,crlfDelay:Infinity});
 try{let count=0;for await(const line of lines){if(++count>3)break;const row=JSON.parse(line);if(row.type==='session')return row;}}
 finally{lines.close();stream.destroy();}
 throw new DelegateError('SESSION_INVALID','No session header: '+file);
}
/** @param {string} sessionDir @param {string} sessionId @param {string} [sessionFile] */
export async function validateSession(sessionDir,sessionId,sessionFile){
 if((await lstat(sessionDir)).isSymbolicLink())throw new DelegateError('SESSION_INVALID','Symlink session directory rejected');
 const root=await realpath(sessionDir);
 const candidates=(await readdir(root)).filter(x=>x.endsWith('.jsonl')).map(x=>path.join(root,x));
 const expected=sessionFile?path.resolve(sessionFile):undefined;
 if(expected&&!candidates.includes(expected))throw new DelegateError('SESSION_INVALID','Recorded transcript is missing or outside sessionDir');
 let matching;
 for(const file of candidates){
  const stat=await lstat(file);const resolved=await realpath(file);
  if(stat.isSymbolicLink()||!stat.isFile()||path.dirname(resolved)!==root)throw new DelegateError('SESSION_INVALID','Session file must be directly inside sessionDir');
  const header=await readSessionHeader(resolved);
  if(header.id!==sessionId)continue;
  if(header.version!==3||matching)throw new DelegateError('SESSION_INVALID','Unsupported or ambiguous persisted session identity');
  matching=resolved;
 }
 if(!matching||expected&&matching!==expected)throw new DelegateError('SESSION_INVALID','Persisted transcript does not match recorded session identity');
 await chmod(matching,0o600);
 return matching;
}
/** @param {number} pgid */
export function groupGone(pgid){try{process.kill(-pgid,0);return false;}catch(error){return /** @type {NodeJS.ErrnoException} */(error).code==='ESRCH';}}
/** @typedef {{status:'completed'|'failed'|'cancelled',text:string,stderr:string,exitCode:number|null,sessionId?:string,sessionFile?:string,modelActual?:string,error?:{code:import('./contracts.js').ErrorCode,message:string},verification:Array<Record<string,unknown>>,terminationConfirmed:boolean}} RunResult */
/** @param {{executable:string,cwd:string,sessionDir:string,sessionId?:string,sessionFile?:string,prompt:string,model?:string,thinking?:string,signal?:AbortSignal,onEvent?:(event:any)=>void|Promise<void>,onSpawn?:(pid:number)=>void,startupMs?:number,termMs?:number,killMs?:number}} options @returns {Promise<RunResult>} */
export async function runOmpProcess(options){
 if(process.platform==='win32')throw new DelegateError('UNSUPPORTED_PLATFORM','Only macOS/Linux process groups are supported');
 const state=createEventState();
 /** @type {Buffer} */ let stderr=Buffer.alloc(0);
 /** @type {import('./contracts.js').JobError|undefined} */let failure;
 let cancelled=options.signal?.aborted??false;
 /** @type {RunResult} */const empty={status:'cancelled',text:'',stderr:'',exitCode:null,verification:[],terminationConfirmed:true};
 if(cancelled)return empty;
 if(options.sessionId){try{await validateSession(options.sessionDir,options.sessionId,options.sessionFile);}catch(error){return {...empty,status:'failed',error:{code:'RESUME_FAILED',message:String(error)}};}}
 const args=['-p','--mode','json','--no-title','--cwd',options.cwd,'--session-dir',options.sessionDir,'--model',options.model??'@default'];
 if(options.thinking)args.push('--thinking',options.thinking);
 if(options.sessionId)args.push('--resume',options.sessionId);
 const child=spawn(options.executable,args,{cwd:options.cwd,env:{...process.env,OMP_DELEGATE_DEPTH:'1'},shell:false,detached:true,stdio:['pipe','pipe','pipe']});
 const decoder=new TextDecoder('utf-8',{fatal:true});let buffer=Buffer.allocUnsafe(4096);let bufferedBytes=0;let stdoutEof=false;let stderrClosed=false;let exited=false;let closed=false;let code=null;let terminating=false;let forced=false;let signalDiagnostic='';let groupRetired=false;let stdoutChain=Promise.resolve();
 /** @type {NodeJS.Timeout|undefined} */let termTimer,deadlineTimer,pollTimer;
 /** @type {()=>void} */let finish;
 const settled=new Promise(resolve=>{finish=()=>resolve(undefined);});
 const ownedGroupGone=()=>{if(!child.pid||groupRetired)return true;if(groupGone(child.pid)){groupRetired=true;clearTimeout(termTimer);return true;}return false;};
 /** @param {NodeJS.Signals} signal */
 const send=signal=>{if(!child.pid||ownedGroupGone())return;try{process.kill(-child.pid,signal);}catch(error){if(/** @type {NodeJS.ErrnoException} */(error).code==='ESRCH')groupRetired=true;else signalDiagnostic=String(error);}};
 const confirmed=()=>exited&&stdoutEof&&stderrClosed&&ownedGroupGone();
 const maybeFinish=()=>{if(exited)ownedGroupGone();if(terminating){if(confirmed())finish();}else if(closed&&stdoutEof)finish();};
 const terminate=()=>{
  if(terminating)return;terminating=true;clearTimeout(startup);send('SIGTERM');
  termTimer=setTimeout(()=>send('SIGKILL'),options.termMs??LIMITS.termMs);
  deadlineTimer=setTimeout(()=>{if(!confirmed()){forced=true;failure={code:'CANCEL_UNCONFIRMED',message:'Exit, EOF or process-group disappearance was not confirmed; workspace lock retained. '+signalDiagnostic+' '+(failure?.message??'')};}finish();},(options.termMs??LIMITS.termMs)+(options.killMs??LIMITS.killMs));
  pollTimer=setInterval(maybeFinish,25);maybeFinish();
 };
 const onAbort=()=>{cancelled=true;terminate();};
 const startup=setTimeout(()=>{failure={code:'STARTUP_TIMEOUT',message:'No valid session header within startup deadline'};terminate();},options.startupMs??LIMITS.startupMs);
 /** @param {string} line */
 const consume=async line=>{
  if(!line.trim())return;
  try{const event=JSON.parse(line);reduceOmpEvent(state,event);if(state.sessionId)clearTimeout(startup);await options.onEvent?.(event);}
  catch(error){failure={code:error instanceof DelegateError?error.code:'PROTOCOL_ERROR',message:String(error)};terminate();}
 };
 child.on('spawn',()=>{try{if(child.pid)options.onSpawn?.(child.pid);}catch(error){failure={code:'PROCESS_FAILED',message:String(error)};terminate();}});
 child.on('error',error=>{failure={code:'PROCESS_FAILED',message:String(error)};exited=true;stdoutEof=true;stderrClosed=true;closed=true;maybeFinish();});
 child.on('exit',exitCode=>{exited=true;code=exitCode;maybeFinish();});
 child.on('close',()=>{closed=true;maybeFinish();});
 // Frame bytes incrementally; rescanning a growing string makes long JSONL lines quadratic.
 /** @param {Buffer} fragment */
 const append=fragment=>{
  const needed=bufferedBytes+fragment.length;
  if(needed>LIMITS.lineBytes){failure={code:'PROTOCOL_ERROR',message:'JSONL line exceeds 16 MiB'};terminate();return false;}
  if(needed>buffer.length){const expanded=Buffer.allocUnsafe(Math.min(LIMITS.lineBytes,Math.max(needed,buffer.length*2)));buffer.copy(expanded,0,0,bufferedBytes);buffer=expanded;}
  fragment.copy(buffer,bufferedBytes);bufferedBytes=needed;return true;
 };
 const consumeBuffered=async()=>{
  try{const line=decoder.decode(buffer.subarray(0,bufferedBytes));bufferedBytes=0;await consume(line);}
  catch(error){failure={code:'PROTOCOL_ERROR',message:'Invalid or incomplete UTF-8: '+String(error)};terminate();}
 };
 child.stdout.on('data',chunk=>{
  child.stdout.pause();
  stdoutChain=stdoutChain.then(async()=>{
   if(failure)return;let start=0;
   while(start<chunk.length){const newline=chunk.indexOf(10,start);const end=newline<0?chunk.length:newline;if(!append(chunk.subarray(start,end)))return;if(newline<0)return;await consumeBuffered();if(failure)return;start=newline+1;}
  }).catch(error=>{failure??={code:'PROCESS_FAILED',message:String(error)};terminate();}).finally(()=>{child.stdout.resume();});
 });
 child.stdout.on('end',()=>{
  stdoutChain=stdoutChain.then(async()=>{if(bufferedBytes&&!failure)await consumeBuffered();stdoutEof=true;maybeFinish();}).catch(error=>{failure??={code:'PROCESS_FAILED',message:String(error)};terminate();stdoutEof=true;maybeFinish();});
 });
 child.stderr.on('data',chunk=>{stderr=Buffer.concat([stderr,chunk]);if(stderr.length>LIMITS.stderrBytes)stderr=stderr.subarray(stderr.length-LIMITS.stderrBytes);});
 child.stderr.on('close',()=>{stderrClosed=true;maybeFinish();});
 const streamError=/** @param {Error} error */error=>{failure??={code:'PROCESS_FAILED',message:String(error)};terminate();};
 child.stdout.on('error',streamError);child.stderr.on('error',streamError);child.stdin.on('error',streamError);
 options.signal?.addEventListener('abort',onAbort,{once:true});
 if(options.signal?.aborted)onAbort();
 child.stdin.end(options.prompt);
 await settled;
 clearTimeout(startup);clearTimeout(termTimer);clearTimeout(deadlineTimer);clearInterval(pollTimer);options.signal?.removeEventListener('abort',onAbort);
 if(forced){child.stdout.destroy();child.stderr.destroy();child.stdin.destroy();child.unref();}
 /** @type {RunResult} */const result={status:'failed',text:messageText(state.assistant),stderr:stderr.toString('utf8'),exitCode:code,sessionId:state.sessionId,modelActual:state.assistant?.provider&&state.assistant.model?state.assistant.provider+'/'+state.assistant.model:undefined,verification:state.verification,terminationConfirmed:confirmed()};
 if(failure){result.error=failure;return result;}
 if(cancelled){result.status='cancelled';return result;}
 if(code!==0){result.error={code:options.sessionId?'RESUME_FAILED':'PROCESS_FAILED',message:'OMP exited with code '+code};return result;}
 if(!state.terminal||state.terminalSequence<state.assistantSequence||!result.text||!state.assistant||['error','aborted','toolUse'].includes(state.assistant.stopReason??'')||state.pending.size){result.error={code:'OUTPUT_INCOMPLETE',message:'No complete terminal assistant result or unfinished tool work'};return result;}
 if(!state.sessionId||options.sessionId&&options.sessionId!==state.sessionId){result.error={code:options.sessionId?'RESUME_FAILED':'SESSION_INVALID',message:'Missing or mismatched session id'};return result;}
 try{result.sessionFile=await validateSession(options.sessionDir,state.sessionId,options.sessionFile);}
 catch(error){result.error={code:options.sessionId?'RESUME_FAILED':'SESSION_INVALID',message:String(error)};return result;}
 if(!result.terminationConfirmed){result.error={code:'OUTPUT_INCOMPLETE',message:'OMP exited but process-group work remains; lock retained'};return result;}
 result.status='completed';return result;
}
