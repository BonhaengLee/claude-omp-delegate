// @ts-check
/** User-facing Korean envelopes shared by MCP tools and the CLI. */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIMITS, TERMINAL } from './contracts.js';
import { jobDetails as defaultJobDetails } from './jobs.js';

/** @typedef {import('./contracts.js').Job} Job */
/** @typedef {import('./contracts.js').Brief} Brief */
/** @typedef {{brief: Brief, artifacts: {brief:string,events:string,stderr:string,result:string,sessionDir:string}}} JobDetails */
/** @typedef {{status:string,jobId?:string,summary:string,nextActions:string[],warnings:string[],data?:Record<string,unknown>}} Envelope */

const PREVIEW_LIMIT = LIMITS.previewBytes;
const TERMINAL_SET = TERMINAL;

/** @param {unknown} value */
function asText(value) {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  return String(value);
}

/** @param {unknown} value @param {number} [limit] */
export function previewText(value, limit = PREVIEW_LIMIT) {
  const text = asText(value);
  if (limit <= 0) return '';
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.byteLength <= limit) return text;
  const marker = '\n… [2KiB 미리보기; 원문은 artifact 참조]';
  const markerBytes = Buffer.byteLength(marker, 'utf8');
  const budget = Math.max(0, limit - markerBytes);
  let prefix = bytes.subarray(0, budget).toString('utf8');
  while (Buffer.byteLength(prefix, 'utf8') > budget) prefix = prefix.slice(0, -1);
  let suffix = marker;
  while (Buffer.byteLength(prefix + suffix, 'utf8') > limit) suffix = suffix.slice(0, -1);
  return prefix + suffix;
}

/** @param {Job} job @param {number} [now] */
export function elapsedMs(job, now = Date.now()) {
  const start = Date.parse(job.createdAt);
  if (!Number.isFinite(start)) return 0;
  const end = TERMINAL_SET.has(job.status) ? Date.parse(job.updatedAt) : now;
  return Math.max(0, (Number.isFinite(end) ? end : now) - start);
}

/** @param {number} value */
function elapsedLabel(value) {
  if (value < 1000) return '<1초';
  const seconds = Math.floor(value / 1000);
  if (seconds < 60) return seconds + '초';
  const minutes = Math.floor(seconds / 60);
  return minutes + '분 ' + (seconds % 60) + '초';
}

/** @param {Job} job @param {JobDetails|undefined} details */
function safeJobData(job, details) {
  return {
    id: job.id,
    status: job.status,
    workspace: job.workspace,
    model: job.modelActual ?? job.modelRequested,
    modelRequested: job.modelRequested,
    ...(job.modelActual ? { modelActual: job.modelActual } : {}),
    ...(job.thinking ? { thinking: job.thinking } : {}),
    ...(job.sessionId ? { sessionId: job.sessionId } : {}),
    ...(job.parentJobId ? { parentJobId: job.parentJobId } : {}),
    activity: job.activity ?? '활동 정보 없음',
    elapsedMs: elapsedMs(job),
    elapsed: elapsedLabel(elapsedMs(job)),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    ...(details ? { artifacts: Object.fromEntries(Object.entries(details.artifacts).filter(([,value]) => existsSync(value))) } : {}),
  };
}

/** @param {string} label @param {string[]} lines */
function group(label, lines) {
  const normalized = lines.map((line) => asText(line).trim()).filter(Boolean);
  return label + '\n' + (normalized.length ? normalized.map((line) => '- ' + line).join('\n') : '- 없음');
}

/** @param {{status:string,jobId?:string,summary:string,nextActions?:string[],warnings?:string[],data?:Record<string,unknown>}} value @returns {Envelope} */
export function envelope(value) {
  const result = {
    status: value.status,
    ...(value.jobId ? { jobId: value.jobId } : {}),
    summary: value.summary,
    nextActions: value.nextActions ?? [],
    warnings: [...new Set((value.warnings ?? []).map(asText).filter(Boolean))],
    ...(value.data ? { data: value.data } : {}),
  };
  return result;
}

