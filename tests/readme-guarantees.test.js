import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('every test cited by the README guarantees table exists', async () => {
  const readme = await readFile(path.join(ROOT, 'README.md'), 'utf8');
  const section = readme.slice(readme.indexOf('## Guarantees you can check'), readme.indexOf('## What it provides'));
  const rows = section.split('\n').filter((line) => line.startsWith('| ') && !line.startsWith('| Guarantee') && !line.startsWith('| ---'));
  const cited = rows.flatMap((row) => [...row.split('|').at(-2).matchAll(/`([^`]+)`/g)].map((match) => match[1]));
  assert.ok(rows.length >= 8 && cited.length >= rows.length, 'guarantees table is missing or has rows without a cited test');
  const titles = [];
  for (const file of (await readdir(path.join(ROOT, 'tests'))).filter((name) => name.endsWith('.test.js'))) {
    const source = await readFile(path.join(ROOT, 'tests', file), 'utf8');
    titles.push(...[...source.matchAll(/^test\((['"])(.+?)\1/gm)].map((match) => match[2]));
  }
  assert.deepEqual(cited.filter((title) => !titles.some((existing) => existing.startsWith(title))), []);
});
