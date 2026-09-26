import test from 'node:test';
import assert from 'node:assert/strict';
import { MESSAGES, currentLocale } from '../src/messages.js';
import { renderDoctor, renderError, renderStatus } from '../src/render.js';

test('locale: explicit env wins, then LC_ALL/LC_MESSAGES/LANG, default English', () => {
  assert.deepEqual([
    currentLocale({}),
    currentLocale({ LANG: 'ko_KR.UTF-8' }),
    currentLocale({ LANG: 'en_US.UTF-8' }),
    currentLocale({ LC_ALL: 'ko_KR.UTF-8', LANG: 'en_US.UTF-8' }),
    currentLocale({ LC_ALL: 'C', LANG: 'ko_KR.UTF-8' }),
    currentLocale({ OMP_DELEGATE_LANG: 'en', LANG: 'ko_KR.UTF-8' }),
    currentLocale({ OMP_DELEGATE_LANG: 'KO' }),
    currentLocale({ OMP_DELEGATE_LANG: 'fr', LANG: 'ko_KR' }),
    currentLocale({ LANG: 'kok_IN' }),
  ], ['en', 'ko', 'en', 'ko', 'en', 'en', 'ko', 'ko', 'en']);
});

test('both locales define exactly the same message keys', () => {
  const shape = (value) => Object.fromEntries(Object.entries(value).map(([key, item]) => [key, item && typeof item === 'object' ? shape(item) : typeof item]));
  assert.deepEqual(shape(MESSAGES.ko), shape(MESSAGES.en));
});

/** @param {'en'|'ko'} lang @param {() => any} run */
async function inLocale(lang, run) {
  const saved = process.env.OMP_DELEGATE_LANG; process.env.OMP_DELEGATE_LANG = lang;
  try { return await run(); } finally { if (saved === undefined) delete process.env.OMP_DELEGATE_LANG; else process.env.OMP_DELEGATE_LANG = saved; }
}

test('English cards contain no Hangul and keep machine fields identical to Korean cards', async () => {
  const doctorInput = { status: 'ok', executable: '/opt/omp', ompVersion: '18.3.2', ompVersionStatus: 'tested', warnings: [], active: [] };
  const error = Object.assign(new Error('OMP 19.0.0 is outside the supported range'), { code: 'VERSION_UNSUPPORTED' });
  const cards = async () => [renderDoctor(doctorInput), renderError(error), await renderStatus([])];
  const [en, ko] = [await inLocale('en', cards), await inLocale('ko', cards)];
  for (const envelope of en) assert.doesNotMatch(JSON.stringify(envelope.summary) + JSON.stringify(envelope.nextActions) + JSON.stringify(envelope.warnings), /[가-힣]/);
  assert.match(en[0].summary, /^Change\n/);
  assert.match(en[0].summary, /OMP version: 18\.3\.2 \(tested\)/);
  assert.match(ko[0].summary, /OMP 버전: 18\.3\.2 \(검증됨\)/);
  assert.deepEqual(en.map((item) => [item.status, item.data?.code]), ko.map((item) => [item.status, item.data?.code]));
  assert.equal(en[1].nextActions.filter((line) => line.includes('https://omp.sh/install')).length, 1);
});