/** @param {Job} job @param {JobDetails} details @returns {Envelope} */
export function renderProgress(job, details) {
  if (TERMINAL_SET.has(job.status)) return renderResult(job, details);
  const model = job.modelActual ?? job.modelRequested;
  const modelLabel = job.modelActual ? '실제 모델: ' : '요청 모델(실제 미확인): ';
  const activity = job.activity ?? 'OMP worker 준비 중';
  const data = safeJobData(job, details);
  const nextActions = ['/omp:cancel ' + job.id, '/omp:status 로 진행 상태를 확인하세요.'];
  const summary = [
    group('변경', [details.brief.goal]),
    group('검증', ['OMP 구현 중 | ' + job.id.slice(0, 8), modelLabel + model, '활동: ' + activity, '경과: ' + elapsedLabel(elapsedMs(job))]),
    group('주의', ['실행 중입니다. 완료율이나 예상 시간은 제공하지 않습니다.']),
    group('다음 행동', nextActions),
  ].join('\n\n');
  return envelope({ status: job.status, jobId: job.id, summary, nextActions, warnings: job.warnings, data });
}

/** @param {unknown} value */
function stringArray(value) {
  return Array.isArray(value) ? value.map(asText).filter(Boolean) : [];
}

/** @param {Job} job @param {JobDetails} details @returns {Envelope} */
export function renderResult(job, details) {
  if (!TERMINAL_SET.has(job.status)) return renderProgress(job, details);
  const result = /** @type {any} */ (job.result && typeof job.result === 'object' ? job.result : {});
  const evidence = /** @type {any} */ (result.evidence && typeof result.evidence === 'object' ? result.evidence : {});
  const changed = stringArray(evidence.changed);
  const outside = stringArray(evidence.outsideWriteScope);
  const run = /** @type {any} */ (result.run && typeof result.run === 'object' ? result.run : result);
  const verification = stringArray(run.verification).length;
  const verificationLines = [];
  if (typeof run.exitCode === 'number' || run.exitCode === null) verificationLines.push('OMP 종료 코드 관측: ' + asText(run.exitCode));
  if (typeof job.modelActual === 'string') verificationLines.push('실제 모델: ' + job.modelActual);
  if (verification) verificationLines.push('도구 결과 ' + verification + '건 관측됨; acceptance PASS로 자동 판정하지 않습니다.');
  else verificationLines.push('실행 검증 근거가 없거나 해석되지 않았습니다.');
  if (evidence.after && typeof evidence.after === 'object') verificationLines.push('실행 전후 작업공간 evidence가 저장되었습니다.');

  const changes = changed.length ? changed : ['관측된 파일 변경 없음; 최종 응답 주장으로 대체하지 않습니다.'];
  const warnings = [...job.warnings];
  const cautions = [];
  if (job.status === 'completed') cautions.push('OMP 실행은 종료되었습니다. 변경 diff와 acceptance를 직접 검토해야 합니다.');
  else if (job.status === 'cancelled') cautions.push('작업이 취소되었습니다. 이미 발생한 변경은 자동 rollback하지 않습니다.');
  else if (job.status === 'interrupted') cautions.push('워커가 중단되었습니다. 자동 재실행하지 않으며 상태를 먼저 확인하세요.');
  else cautions.push('OMP 실행이 완료되지 않았습니다. 실패 원인과 artifact를 확인하세요.');
  if (job.error) cautions.push(job.error.code + ': ' + job.error.message);
  if (outside.length) cautions.push('writeScope 밖 변경이 관측되었습니다. 소유권은 추정하지 않습니다: ' + outside.join(', '));
  if (details.artifacts.result && existsSync(details.artifacts.result)) cautions.push('최종 원문과 실행 결과 artifact: ' + details.artifacts.result);
  if (details.artifacts.events && existsSync(details.artifacts.events)) cautions.push('원시 이벤트 로그(기본 출력에서 숨김): ' + details.artifacts.events);
  if (details.artifacts.stderr && existsSync(details.artifacts.stderr)) cautions.push('stderr 로그(기본 출력에서 숨김): ' + details.artifacts.stderr);

  const finalText = asText(result.finalText ?? result.text ?? '');
  const data = {
    ...safeJobData(job, details),
    changed,
    artifacts: Object.fromEntries(Object.entries(details.artifacts).filter(([,value]) => existsSync(value))),
    ...(finalText ? { finalTextPreview: previewText(finalText), finalTextBytes: Buffer.byteLength(finalText, 'utf8') } : {}),
  };
  const nextActions = job.status === 'completed'
    ? ['작업공간 diff와 acceptance를 수동 검토하세요.', '추가 요구는 /omp:followup ' + job.id + ' <요구>로 전달하세요.']
    : job.status === 'cancelled'
      ? ['현재 변경사항을 검토한 뒤 필요하면 새 작업을 시작하세요.']
      : ['artifact와 상태를 확인하세요.', '/omp:doctor로 복구 조건을 확인하세요. 복구는 CLI doctor --recover ' + job.id + '로 명시적으로 요청합니다.'];
  const summary = [
    group('변경', changes),
    group('검증', verificationLines),
    group('주의', cautions),
    group('다음 행동', nextActions),
  ].join('\n\n');
  return envelope({ status: job.status, jobId: job.id, summary, nextActions, warnings, data });
}

