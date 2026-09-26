#!/usr/bin/env node
/**
 * Real-host end-to-end check: packaged runtime + a real OMP executable + real model call, in an isolated
 * state directory and a throwaway git workspace. It never touches the shared plugin state or your repos.
 *
 * Usage: npm run package && node scripts/host-e2e.mjs [--omp /absolute/path/to/omp]
 * Requires an authenticated OMP whose default model resolves to openai-codex/<id>. Spends one small model run.
 * Prints one JSON line; exit 0 only when every check passed.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME = path.join(ROOT, 'plugins', 'omp', 'runtime');
const sdk = (file) => pathToFileURL(path.join(RUNTIME, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'client', file)).href;
const { Client } = await import(sdk('index.js'));
const { StdioClientTransport } = await import(sdk('stdio.js'));

const ompFlag = process.argv.indexOf('--omp');
const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'omp-host-e2e-')));
const state = path.join(base, 'state'); const workspace = path.join(base, 'workspace'); const bin = path.join(base, 'bin');
mkdirSync(state, { mode: 0o700 }); mkdirSync(workspace); mkdirSync(bin);
if (ompFlag !== -1) symlinkSync(path.resolve(process.argv[ompFlag + 1]), path.join(bin, 'omp'));
const git = (...args) => execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.invalid', ...args], { cwd: workspace, encoding: 'utf8' });
git('init', '-q'); writeFileSync(path.join(workspace, 'README.md'), '# e2e\n'); git('add', '.'); git('commit', '-qm', 'init');

const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH, OMP_DELEGATE_STATE_DIR: state, CLAUDE_PLUGIN_ROOT: path.dirname(RUNTIME) };
delete env.OMP_DELEGATE_DEPTH;
async function tool(name, args) {
  const client = new Client({ name: 'omp-host-e2e', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(RUNTIME, 'server.js')], env, stderr: 'pipe' }));
  try { const response = await client.callTool({ name, arguments: args }); return JSON.parse(response.content.map((item) => item.text).join('')); }
  finally { await client.close(); }
}

const report = { checks: {} };
try {
  const doctor = await tool('omp_doctor', { workspace });
  report.ompVersion = doctor.data?.ompVersion; report.ompVersionStatus = doctor.data?.ompVersionStatus;
  report.checks.doctor = doctor.status === 'ok';
  const started = await tool('omp_start', { workspace, brief: {
    goal: 'Create add.js exporting function add(a, b) that returns a + b, and add.test.mjs that asserts add(2, 3) === 5 using node:assert.',
    decisions: 'Plain ESM JavaScript, no dependencies.',
    writeScope: ['add.js', 'add.test.mjs'],
    acceptance: ['node add.test.mjs exits 0'],
    constraints: ['Do not modify README.md', 'Do not commit'],
    verification: ['node add.test.mjs'],
  } });
  const jobId = started.jobId;
  report.checks.started = typeof jobId === 'string';
  const waited = JSON.parse(execFileSync(process.execPath, [path.join(RUNTIME, 'cli.js'), 'wait', jobId, '--workspace', workspace, '--timeout-ms', '900000'], { env, encoding: 'utf8', maxBuffer: 1 << 24 }).trim().split('\n').pop());
  report.checks.completed = waited.status === 'completed';
  const result = await tool('omp_result', { workspace, jobId });
  report.modelActual = result.data?.modelActual;
  report.checks.result = result.status === 'completed';
  try { execFileSync(process.execPath, ['add.test.mjs'], { cwd: workspace, stdio: 'pipe' }); report.checks.independentVerification = true; } catch { report.checks.independentVerification = false; }
  const changed = git('status', '--porcelain').trim().split('\n').filter(Boolean).map((line) => line.slice(3)).sort();
  report.changed = changed;
  report.checks.writeScopeOnly = JSON.stringify(changed) === JSON.stringify(['add.js', 'add.test.mjs']);
  report.checks.readmeUntouched = readFileSync(path.join(workspace, 'README.md'), 'utf8') === '# e2e\n';
  report.checks.recordedVersion = JSON.parse(readFileSync(execFileSync('find', [state, '-name', 'job.json'], { encoding: 'utf8' }).trim().split('\n')[0], 'utf8')).ompVersion === report.ompVersion;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
}
report.passed = !report.error && Object.values(report.checks).length === 8 && Object.values(report.checks).every(Boolean);
console.log(JSON.stringify(report));
if (report.passed) rmSync(base, { recursive: true, force: true }); else console.error('kept for inspection: ' + base);
process.exitCode = report.passed ? 0 : 1;
