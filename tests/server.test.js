import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { runTool } from '../src/server.js';
import { DelegateError } from '../src/contracts.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE = process.execPath;
const BRIEF = { goal: 'Use the sample job path', decisions: 'Keep the adapter strict', writeScope: ['sample.js'], acceptance: ['The tool responds'], constraints: ['Do not mutate unrelated files'], verification: ['Inspect the response'] };

function fixtureSource(serverHref) {
  return [
    'import { buildServer } from ' + JSON.stringify(serverHref) + ';',
    'import { StdioServerTransport } from ' + JSON.stringify(pathToFileURL(path.join(ROOT, 'node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js')).href) + ';',
    'const workspace = process.env.TEST_WORKSPACE;',
    'const job = { version: 1, id: "33333333-3333-4333-8333-333333333333", workspace, lockKey: workspace, status: "running", createdAt: new Date(Date.now() - 1500).toISOString(), updatedAt: new Date().toISOString(), sessionDir: workspace + "/sessions", modelRequested: "openai-codex/fake", modelActual: "openai-codex/fake", workerNonce: "44444444-4444-4444-8444-444444444444", warnings: [], activity: "sample tool" };',
    'const details = { brief: ' + JSON.stringify(BRIEF) + ', artifacts: { brief: workspace + "/brief.json", events: workspace + "/events.jsonl", stderr: workspace + "/stderr.log", result: workspace + "/result.json", sessionDir: workspace + "/sessions" } };',
    'const operations = { startJob: async () => job, followupJob: async () => job, listJobs: async () => [job], getJob: async () => job, requestCancel: async () => ({ ...job, status: "cancelling" }), waitForJob: async () => job, doctor: async () => ({ executable: "/tmp/fake-omp", ompVersion: "18.3.0", warnings: [], active: [] }), jobDetails: async () => details };',
    'const server = buildServer({ operations });',
    'await server.connect(new StdioServerTransport());',
  ].join('\n');
}

async function connectFixture(workspace, recursive = false) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'omp-server-fixture-'));
  const fixture = path.join(directory, 'server-fixture.mjs');
  const serverHref = pathToFileURL(path.join(ROOT, 'src/server.js')).href;
  await writeFile(fixture, fixtureSource(serverHref), { mode: 0o700 });
  const stderr = [];
  const transport = new StdioClientTransport({ command: NODE, args: [fixture], cwd: ROOT, stderr: 'pipe', env: { ...process.env, OMP_DELEGATE_LANG: 'ko', OMP_DELEGATE_DEPTH: recursive ? '1' : '0', TEST_WORKSPACE: workspace, OMP_DELEGATE_STATE_DIR: directory } });
  transport.stderr?.on('data', (chunk) => stderr.push(String(chunk)));
  const client = new Client({ name: 'server-test-client', version: '1.0.0' });
  await client.connect(transport);
  return { directory, client, transport, stderr };
}

