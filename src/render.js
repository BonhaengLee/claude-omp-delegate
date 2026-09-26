// @ts-check
/** User-facing envelopes shared by MCP tools and the CLI. Text comes from ./messages.js (en/ko). */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIMITS, OMP_ALLOW_UNSUPPORTED_ENV, OMP_COMPAT, OMP_INSTALL_HINTS, TERMINAL } from './contracts.js';
import { jobDetails as defaultJobDetails } from './jobs.js';
import { messages } from './messages.js';

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
  const marker = messages().previewMarker;
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
  return messages().elapsed(value);
}

/** @param {number} value */
function compactNumber(value) {
  if (value >= 1_000_000) return (value / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (value >= 1_000) return (value / 1_000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(Math.round(value));
}
/** @param {number} value */
function money(value) {
  return '$' + (value > 0 && value < 0.01 ? value.toFixed(4) : value.toFixed(2));
}
/** @param {Job} job @returns {string[]} */
function usageLines(job) {
  const usage = job.usage;
  if (!usage || usage.messages === 0) return [];
  const m = messages();
  return [m.usage(m.tokenParts(compactNumber(usage.input), compactNumber(usage.output), compactNumber(usage.cacheRead)), money(usage.cost), usage.messages)];
}
/** @param {Job} job @param {number} [limit] @returns {string[]} */
function recentLines(job, limit = 5) {
  const recent = (job.recentActivity ?? []).slice(-limit);
  return recent.length ? [messages().recent + recent.join(', ')] : [];
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
    activity: job.activity ?? messages().noActivity,
    ...(job.usage ? { usage: job.usage } : {}),
    ...(job.recentActivity?.length ? { recentActivity: job.recentActivity } : {}),
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
  return label + '\n' + (normalized.length ? normalized.map((line) => '- ' + line).join('\n') : '- ' + messages().none);
}
/** @param {string[]} change @param {string[]} verification @param {string[]} caution @param {string[]} next */
function card(change, verification, caution, next) {
  const h = messages().heading;
  return [group(h.change, change), group(h.verification, verification), group(h.caution, caution), group(h.next, next)].join('\n\n');
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
  const m = messages();
  const modelLabel = job.modelActual ? m.modelActual : m.modelRequested;
  const activity = job.activity ?? m.preparingWorker;
  const data = safeJobData(job, details);
  const nextActions = ['/omp:cancel ' + job.id, m.checkProgress];
  const summary = card([details.brief.goal], [m.implementing + ' | ' + job.id.slice(0, 8), modelLabel + model, m.activity + activity, ...recentLines(job), m.elapsedLabel + elapsedLabel(elapsedMs(job)), ...usageLines(job)], [m.runningNoEta], nextActions);
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
  const m = messages();
  const verificationLines = [];
  if (typeof run.exitCode === 'number' || run.exitCode === null) verificationLines.push(m.exitCode + asText(run.exitCode));
  if (typeof job.modelActual === 'string') verificationLines.push(m.modelActual + job.modelActual);
  verificationLines.push(...usageLines(job));
  if (verification) verificationLines.push(m.toolResults(verification));
  else verificationLines.push(m.noVerification);
  if (evidence.after && typeof evidence.after === 'object') verificationLines.push(m.evidenceSaved);

  const changes = changed.length ? changed : [m.noChanges];
  const warnings = [...job.warnings];
  const cautions = [];
  if (job.status === 'completed') cautions.push(m.completedReview);
  else if (job.status === 'cancelled') cautions.push(m.cancelledNoRollback);
  else if (job.status === 'interrupted') cautions.push(m.interrupted);
  else cautions.push(m.notCompleted);
  if (job.error) cautions.push(job.error.code + ': ' + job.error.message);
  if (outside.length) cautions.push(m.outsideScope(outside.join(', ')));
  if (details.artifacts.result && existsSync(details.artifacts.result)) cautions.push(m.resultArtifact + details.artifacts.result);
  if (details.artifacts.events && existsSync(details.artifacts.events)) cautions.push(m.eventsArtifact + details.artifacts.events);
  if (details.artifacts.stderr && existsSync(details.artifacts.stderr)) cautions.push(m.stderrArtifact + details.artifacts.stderr);

  const finalText = asText(result.finalText ?? result.text ?? '');
  const data = {
    ...safeJobData(job, details),
    changed,
    artifacts: Object.fromEntries(Object.entries(details.artifacts).filter(([,value]) => existsSync(value))),
    ...(finalText ? { finalTextPreview: previewText(finalText), finalTextBytes: Buffer.byteLength(finalText, 'utf8') } : {}),
  };
  const nextActions = job.status === 'completed'
    ? [m.reviewDiff, m.followup(job.id)]
    : job.status === 'cancelled'
      ? [m.reviewThenNew]
      : [m.checkArtifacts, m.doctorRecover(job.id)];
  const summary = card(changes, verificationLines, cautions, nextActions);
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
  const m = messages();
  if (!cards.length) {
    const nextActions = [m.startNew];
    return envelope({ status: 'ok', summary: card([m.noJobs], [m.queriedState], [m.nothingToShow], nextActions), nextActions, data: { jobs: [] } });
  }
  const active = cards.filter((item) => !TERMINAL_SET.has(item.status));
  const nextActions = active.length ? active.map((item) => '/omp:cancel ' + item.id) : [m.reviewLatest(cards[0].id)];
  const summary = card(
    cards.map((item) => '[' + item.status + '] ' + item.goal),
    [
      ...cards.map((item) => item.id.slice(0, 8) + ' | ' + (item.modelActual ? m.modelActual : m.modelRequested) + item.model + ' | ' + m.activity + item.activity + ' | ' + m.elapsedLabel + item.elapsed + (item.usage?.messages ? ' | ' + money(item.usage.cost) : '') + (!TERMINAL_SET.has(item.status) && item.recentActivity?.length ? ' | ' + m.recent + item.recentActivity.slice(-3).join(', ') : '')),
      ...(cards.some((item) => item.usage?.messages) ? [m.listedCost(money(cards.reduce((sum, item) => sum + (item.usage?.cost ?? 0), 0)), cards.length)] : []),
    ],
    active.length ? [m.dontEditWhileRunning] : [m.terminalNotAcceptance],
    nextActions,
  );
  return envelope({ status: active[0]?.status ?? cards[0].status, summary, nextActions, warnings: cards.flatMap((item) => jobs.find((job) => job.id === item.id)?.warnings ?? []), data: { jobs: cards } });
}

/** @param {Job|null} job @param {JobDetails} [details] */
export function renderCancel(job, details) {
  const m = messages();
  if (!job) {
    const nextActions = [m.checkActive, m.startIfNeeded];
    return envelope({ status: 'ok', summary: card([m.noActiveToCancel], [m.cancelNotRecorded], [m.terminalUnchanged], nextActions), nextActions });
  }
  // requestCancel returns a terminal job unchanged. Never describe that read-only
  // branch as a newly written cancellation intent or as work still running.
  if (TERMINAL_SET.has(job.status)) {
    if (details) return renderResult(job, details);
    return envelope({ status: job.status, jobId: job.id, summary: m.alreadyFinished, nextActions: [m.reviewResult(job.id)], warnings: job.warnings, data: safeJobData(job, details) });
  }
  const current = details ? renderProgress(job, details) : envelope({ status: job.status, jobId: job.id, summary: m.cancelRecorded, nextActions: [m.confirmTermination], warnings: job.warnings, data: safeJobData(job, details) });
  current.summary += '\n\n' + m.cancelPending;
  current.nextActions = [m.confirmActualTermination];
  return current;
}

/** @param {Job} job @param {JobDetails} details */
export function renderBusy(job, details) {
  const rendered = renderProgress(job, details);
  const m = messages();
  const reason = m.busy;
  rendered.summary += '\n\n' + group(m.heading.caution, [reason, m.busyCardOnly]);
  rendered.warnings = [...new Set([...rendered.warnings, reason])];
  rendered.nextActions = [m.checkState, '/omp:cancel ' + job.id];
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
  if (!supported) warnings.push(messages().unsupportedPlatform);
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
  const m = messages();
  const nextActions = [];
  if (plugin.hooksPresent !== true || plugin.guardPresent !== true) nextActions.push(m.installHooks);
  if (data.active && Array.isArray(data.active) && data.active.length) nextActions.push(m.activeJobsHint);
  else nextActions.push(m.startIfIdle);
  const versionStatus = typeof report.ompVersionStatus === 'string' && Object.hasOwn(m.versionStatus, report.ompVersionStatus) ? m.versionStatus[/** @type {'tested'|'untested'|'unsupported'} */ (report.ompVersionStatus)] : '';
  const summary = card(
    [m.doctorChange],
    [m.platform(asText(platform.name), platform.supported === true), m.ompExecutable + asText(report.executable), m.ompVersion + asText(report.ompVersion) + versionStatus, m.hooks(asText(plugin.hooksPresent), asText(plugin.guardPresent))],
    warnings,
    nextActions,
  );
  return envelope({ status: typeof report.status === 'string' ? report.status : 'ok', summary, nextActions, warnings, data });
}

/** @param {unknown} error */
export function renderError(error) {
  const value = /** @type {any} */ (error);
  const code = typeof value?.code === 'string' ? value.code : 'PROCESS_FAILED';
  const message = value?.message ? String(value.message) : String(error);
  const m = messages();
  const safeMessage = code === 'WORKSPACE_BUSY' ? m.busyNoCard : message;
  const range = { min: OMP_COMPAT.min, belowMajor: OMP_COMPAT.belowMajor, allowEnv: OMP_ALLOW_UNSUPPORTED_ENV };
  const nextActions = code === 'OMP_NOT_FOUND' || code === 'VERSION_UNSUPPORTED'
    ? [...OMP_INSTALL_HINTS, m.rangeHint(range), ...(code === 'VERSION_UNSUPPORTED' ? [m.forceHint(range)] : [])]
    : [m.checkStatusOrDoctor];
  const warnings = [m.requestFailed];
  const data = { code, ...(code === 'WORKSPACE_BUSY' ? {} : (value?.details !== undefined ? { details: value.details } : {})) };
  return envelope({ status: 'failed', summary: card([m.errorChange], [m.errorCode + code], [safeMessage], nextActions), nextActions, warnings, data });
}

/** @param {Envelope} value */
export function renderJson(value) {
  return JSON.stringify(value) + '\n';
}
/** @param {Array<{job:Job,details:JobDetails}>} entries */
export function renderAmbiguous(entries) {
  const m=messages();
  const candidates=entries.map(({job,details})=>({jobId:job.id,shortId:job.id.slice(0,8),sessionId:job.sessionId,goal:previewText(details.brief.goal).split(/\r?\n/,1)[0],model:(job.modelActual?m.modelActual:m.modelRequested)+(job.modelActual??job.modelRequested),status:job.status}));
  const nextActions=[m.askOnce];
  return envelope({status:'failed',summary:card([m.notStarted],candidates.map(candidate=>candidate.shortId+' | '+candidate.goal+' | '+candidate.model),[m.ambiguous],nextActions),nextActions,warnings:[],data:{code:'AMBIGUOUS_SESSION',candidates}});
}