/** @param {Job[]} jobs @param {{detailsResolver?:(job:Job)=>Promise<JobDetails>}} [options] */
export async function renderStatus(jobs, options = {}) {
  const resolver = options.detailsResolver ?? defaultJobDetails;
  const selected = jobs.filter((job) => !TERMINAL_SET.has(job.status)).concat(jobs.filter((job) => TERMINAL_SET.has(job.status)).slice(0, 5));
  const details = await Promise.all(selected.map((job) => resolver(job)));
  const cards = selected.map((job, index) => {
    const detail = details[index];
    return { ...safeJobData(job, detail), goal: detail.brief.goal };
  });
  if (!cards.length) {
    const nextActions = ['/omp:implement <요구>로 새 작업을 시작하세요.'];
    return envelope({ status: 'ok', summary: [group('변경', ['실행 중이거나 종료된 작업이 없습니다.']), group('검증', ['공용 작업 상태를 조회했습니다.']), group('주의', ['표시할 작업이 없습니다.']), group('다음 행동', nextActions)].join('\n\n'), nextActions, data: { jobs: [] } });
  }
  const active = cards.filter((card) => !TERMINAL_SET.has(card.status));
  const nextActions = active.length ? active.map((card) => '/omp:cancel ' + card.id) : ['/omp:result ' + cards[0].id + '로 최근 결과를 검토하세요.'];
  const summary = [
    group('변경', cards.map((card) => '[' + card.status + '] ' + card.goal)),
    group('검증', cards.map((card) => card.id.slice(0, 8) + ' | ' + (card.modelActual ? '실제 모델: ' : '요청 모델(실제 미확인): ') + card.model + ' | 활동: ' + card.activity + ' | 경과: ' + card.elapsed)),
    group('주의', active.length ? ['실행 중인 작업은 같은 workspace에서 직접 수정하지 마세요.'] : ['종료 상태는 실행 완료와 acceptance 통과를 의미하지 않습니다.']),
    group('다음 행동', nextActions),
  ].join('\n\n');
  return envelope({ status: active[0]?.status ?? cards[0].status, summary, nextActions, warnings: cards.flatMap((card) => jobs.find((job) => job.id === card.id)?.warnings ?? []), data: { jobs: cards } });
}

