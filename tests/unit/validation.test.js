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

const { announcementFor } = require('../../src/shared/announcement.js');

test('announcement text in English and Arabic', () => {
  assert.deepEqual(announcementFor(2, 'en'), { text: 'Next surah: Al-Baqarah, number 2.', lang: 'en-US' });
  assert.deepEqual(announcementFor(18, 'ar'), { text: 'السورة التالية: سورة الكهف', lang: 'ar' });
  assert.equal(announcementFor(115, 'en'), null);
});

test('announcement settings are validated', () => {
  assert.equal(validateSettings({ announceNextSurah: false, announceLanguage: 'ar' }).valid, true);
  const { valid, errors } = validateSettings({ announceNextSurah: 'yes', announceLanguage: 'fr' });
  assert.equal(valid, false);
  assert.deepEqual(Object.keys(errors).sort(), ['announceLanguage', 'announceNextSurah']);
  assert.equal(normalizeSettings({ announceLanguage: 'xx' }).announceLanguage, 'en');
});

const { chooseSpeech, voiceFor } = require('../../src/shared/announcement.js');
const GOOGLE_VOICES = [
  { voiceName: 'Google US English', lang: 'en-US', remote: true },
  { voiceName: 'Google UK English Male', lang: 'en-GB', remote: true },
  { voiceName: 'Google Deutsch', lang: 'de-DE', remote: true },
];

test('chooseSpeech uses an Arabic voice when one is installed', () => {
  const voices = [...GOOGLE_VOICES, { voiceName: 'Microsoft Naayf', lang: 'ar-SA', remote: false }];
  assert.deepEqual(chooseSpeech(voices, 2, 'ar'), { text: 'السورة التالية: سورة البقرة', lang: 'ar', voiceName: 'Microsoft Naayf', fallback: false });
});

test('chooseSpeech falls back to English when no Arabic voice exists', () => {
  const s = chooseSpeech(GOOGLE_VOICES, 2, 'ar');
  assert.equal(s.fallback, true);
  assert.equal(s.text, 'Next surah: Al-Baqarah, number 2.');
  assert.equal(s.voiceName, 'Google US English');
});

test('chooseSpeech without any voices lets Chrome use its default', () => {
  assert.deepEqual(chooseSpeech([], 2, 'en'), { text: 'Next surah: Al-Baqarah, number 2.', lang: 'en-US', voiceName: null, fallback: false });
});

test('voiceFor prefers exact language, then local voices', () => {
  assert.equal(voiceFor(GOOGLE_VOICES, 'en-US').voiceName, 'Google US English');
  const voices = [{ voiceName: 'Online ar', lang: 'ar-EG', remote: true }, { voiceName: 'Local ar', lang: 'ar-SA', remote: false }];
  assert.equal(voiceFor(voices, 'ar').voiceName, 'Local ar');
  assert.equal(voiceFor(voices, 'fr'), null);
});
