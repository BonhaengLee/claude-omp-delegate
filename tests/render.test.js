import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { previewText, renderCancel, renderDoctor, renderProgress, renderResult, renderStatus } from '../src/render.js';

const artifacts = { brief: '/state/job/brief.json', events: '/state/job/events.jsonl', stderr: '/state/job/stderr.log', result: '/state/job/result.json', sessionDir: '/state/job/sessions' };
const brief = { goal: 'Implement a deterministic clamp helper', decisions: 'Throw for invalid ranges', writeScope: ['clamp.js'], acceptance: ['Bounds are enforced'], constraints: ['Preserve dirty files'], verification: ['Run node clamp.js'] };
const baseJob = { version: 1, id: '11111111-1111-4111-8111-111111111111', workspace: '/tmp/workspace', lockKey: '/tmp/workspace', status: 'running', createdAt: new Date(Date.now() - 2500).toISOString(), updatedAt: new Date().toISOString(), sessionDir: artifacts.sessionDir, modelRequested: 'openai-codex/gpt-6-astra', modelActual: 'openai-codex/gpt-6-astra', thinking: 'medium', workerNonce: '22222222-2222-4222-8222-222222222222', warnings: [], activity: 'tool: eval' };
const details = { brief, artifacts };

function completedJob() {
  return { ...baseJob, status: 'completed', updatedAt: new Date().toISOString(), result: { finalText: 'The assistant claims PASS, but that prose is not acceptance evidence.', text: 'The assistant claims PASS, but that prose is not acceptance evidence.', exitCode: 0, verification: [{ tool: 'eval', isError: false }], evidence: { changed: ['clamp.js'], outsideWriteScope: [] } } };
}

test('preview is UTF-8 bounded and points to the artifact for long output', () => {
  const output = previewText('한글 '.repeat(3000));
  assert.ok(Buffer.byteLength(output, 'utf8') <= 2048);
  assert.match(output, /미리보기/);
});

test('progress rendering exposes actual model, activity, elapsed time, and cancel action', () => {
  const rendered = renderProgress(baseJob, details);
  assert.equal(rendered.status, 'running');
  assert.equal(rendered.jobId, baseJob.id);
  assert.match(rendered.summary, /변경/);
  assert.match(rendered.summary, /검증/);
  assert.match(rendered.summary, /주의/);
  assert.match(rendered.summary, /다음 행동/);
  assert.match(rendered.summary, /실제 모델: openai-codex\/gpt-6-astra/);
  assert.match(rendered.summary, /tool: eval/);
  const pending = renderProgress({ ...baseJob, modelActual: undefined }, details);
  assert.match(pending.summary, /요청 모델\(실제 미확인\): openai-codex\/gpt-6-astra/);
  assert.deepEqual(rendered.nextActions, ['/omp:cancel ' + baseJob.id, '/omp:status 로 진행 상태를 확인하세요.']);
});

test('result rendering reports observed changes and exposes only existing artifacts', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'omp-render-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const resultPath = join(dir, 'result.json');
  writeFileSync(resultPath, JSON.stringify(completedJob().result));
  const rendered = renderResult(completedJob(), { ...details, artifacts: { ...artifacts, result: resultPath } });
  assert.equal(rendered.status, 'completed');
  assert.match(rendered.summary, /clamp\.js/);
  assert.match(rendered.summary, /acceptance PASS로 자동 판정하지 않습니다/);
  assert.match(rendered.summary, /직접 검토해야 합니다/);
  assert.equal(rendered.data.artifacts.result, resultPath);
  assert.equal(rendered.data.artifacts.events, undefined);
  const missing = renderResult({ ...baseJob, status: 'failed' }, details);
  assert.equal(missing.data.artifacts.result, undefined);
  assert.ok(!missing.summary.includes(artifacts.result));
  assert.match(rendered.data.finalTextPreview, /claims PASS/);
});

test('status is a normal empty state and points to implement', async () => {
  const rendered = await renderStatus([]);
  assert.equal(rendered.status, 'ok');
  assert.deepEqual(rendered.data.jobs, []);
  assert.match(rendered.summary, /omp:implement/);
  const pending = await renderStatus([{ ...baseJob, modelActual: undefined }], { detailsResolver: async () => details });
  assert.match(pending.summary, /요청 모델\(실제 미확인\): openai-codex\/gpt-6-astra/);
});

test('cancel and doctor use the shared envelope renderer', () => {
  const cancelled = renderCancel(null);
  assert.equal(cancelled.status, 'ok');
  assert.match(cancelled.summary, /취소할 실행 중 작업이 없습니다/);
  const pendingCancel = renderCancel(baseJob, details);
  assert.equal(pendingCancel.status, 'running');
  assert.match(pendingCancel.summary, /취소 요청이 기록되었습니다/);
  for (const status of ['completed', 'failed', 'cancelled', 'interrupted']) {
    const terminal = { ...completedJob(), status };
    const terminalRendered = renderCancel(terminal, details);
    const fastFinish = renderProgress(terminal, details);
    assert.equal(fastFinish.status, status);
    assert.ok(fastFinish.nextActions.every(action => !action.startsWith('/omp:cancel')));
    assert.equal(terminalRendered.status, status);
    assert.doesNotMatch(terminalRendered.summary, /취소 요청이 기록되었습니다|OMP 구현 중|실행 중입니다/);
  }
  const doctor = renderDoctor({ executable: '/tmp/omp', ompVersion: '18.3.0', warnings: [], active: [] });
  assert.match(doctor.summary, /TUI statusline과 Telegram extension/);
  assert.equal(doctor.data.launcher.cxd, false);
  assert.equal(typeof doctor.data.platform.supported, 'boolean');
});
