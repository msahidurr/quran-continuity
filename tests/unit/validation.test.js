'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { nextSurah, isValidSurahNumber, validateSettings, normalizeSettings, evaluateCompletion } = require('../../src/shared/validation.js');
const { DEFAULT_SETTINGS } = require('../../src/shared/defaults.js');
const { SURAHS, getSurah, surahNumberFromSlug } = require('../../src/shared/surahs.js');

test('surah data covers 1-114 in order', () => {
  assert.equal(SURAHS.length, 114);
  SURAHS.forEach((s, i) => assert.equal(s.number, i + 1));
  assert.equal(getSurah(2).slug, 'al-baqarah');
  assert.equal(surahNumberFromSlug('an-nas'), 114);
  assert.equal(surahNumberFromSlug('nope'), null);
});

test('isValidSurahNumber accepts only integers 1-114', () => {
  for (const ok of [1, 57, 114]) assert.equal(isValidSurahNumber(ok), true);
  for (const bad of [0, 115, -1, 1.5, '2', null, undefined, NaN]) assert.equal(isValidSurahNumber(bad), false);
});

test('nextSurah stays within 1-114', () => {
  assert.equal(nextSurah(1), 2);
  assert.equal(nextSurah(113), 114);
  assert.equal(nextSurah(114), null);
  assert.throws(() => nextSurah(0), RangeError);
  assert.throws(() => nextSurah(115), RangeError);
});

test('validateSettings accepts valid input and coerces numeric strings', () => {
  const { valid, value } = validateSettings({ autoPlayEnabled: false, endSurah: '18', retryCount: '0', retryDelaySeconds: 60 });
  assert.equal(valid, true);
  assert.equal(value.autoPlayEnabled, false);
  assert.equal(value.endSurah, 18);
  assert.equal(value.retryCount, 0);
  assert.equal(value.retryDelaySeconds, 60);
});

test('validateSettings rejects out-of-range and malformed values', () => {
  const { valid, errors } = validateSettings({
    autoPlayEnabled: 'yes',
    endSurah: 115,
    retryCount: 11,
    retryDelaySeconds: '2.5',
  });
  assert.equal(valid, false);
  assert.deepEqual(Object.keys(errors).sort(), ['autoPlayEnabled', 'endSurah', 'retryCount', 'retryDelaySeconds']);
});

test('validateSettings treats empty ending surah as none', () => {
  assert.equal(validateSettings({ endSurah: '' }).value.endSurah, null);
  assert.equal(validateSettings({ endSurah: null }).value.endSurah, null);
});

test('normalizeSettings fills defaults and replaces invalid fields', () => {
  assert.deepEqual(normalizeSettings(undefined), DEFAULT_SETTINGS);
  const s = normalizeSettings({ retryCount: 99, endSurah: 5, unknown: 'x' });
  assert.equal(s.retryCount, DEFAULT_SETTINGS.retryCount);
  assert.equal(s.endSurah, 5);
  assert.equal('unknown' in s, false);
});

test('evaluateCompletion continues to the next surah', () => {
  assert.deepEqual(evaluateCompletion(1, { endSurah: null }), { action: 'next', target: 2 });
});

test('evaluateCompletion stops at the ending surah and beyond it', () => {
  assert.deepEqual(evaluateCompletion(18, { endSurah: 18 }), { action: 'stop', reason: 'end-surah' });
  assert.deepEqual(evaluateCompletion(50, { endSurah: 18 }), { action: 'stop', reason: 'end-surah' });
  assert.deepEqual(evaluateCompletion(17, { endSurah: 18 }), { action: 'next', target: 18 });
});

test('evaluateCompletion stops after An-Nas', () => {
  assert.deepEqual(evaluateCompletion(114, { endSurah: null }), { action: 'stop', reason: 'end-of-quran' });
});
