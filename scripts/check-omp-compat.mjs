#!/usr/bin/env node
/**
 * Classify the latest published OMP (npm @oh-my-pi/pi-coding-agent) against OMP_COMPAT.
 * exit 0: tested | exit 0 + GitHub warning annotation: untested (inside range) | exit 1: outside range or lookup failure.
 * Pass --version <x.y.z> to classify a specific version offline.
 */
import { OMP_COMPAT, classifyOmpVersion } from '../src/contracts.js';

const REGISTRY_URL = 'https://registry.npmjs.org/@oh-my-pi/pi-coding-agent/latest';

async function latestVersion() {
  const response = await fetch(REGISTRY_URL, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error('npm registry lookup failed: HTTP ' + response.status);
  const body = await response.json();
  if (typeof body?.version !== 'string') throw new Error('npm registry response has no version');
  return body.version;
}

try {
  const flag = process.argv.indexOf('--version');
  const version = flag === -1 ? await latestVersion() : process.argv[flag + 1];
  const verdict = classifyOmpVersion(version);
  console.log(JSON.stringify({ latest: version, status: verdict.status, range: OMP_COMPAT.min + ' <= v < ' + OMP_COMPAT.belowMajor + '.0.0', tested: OMP_COMPAT.tested }));
  if (verdict.status === 'untested') console.log('::warning title=Untested OMP release::' + verdict.warning + ' Run `node scripts/host-e2e.mjs` on a host and add it to OMP_COMPAT.tested.');
  if (!verdict.accepted) { console.log('::error title=OMP outside supported range::' + verdict.warning); process.exitCode = 1; }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
