#!/usr/bin/env node
/**
 * Point the repository marketplace (.claude-plugin/marketplace.json) at a published plugin zip.
 * Usage: node scripts/set-marketplace-release.mjs            (reads dist/<zip>.sha256 for package.json version)
 *        node scripts/set-marketplace-release.mjs --check    (offline schema/url consistency check)
 *        node scripts/set-marketplace-release.mjs --verify   (downloads the release zip and checks its digest)
 */
import crypto from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPOSITORY = 'BonhaengLee/claude-omp-delegate';
export const MARKETPLACE_NAME = 'claude-omp-delegate';

/** @param {string} version */
export function releaseZipUrl(version) {
  return 'https://github.com/' + REPOSITORY + '/releases/download/v' + version + '/claude-omp-delegate-omp-' + version + '.zip';
}

/** @param {string} version @param {string} sha256 */
export function repositoryMarketplace(version, sha256) {
  return {
    name: MARKETPLACE_NAME,
    owner: { name: 'BonhaengLee', url: 'https://github.com/' + REPOSITORY },
    metadata: { description: 'Delegate approved implementation briefs from Claude Code to a local OMP (oh-my-pi) runner.', version },
    plugins: [{
      name: 'omp',
      description: 'Durable Claude-to-OMP delegation: /omp:implement, /omp:status, /omp:result, /omp:followup, /omp:cancel, /omp:doctor.',
      version,
      source: { source: 'archive', url: releaseZipUrl(version), sha256 },
    }],
  };
}

/**
 * @param {unknown} value parsed marketplace.json
 * @returns {string[]} findings
 */
export function marketplaceFindings(value) {
  const findings = [];
  const market = /** @type {any} */ (value);
  if (market?.name !== MARKETPLACE_NAME) findings.push('marketplace name must be ' + MARKETPLACE_NAME);
  const plugins = Array.isArray(market?.plugins) ? market.plugins : [];
  if (plugins.length !== 1 || plugins[0]?.name !== 'omp') findings.push('marketplace must list exactly the omp plugin');
  const entry = plugins[0] ?? {};
  const source = entry.source ?? {};
  if (source.source !== 'archive') findings.push('omp source must be an archive release zip');
  if (typeof entry.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(entry.version)) findings.push('omp entry needs a semver version');
  else if (source.url !== releaseZipUrl(entry.version)) findings.push('omp archive url must be ' + releaseZipUrl(entry.version));
  if (typeof source.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(source.sha256)) findings.push('omp archive needs a sha256 digest');
  return findings;
}

async function main() {
  const packageJson = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const marketplacePath = path.join(ROOT, '.claude-plugin', 'marketplace.json');
  if (process.argv.includes('--check')) {
    const market = JSON.parse(await readFile(marketplacePath, 'utf8'));
    const findings = marketplaceFindings(market);
    if (findings.length) throw new Error('.claude-plugin/marketplace.json: ' + findings.join('; '));
    console.log(JSON.stringify({ marketplace: 'ok', version: market.plugins[0].version, url: market.plugins[0].source.url }));
    return;
  }
  if (process.argv.includes('--verify')) {
    const market = JSON.parse(await readFile(marketplacePath, 'utf8'));
    const findings = marketplaceFindings(market);
    if (findings.length) throw new Error(findings.join('\n'));
    const { url, sha256 } = market.plugins[0].source;
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok) throw new Error('download failed: HTTP ' + response.status + ' ' + url);
    const actual = crypto.createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex');
    if (actual !== sha256) throw new Error('published zip digest ' + actual + ' does not match marketplace ' + sha256);
    console.log(JSON.stringify({ url, sha256, verified: true }));
    return;
  }
  const zipName = 'claude-omp-delegate-omp-' + packageJson.version + '.zip';
  const checksum = (await readFile(path.join(ROOT, 'dist', zipName + '.sha256'), 'utf8')).trim();
  const match = /^([0-9a-f]{64}) {2}(\S+)$/.exec(checksum);
  if (!match || match[2] !== zipName) throw new Error('dist checksum does not describe ' + zipName);
  const market = repositoryMarketplace(packageJson.version, match[1]);
  await writeFile(marketplacePath, JSON.stringify(market, null, 2) + '\n', { mode: 0o644 });
  console.log(JSON.stringify({ marketplace: path.relative(ROOT, marketplacePath), version: packageJson.version, sha256: match[1] }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