/** @param {Job|null} job @param {JobDetails} [details] */
export function renderCancel(job, details) {
  if (!job) {
    const nextActions = ['/omp:status로 활성 작업을 확인하세요.', '필요하면 /omp:implement <요구>로 새 작업을 시작하세요.'];
    return envelope({ status: 'ok', summary: [group('변경', ['취소할 실행 중 작업이 없습니다.']), group('검증', ['취소 요청을 기록하지 않았습니다.']), group('주의', ['이미 종료된 작업은 상태를 변경하지 않습니다.']), group('다음 행동', nextActions)].join('\n\n'), nextActions });
  }
  // requestCancel returns a terminal job unchanged. Never describe that read-only
  // branch as a newly written cancellation intent or as work still running.
  if (TERMINAL_SET.has(job.status)) {
    if (details) return renderResult(job, details);
    return envelope({ status: job.status, jobId: job.id, summary: '작업은 이미 종료되었으며 취소 요청을 기록하지 않았습니다.', nextActions: ['/omp:result ' + job.id + '로 결과를 검토하세요.'], warnings: job.warnings, data: safeJobData(job, details) });
  }
  const current = details ? renderProgress(job, details) : envelope({ status: job.status, jobId: job.id, summary: '취소 요청이 기록되었습니다.', nextActions: ['/omp:status로 종료를 확인하세요.'], warnings: job.warnings, data: safeJobData(job, details) });
  current.summary += '\n\n취소 요청이 기록되었습니다. worker가 실제 종료와 process-group 소멸을 확인할 때까지 최종 취소로 표시하지 않습니다.';
  current.nextActions = ['/omp:status로 실제 종료를 확인하세요.'];
  return current;
}

/** @param {Job} job @param {JobDetails} details */
export function renderBusy(job, details) {
  const rendered = renderProgress(job, details);
  const reason = 'WORKSPACE_BUSY: 다른 OMP 작업이 이미 실행 중입니다.';
  rendered.summary += '\n\n' + group('주의', [reason, '현재 작업 카드만 표시합니다. lock nonce/PID는 노출하지 않습니다.']);
  rendered.warnings = [...new Set([...rendered.warnings, reason])];
  rendered.nextActions = ['/omp:status로 실제 상태를 확인하세요.', '/omp:cancel ' + job.id];
  return rendered;
}

/** @param {unknown} value */
function safeDoctorJob(value) {
  const job = /** @type {any} */ (value);
  if (!job || typeof job !== 'object') return undefined;
  return {
    id: job.id,
    status: job.status,
    workspace: job.workspace,
    ...(job.sessionId ? { sessionId: job.sessionId } : {}),
    ...(job.parentJobId ? { parentJobId: job.parentJobId } : {}),
    model: job.modelActual ?? job.modelRequested,
    ...(job.modelActual ? { modelActual: job.modelActual } : {}),
    activity: job.activity,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    ...(job.error ? { error: job.error } : {}),
    warnings: stringArray(job.warnings),
  };
}

/** @param {Record<string,unknown>} report */
function doctorEnvironment(report) {
  const input = /** @type {any} */ (report);
  const { job, recovered, ...publicReport } = input;
  const modulePath = fileURLToPath(import.meta.url);
  const configuredRoot = process.env.CLAUDE_PLUGIN_ROOT;
  const runtimeParent = path.resolve(path.dirname(modulePath), '..');
  const pluginRoot = configuredRoot && path.isAbsolute(configuredRoot) ? configuredRoot : runtimeParent;
  const hooksPath = path.join(pluginRoot, 'hooks', 'hooks.json');
  const guardPath = path.join(pluginRoot, 'scripts', 'guard.cjs');
  const supported = process.platform === 'darwin' || process.platform === 'linux';
  const warnings = [];
  if (!supported) warnings.push('지원 플랫폼은 macOS/Linux입니다. Windows는 지원하지 않습니다.');
  warnings.push('cxd와 동일한 launcher가 아닙니다. TUI statusline과 Telegram extension은 명시적으로 로드하지 않습니다.');
  return {
    ...publicReport,
    ...(job ? { job: safeDoctorJob(job) } : {}),
    ...(recovered ? { recovered: safeDoctorJob(recovered) } : {}),
    platform: { name: process.platform, supported },
    plugin: {
      root: pluginRoot,
      runtime: modulePath,
      hooksPath,
      guardPath,
      hooksPresent: existsSync(hooksPath),
      guardPresent: existsSync(guardPath),
    },
    launcher: { cxd: false, tuiStatusline: false, telegram: false },
    environmentWarnings: warnings,
  };
}

