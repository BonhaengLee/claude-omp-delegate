#!/usr/bin/env node
// Deterministic OMP-shaped child used by runner tests. It deliberately keeps the
// session title/header and JSONL lifecycle separate, matching the 18.3 contract.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const valueAfter = (name) => {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
};

const sessionDir = valueAfter('--session-dir');
const resumedId = valueAfter('--resume');
if (!sessionDir) process.exit(0);

let prompt = '';
let epipeTriggered = false;
let mainStarted = false;

const emit = (event) => process.stdout.write(JSON.stringify(event) + '\n');
const finish = (code = 0) => {
  process.stdout.end(() => process.exit(code));
};

function sessionIdFor(mode) {
  return resumedId || 'fake-' + process.pid + '-' + Date.now() + '-' + mode;
}

function writeSessionFile(id, fileHeaderId = id) {
  mkdirSync(sessionDir, { recursive: true });
  const title = { type: 'title', title: 'fake OMP runner test' };
  const header = { type: 'session', version: 3, id: fileHeaderId, cwd: process.cwd() };
  writeFileSync(sessionDir + '/' + id + '.jsonl', JSON.stringify(title) + '\n' + JSON.stringify(header) + '\n');
}

function emitStart(id) {
  emit({ type: 'session', version: 3, id });
  emit({ type: 'agent_start' });
  emit({ type: 'turn_start' });
}

function emitAssistant(text, stopReason = 'stop') {
  emit({
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      provider: 'openai-codex',
      model: 'fake-18.3',
      stopReason,
    },
  });
}

function run(mode, rest) {
  const id = sessionIdFor(mode);
  if (mode === 'unknown-startup') {
    emit({ type: 'unknown_future_event' });
    setInterval(() => {}, 1 << 30);
    return;
  }
  if (mode === 'stderr-bounds') {
    process.stderr.write('x'.repeat(70 * 1024) + 'STDERR_END', () => process.exit(7));
    return;
  }
  if (mode === 'oversize') {
    process.stdout.end('x'.repeat(16 * 1024 * 1024 + 1) + '\n', () => process.exit(0));
    return;
  }
  if (mode === 'truncated-utf8') {
    writeSessionFile(id);
    emit({ type: 'session', version: 3, id });
    process.stdout.end(Buffer.from([0xe2, 0x82]), () => process.exit(0));
    return;
  }
  if (mode === 'malformed') {
    writeSessionFile(id);
    emit({ type: 'session', version: 3, id });
    process.stdout.end('not-json\n', () => process.exit(0));
    return;
  }
  if (mode === 'missing-session') {
    emitStart(id);
    emitAssistant('MISSING_SESSION');
    emit({ type: 'agent_end', isTerminal: true });
    finish();
    return;
  }
  if (mode === 'session-mismatch') {
    writeSessionFile(id, id + '-different');
    emitStart(id);
    emitAssistant('SESSION_MISMATCH');
    emit({ type: 'agent_end', isTerminal: true });
    finish();
    return;
  }
  if (mode === 'error') {
    writeSessionFile(id);
    emitStart(id);
    emitAssistant('ERROR_RESULT', 'error');
    emit({ type: 'agent_end', isTerminal: true });
    finish();
    return;
  }
  if (mode === 'retry') {
    writeSessionFile(id);
    emitStart(id);
    emit({ type: 'error', message: 'temporary transport failure; retrying' });
    emit({ type: 'agent_end', isTerminal: false });
    emit({ type: 'agent_start' });
    emit({ type: 'turn_start' });
    emitAssistant('RETRY_OK');
    emit({ type: 'agent_end', isTerminal: true });
    finish();
    return;
  }
  if (mode === 'nonterminal') {
    writeSessionFile(id);
    emitStart(id);
    emitAssistant('NONTERMINAL_RESULT');
    emit({ type: 'agent_end', isTerminal: false });
    finish();
    return;
  }
  if (mode === 'missing-final') {
    writeSessionFile(id);
    emitStart(id);
    emit({ type: 'agent_end', isTerminal: true });
    finish();
    return;
  }
  if (mode === 'escaped-stdio') {
    const escaped = spawn(process.execPath,['-e','setInterval(()=>{},1<<30)'],{detached:true,stdio:['ignore',1,2]});
    writeFileSync(rest[0],String(escaped.pid));writeSessionFile(id);emitStart(id);process.exit(0);
  }
  if (mode === 'grandchild') {
    const pidFile = rest[0];
    const grandchild = spawn(
      process.execPath,
      ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1 << 30);"],
      { stdio: 'ignore' },
    );
    if (pidFile) writeFileSync(pidFile, String(grandchild.pid) + '\n');
    process.on('SIGTERM', () => {});
    writeSessionFile(id);
    emitStart(id);
    // Keep both the leader and grandchild alive until the parent cancels the run.
    setInterval(() => {}, 1 << 30);
    return;
  }

  writeSessionFile(id);
  emitStart(id);
  emitAssistant('FAKE_OK');
  emit({ type: 'agent_end', isTerminal: true });
  finish();
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  prompt += chunk;
  const mode = prompt.split(/\r?\n/, 1)[0].trim();
  // Closing the read end after the first chunk gives the parent a real EPIPE while
  // the child remains alive long enough for its stream error to be observed.
  if (!epipeTriggered && mode === 'epipe') {
    epipeTriggered = true;
    process.stdin.destroy();
    setTimeout(() => process.exit(0), 500);
  }
});
process.stdin.on('end', () => {
  if (epipeTriggered || mainStarted) return;
  mainStarted = true;
  const lines = prompt.split(/\r?\n/);
  run(lines[0].trim(), lines.slice(1));
});
process.stdin.on('error', () => {});
