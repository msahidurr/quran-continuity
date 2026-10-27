'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const site = require('../../src/content/quran-site.js');
const { CompletionTracker } = require('../../src/content/audio-detector.js');

test('parseLocation reads numeric, slug and localized chapter URLs', () => {
  const cases = {
    'https://quran.com/1': 1,
    'https://quran.com/al-baqarah': 2,
    'https://quran.com/al-baqarah/255': 2,
    'https://quran.com/2:255': 2,
    'https://quran.com/2?startingVerse=5': 2,
    'https://quran.com/bn/al-kahf': 18,
    'https://quran.com/ar/114': 114,
    'https://quran.com/': null,
    'https://quran.com/juz/1': null,
    'https://quran.com/115': null,
    'not a url': null,
  };
  for (const [url, surah] of Object.entries(cases)) assert.equal(site.parseLocation(url).surah, surah, url);
  assert.equal(site.parseLocation('https://quran.com/bn/al-kahf').locale, 'bn');
  assert.equal(site.parseLocation('https://quran.com/al-kahf').locale, 'en');
});

test('surahFromAudioSrc reads chapter files and ignores word clips', () => {
  assert.equal(site.surahFromAudioSrc('https://download.quranicaudio.com/qdc/mishari_al_afasy/murattal/2.mp3'), 2);
  assert.equal(site.surahFromAudioSrc('https://download.quranicaudio.com/quran/abdullaah/114.mp3?x=1'), 114);
  assert.equal(site.surahFromAudioSrc('https://download.quranicaudio.com/quran/abdullaah/001.mp3'), 1);
  assert.equal(site.surahFromAudioSrc('https://audio.qurancdn.com/wbw/001_001_001.mp3'), null);
  assert.equal(site.surahFromAudioSrc('https://verses.quran.com/x/002255.mp3'), null);
  assert.equal(site.surahFromAudioSrc('https://x/200.mp3'), null);
  assert.equal(site.surahFromAudioSrc(''), null);
});

test('isChapterAudio accepts the primary player or chapter files only', () => {
  assert.equal(site.isChapterAudio({ src: 'https://x/qdc/r/murattal/3.mp3', isPrimary: false }), true);
  assert.equal(site.isChapterAudio({ src: 'https://x/stream?id=9', isPrimary: true }), true);
  assert.equal(site.isChapterAudio({ src: 'https://x/wbw/001_001_001.mp3', isPrimary: true }), false);
  assert.equal(site.isChapterAudio({ src: '', isPrimary: true }), false);
});

test('navigation paths', () => {
  assert.equal(site.routerPathForSurah(2), '/al-baqarah');
  assert.equal(site.hardPathForSurah(2, 'en'), '/2');
  assert.equal(site.hardPathForSurah(2, 'bn'), '/bn/2');
});

const ended = (over = {}) => ({ mediaId: 1, session: 1, ended: true, paused: true, currentTime: 100, duration: 100, ...over });

test('CompletionTracker accepts one genuine end per playback session', () => {
  const tracker = new CompletionTracker();
  assert.equal(tracker.check(ended(), 1).genuine, true);
  assert.deepEqual(tracker.check(ended(), 1), { genuine: false, reason: 'duplicate' });
  assert.equal(tracker.check(ended({ session: 2 }), 1).genuine, true);
});

test('CompletionTracker rejects stale players, early ends and unknown durations', () => {
  const tracker = new CompletionTracker();
  assert.equal(tracker.check(ended({ mediaId: 2 }), 1).reason, 'stale-instance');
  assert.equal(tracker.check(ended({ currentTime: 50 }), 1).reason, 'not-at-end');
  assert.equal(tracker.check(ended({ duration: Infinity }), 1).reason, 'unknown-duration');
  assert.equal(tracker.check(ended({ ended: false }), 1).reason, 'not-ended');
  // Rejections must not consume the session.
  assert.equal(tracker.check(ended(), 1).genuine, true);
});