test('real stdio MCP exposes strict six-tool contract and rejects unknown keys', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'omp-server-workspace-'));
  const config = path.join(workspace, 'config.json');
  await writeFile(config, JSON.stringify({ version: 1, executable: '/tmp/fake-omp' }) + '\n', { mode: 0o600 });
  const value = await connectFixture(workspace);
  try {
    const listed = await value.client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), ['omp_cancel', 'omp_doctor', 'omp_followup', 'omp_result', 'omp_start', 'omp_status']);
    const statusTool = listed.tools.find((tool) => tool.name === 'omp_status');
    assert.equal(statusTool.inputSchema.properties.workspace.type, 'string');
    assert.equal(statusTool.inputSchema.additionalProperties ?? false, false);
    const started = await value.client.callTool({ name: 'omp_start', arguments: { workspace, brief: BRIEF } });
    assert.equal(started.isError, undefined);
    const startedPayload = JSON.parse(started.content[0].text);
    assert.equal(startedPayload.jobId, '33333333-3333-4333-8333-333333333333');
    assert.match(startedPayload.summary, /모델/);
    const invalid = await value.client.callTool({ name: 'omp_status', arguments: { workspace, typo: true } });
    assert.equal(invalid.isError, true);
    assert.match(invalid.content[0].text, /unrecognized|typo/i);
  } finally {
    await value.client.close();
    await rm(value.directory, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test('recursion depth disables delegation tools but keeps stdio transport alive', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'omp-server-recursion-'));
  const value = await connectFixture(workspace, true);
  try {
    const listed = await value.client.listTools();
    assert.deepEqual(listed.tools, []);
    assert.match(value.stderr.join(''), /OMP_DELEGATE_DEPTH=1/);
  } finally {
    await value.client.close();
    await rm(value.directory, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test('WORKSPACE_BUSY returns a safe current progress card without lock metadata', async () => {
  const activeJob = { version: 1, id: '77777777-7777-4777-8777-777777777777', workspace: '/tmp', lockKey: '/tmp', status: 'running', createdAt: new Date(Date.now() - 500).toISOString(), updatedAt: new Date().toISOString(), sessionDir: '/tmp/sessions', modelRequested: 'openai-codex/fake', workerNonce: '88888888-8888-4888-8888-888888888888', warnings: [], activity: 'active fixture' };
  const details = { brief: BRIEF, artifacts: { brief: '/tmp/brief', events: '/tmp/events', stderr: '/tmp/stderr', result: '/tmp/result', sessionDir: '/tmp/sessions' } };
  const operations = {
    startJob: async () => { throw new DelegateError('WORKSPACE_BUSY', 'Workspace already has an active OMP job', { nonce: 'secret-lock-nonce', pid: 99999 }); },
    followupJob: async () => activeJob,
    listJobs: async () => [activeJob],
    getJob: async () => activeJob,
    requestCancel: async () => activeJob,
    waitForJob: async () => activeJob,
    doctor: async () => ({ warnings: [], active: [] }),
    jobDetails: async () => details,
  };
  const response = await runTool('omp_start', { workspace: '/tmp', brief: BRIEF }, {}, operations);
  assert.equal(response.isError, true);
  const payload = JSON.parse(response.content[0].text);
  assert.equal(payload.status, 'running');
  assert.equal(payload.jobId, activeJob.id);
  assert.match(payload.summary, /WORKSPACE_BUSY/);
  assert.match(payload.summary, /active fixture/);
  assert.doesNotMatch(response.content[0].text, /secret-lock-nonce|99999/);

  const fallback = await runTool('omp_start', { workspace: '/tmp', brief: BRIEF }, {}, { ...operations, listJobs: async () => { throw new Error('state unavailable secret-lock-nonce 99999'); } });
  assert.equal(fallback.isError, true);
  const fallbackText = fallback.content[0].text;
  assert.match(fallbackText, /WORKSPACE_BUSY/);
  assert.doesNotMatch(fallbackText, /secret-lock-nonce|99999/);
});

test('an already disconnected mutating request does not create a job', async () => {
  let starts = 0;
  const job = { version: 1, id: '55555555-5555-4555-8555-555555555555', workspace: '/tmp', lockKey: '/tmp', status: 'running', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), sessionDir: '/tmp/sessions', modelRequested: 'openai-codex/fake', workerNonce: '66666666-6666-4666-8666-666666666666', warnings: [], activity: 'test' };
  const operations = { startJob: async () => { starts += 1; return job; }, followupJob: async () => job, listJobs: async () => [], getJob: async () => job, requestCancel: async () => null, waitForJob: async () => job, doctor: async () => ({ warnings: [], active: [] }), jobDetails: async () => ({ brief: BRIEF, artifacts: { brief: '/tmp/brief', events: '/tmp/events', stderr: '/tmp/stderr', result: '/tmp/result', sessionDir: '/tmp/sessions' } }) };
  const response = await runTool('omp_start', { workspace: '/tmp', brief: BRIEF }, { signal: { aborted: true } }, operations);
  assert.equal(response.isError, true);
  assert.equal(starts, 0);
  assert.equal(JSON.parse(response.content[0].text).data.code, 'INVALID_INPUT');
});
