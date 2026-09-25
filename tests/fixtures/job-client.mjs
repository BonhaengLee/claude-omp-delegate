#!/usr/bin/env node
import { doctor, followupJob, getJob, listJobs, requestCancel, startJob, waitForJob } from '../../src/jobs.js';
const [action, payloadText, ...flags] = process.argv.slice(2); const payload = payloadText ? JSON.parse(payloadText) : {};
const methods = { start: startJob, followup: followupJob, get: getJob, list: listJobs, status: listJobs, cancel: requestCancel, wait: waitForJob, doctor };
try { const method = methods[action]; if (!method) throw new Error('unknown client action: ' + action); const result = await method(payload); process.stdout.write(JSON.stringify({ ok: true, result }) + '\n'); if (flags.includes('--stay')) await new Promise((resolve) => { process.once('SIGTERM', resolve); process.once('SIGINT', resolve); }); }
catch (error) { process.stdout.write(JSON.stringify({ ok: false, error: { name: error?.name, code: error?.code, message: error?.message } }) + '\n'); process.exitCode = 2; }