/** @param {Record<string,unknown>} report */
export function renderDoctor(report) {
  const data = /** @type {any} */ (doctorEnvironment(report));
  const reportWarnings = stringArray(report.warnings);
  const warnings = [...reportWarnings, ...stringArray(data.environmentWarnings)];
  const platform = data.platform && typeof data.platform === 'object' ? data.platform : {};
  const plugin = data.plugin && typeof data.plugin === 'object' ? data.plugin : {};
  const nextActions = [];
  if (plugin.hooksPresent !== true || plugin.guardPresent !== true) nextActions.push('패키지된 플러그인의 hooks/hooks.json과 scripts/guard.cjs 설치를 확인하세요.');
  if (data.active && Array.isArray(data.active) && data.active.length) nextActions.push('활성 작업은 /omp:status 또는 /omp:cancel로 확인하세요.');
  else nextActions.push('작업이 없으면 /omp:implement <요구>로 시작하세요.');
  const summary = [
    group('변경', ['doctor는 첫 실행 시 공용 config.json과 상태 디렉터리를 초기화할 수 있습니다. 로그인·업데이트·자동 계정 전환은 수행하지 않습니다.']),
    group('검증', ['플랫폼: ' + asText(platform.name) + (platform.supported ? ' (지원)' : ' (미지원)'), 'OMP 실행 파일: ' + asText(report.executable), 'OMP 버전: ' + asText(report.ompVersion), 'plugin hook: hooks.json=' + asText(plugin.hooksPresent) + ', guard.cjs=' + asText(plugin.guardPresent)]),
    group('주의', warnings),
    group('다음 행동', nextActions),
  ].join('\n\n');
  return envelope({ status: typeof report.status === 'string' ? report.status : 'ok', summary, nextActions, warnings, data });
}

/** @param {unknown} error */
export function renderError(error) {
  const value = /** @type {any} */ (error);
  const code = typeof value?.code === 'string' ? value.code : 'PROCESS_FAILED';
  const message = value?.message ? String(value.message) : String(error);
  const safeMessage = code === 'WORKSPACE_BUSY' ? 'Workspace가 사용 중이며 현재 작업 카드를 불러오지 못했습니다.' : message;
  const warnings = ['요청을 완료하지 못했습니다. 상태/로그를 확인하세요.'];
  const data = { code, ...(code === 'WORKSPACE_BUSY' ? {} : (value?.details !== undefined ? { details: value.details } : {})) };
  return envelope({ status: 'failed', summary: group('변경', ['오류 응답만으로 변경 여부를 단정할 수 없습니다. 현재 작업 상태를 확인하세요.']) + '\n\n' + group('검증', ['오류 코드: ' + code]) + '\n\n' + group('주의', [safeMessage]) + '\n\n' + group('다음 행동', ['/omp:status 또는 /omp:doctor로 상태를 확인하세요.']), nextActions: ['/omp:status 또는 /omp:doctor로 상태를 확인하세요.'], warnings, data });
}

/** @param {Envelope} value */
export function renderJson(value) {
  return JSON.stringify(value) + '\n';
}
/** @param {Array<{job:Job,details:JobDetails}>} entries */
export function renderAmbiguous(entries) {
  const candidates=entries.map(({job,details})=>({jobId:job.id,shortId:job.id.slice(0,8),sessionId:job.sessionId,goal:previewText(details.brief.goal).split(/\r?\n/,1)[0],model:(job.modelActual?'실제 모델: ':'요청 모델(실제 미확인): ')+(job.modelActual??job.modelRequested),status:job.status}));
  const nextActions=['선택 UI로 이어갈 세션을 한 번 질문하세요. 임의 최신 선택은 금지합니다.'];
  return envelope({status:'failed',summary:[group('변경',['작업을 시작하지 않았습니다.']),group('검증',candidates.map(candidate=>candidate.shortId+' | '+candidate.goal+' | '+candidate.model)),group('주의',['AMBIGUOUS_SESSION: 서로 다른 재개 후보가 있습니다.']),group('다음 행동',nextActions)].join('\n\n'),nextActions,warnings:[],data:{code:'AMBIGUOUS_SESSION',candidates}});
}
