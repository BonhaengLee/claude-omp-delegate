#!/usr/bin/env node
import { appendFile, mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
const argv = process.argv.slice(2);
const valueAfter = (name) => { const index = argv.indexOf(name); return index === -1 ? undefined : argv[index + 1]; };
if (argv.includes('--version')) { process.stdout.write('omp/18.3.0\n'); process.exit(0); }
if (argv.includes('config') && argv.includes('modelRoles')) { process.stdout.write(JSON.stringify({ value: { default: 'openai-codex/job-fixture:medium' } }) + '\n'); process.exit(0); }
const sessionDir = valueAfter('--session-dir'); const resumedId = valueAfter('--resume'); const cwd = valueAfter('--cwd') ?? process.cwd();
if (!sessionDir) process.exit(2);
await mkdir(sessionDir, { recursive: true, mode: 0o700 });
let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;
const requestedMode = prompt.match(/JOB_FIXTURE_MODE=([^\s\r\n]+)/)?.[1];
const mode = requestedMode === 'success' && process.env.OMP_JOB_FIXTURE_READY_FILE ? 'hold' : (requestedMode ?? 'success');
const suffix = prompt.match(/JOB_FIXTURE_SUFFIX=([^\r\n]+)/)?.[1] ?? '';
const decision = (prompt.match(/JOB_FIXTURE_DECISION=([^\r\n]+)/)?.[1] ?? suffix) || 'fixture-decision';
const id = resumedId ?? 'fixture-' + process.pid + '-' + Date.now();
const sessionFile = path.join(sessionDir, id + '.jsonl');
async function ensureSession() { try { await stat(sessionFile); return; } catch {} const title = { type: 'title', title: 'job fixture' }; const header = { type: 'session', version: 3, id, cwd }; await writeFile(sessionFile, JSON.stringify(title) + '\n' + JSON.stringify(header) + '\n', { mode: 0o600 }); }
async function mark(name, payload = '') { const file = process.env['OMP_JOB_FIXTURE_' + name + '_FILE']; if (!file) return; await mkdir(path.dirname(file), { recursive: true, mode: 0o700 }); await writeFile(file, payload || String(process.pid) + '\n', { mode: 0o600 }); }
function emit(event) { process.stdout.write(JSON.stringify(event) + '\n'); }
async function persistNative(event) { await appendFile(sessionFile, JSON.stringify(event) + '\n'); }
async function finish(code = 0) { await mark('DONE'); process.stdout.end(() => process.exit(code)); }
await ensureSession(); emit({ type: 'session', version: 3, id }); emit({ type: 'agent_start' }); emit({ type: 'turn_start' }); await mark('SPAWNED', String(process.pid));
if (mode === 'hold' || mode === 'cancel-before') { await mark('READY', String(process.pid)); const terminate = async () => { await mark('CANCELLED', String(process.pid)); process.exit(143); }; process.once('SIGTERM', terminate); process.once('SIGINT', terminate); setInterval(() => {}, 2 ** 30); }
else if (mode === 'error') { emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'FIXTURE_ERROR' }], provider: 'openai-codex', model: 'job-fixture', stopReason: 'error' } }); emit({ type: 'agent_end', isTerminal: true }); await finish(0); }
else if (mode === 'exit-error') { process.stderr.write('fixture process failure\n'); await finish(9); }
else if (mode === 'burst') {
  const configured = Number.parseInt(process.env.OMP_JOB_FIXTURE_BURST_COUNT ?? '5000', 10);
  const count = Number.isSafeInteger(configured) && configured >= 1000 ? configured : 5000;
  for (let index = 0; index < count; index += 1) emit({ type: 'message_update', sequence: index, delta: 'burst-' + index });
  const text = 'BURST_OK:' + id + ':' + count;
  const message = { role: 'assistant', content: [{ type: 'text', text }], provider: 'openai-codex', model: 'job-fixture', stopReason: 'stop' };
  emit({ type: 'message_end', message });
  await persistNative({ type: 'message', message });
  emit({ type: 'agent_end', isTerminal: true });
  await finish(0);
}
else { const text = resumedId ? 'RESUME_OK:' + id + ':' + decision : 'FIXTURE_OK:' + id + ':' + decision; emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }], provider: 'openai-codex', model: 'job-fixture', stopReason: 'stop' } }); emit({ type: 'agent_end', isTerminal: true }); await finish(0); }
