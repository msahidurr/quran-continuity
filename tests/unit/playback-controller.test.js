'use strict';

/*
 * Drives the real AudioDetector + PlaybackController with a fake Quran.com page.
 * Bridge events are fed in as the page bridge would post them.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const site = require('../../src/content/quran-site.js');
const { AudioDetector } = require('../../src/content/audio-detector.js');
const { PlaybackController } = require('../../src/content/playback-controller.js');
const { normalizeSettings } = require('../../src/shared/validation.js');

const TIMING = { graceMs: 5, pageTimeoutMs: 60, playTimeoutMs: 60, pollMs: 2, secondMs: 1, announceMaxMs: 40 };
const audioUrl = (n) => `https://download.quranicaudio.com/qdc/mishari_al_afasy/murattal/${n}.mp3`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(predicate, ms = 500) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await wait(1);
  }
}

function setup({ settings = {}, startSurah = 1, page: pageOverrides = {}, announcer = null } = {}) {
  const win = { postMessage() {}, addEventListener() {}, location: { origin: 'https://quran.com' } };
  const detector = new AudioDetector({ site, win });
  const store = new Map();
  const calls = { soft: [], hard: [], clicks: [], rate: [] };
  let urlSurah = startSurah;
  let controller;

  const audio = { mediaId: 1, session: 0, surah: startSurah, currentTime: 0, duration: 100, paused: true, ended: false, playbackRate: 1 };

  function feed(event, patch = {}, extra = {}) {
    Object.assign(audio, patch);
    detector.ingest({
      event,
      media: { ...audio, src: audioUrl(audio.surah), isPrimary: true },
      ...extra,
    });
  }

  const page = {
    autoPlayOnClick: true,
    ready: true,
    softResult: { ok: true },
    parseUrlSurah: (href) => site.parseLocation(href).surah,
    getUrlSurah: () => urlSurah,
    async softNavigate(n) {
      calls.soft.push(n);
      if (this.softResult.ok) {
        urlSurah = n;
        controller.handleUrlChange(`https://quran.com/${n}`);
      }
      return this.softResult;
    },
    hardNavigate: (n) => calls.hard.push(n),
    isChapterPageReady(n) {
      return this.ready && urlSurah === n;
    },
    clickListenButton() {
      calls.clicks.push(urlSurah);
      if (this.autoPlayOnClick) {
        const n = urlSurah;
        setTimeout(() => {
          feed('play', { surah: n, session: audio.session + 1, paused: false, ended: false, currentTime: 0 });
          feed('playing');
        }, 1);
      }
      return true;
    },
    setPlaybackRate: (id, rate) => calls.rate.push(rate),
    ...pageOverrides,
  };

  const statuses = [];
  const notices = [];
  controller = new PlaybackController({
    page,
    detector,
    store: { load: (k) => store.get(k) ?? null, save: (k, v) => store.set(k, v), remove: (k) => store.delete(k) },
    announcer,
    notify: (n) => notices.push(n),
    onStatus: (s) => statuses.push(s),
    timing: TIMING,
  });
  controller.setSettings(normalizeSettings({ retryDelaySeconds: 1, ...settings }));
  detector.onMediaEvent((evt) => controller.handleMediaEvent(evt));

  const navigateUser = (n) => {
    urlSurah = n;
    controller.handleUrlChange(`https://quran.com/${n}`);
  };

  return {
    controller, detector, page, calls, audio, feed, store, notices, statuses, navigateUser,
    startPlaying() {
      feed('play', { session: audio.session + 1, paused: false });
      feed('playing');
    },
    finish() {
      feed('pause', { paused: true, ended: true, currentTime: audio.duration });
      feed('ended');
    },
  };
}

test('AC-01: a finished surah moves on to the next one and verifies playback', async () => {
  const h = setup();
  h.startPlaying();
  assert.equal(h.controller.state, 'playing');
  h.finish();
  await until(() => h.controller.state === 'playing' && h.audio.surah === 2);
  assert.deepEqual(h.calls.soft, [2]);
  assert.deepEqual(h.calls.clicks, [2]);
  assert.equal(h.controller.transition, null);
});

test('consecutive surahs keep advancing', async () => {
  const h = setup();
  h.startPlaying();
  for (const expected of [2, 3, 4]) {
    h.finish();
    await until(() => h.controller.state === 'playing' && h.audio.surah === expected);
  }
  assert.deepEqual(h.calls.soft, [2, 3, 4]);
});

test('AC-02: no navigation when auto-play is off', async () => {
  const h = setup({ settings: { autoPlayEnabled: false } });
  h.startPlaying();
  h.finish();
  await wait(30);
  assert.deepEqual(h.calls.soft, []);
  assert.equal(h.controller.state, 'idle');
});

test('AC-03/AC-04: manual pause never advances; resume continues', async () => {
  const h = setup();
  h.startPlaying();
  h.feed('pause', { paused: true, currentTime: 40 });
  await wait(30);
  assert.equal(h.controller.state, 'paused');
  assert.deepEqual(h.calls.soft, []);
  h.feed('play', { paused: false, session: h.audio.session + 1 });
  h.feed('playing');
  assert.equal(h.controller.state, 'playing');
});

test('an ended event before the real end is ignored', async () => {
  const h = setup();
  h.startPlaying();
  h.feed('ended', { paused: true, ended: true, currentTime: 30 });
  await wait(30);
  assert.deepEqual(h.calls.soft, []);
});

test('AC-05: Next Surah works without waiting and ignores the ending surah', async () => {
  const h = setup({ settings: { endSurah: 1 } });
  h.startPlaying();
  const result = h.controller.next();
  assert.deepEqual(result, { ok: true, target: 2 });
  await until(() => h.controller.state === 'playing' && h.audio.surah === 2);
});

test('Next Surah reports the end of the Quran', () => {
  const h = setup({ startSurah: 114 });
  assert.equal(h.controller.next().ok, false);
});

test('AC-06/AC-14: following a surah the user picked', async () => {
  const h = setup();
  h.startPlaying();
  h.navigateUser(36);
  h.feed('play', { surah: 36, session: h.audio.session + 1, paused: false });
  h.feed('playing');
  h.finish();
  await until(() => h.controller.state === 'playing' && h.audio.surah === 37);
  assert.deepEqual(h.calls.soft, [37]);
});

test('AC-07: stops after the ending surah', async () => {
  const h = setup({ settings: { endSurah: 1 } });
  h.startPlaying();
  h.finish();
  await wait(30);
  assert.deepEqual(h.calls.soft, []);
  assert.match(h.controller.notice, /ending surah/);
  assert.equal(h.notices.length, 1);
});

test('AC-08: duplicate ended events cause one transition', async () => {
  const h = setup();
  h.startPlaying();
  h.finish();
  h.feed('ended');
  h.feed('ended');
  await until(() => h.controller.state === 'playing' && h.audio.surah === 2);
  await wait(20);
  assert.deepEqual(h.calls.soft, [2]);
});

test('a restart during the grace period (site repeat) cancels the move', async () => {
  const h = setup();
  h.startPlaying();
  h.finish();
  h.feed('play', { session: h.audio.session + 1, paused: false, ended: false, currentTime: 0 });
  await wait(30);
  assert.deepEqual(h.calls.soft, []);
});

test('AC-09/AC-10: retries within the limit, then shows an error and stops', async () => {
  const h = setup({ settings: { retryCount: 2 } });
  h.page.ready = false;
  h.startPlaying();
  h.finish();
  await until(() => h.controller.state === 'error', 2000);
  assert.equal(h.statuses.filter((s) => s.transition && s.transition.attempt === 3).length > 0, true);
  assert.match(h.controller.lastError, /after 3 attempts/);
  assert.equal(h.notices.at(-1).level, 'error');
  const before = h.calls.soft.length;
  await wait(100);
  assert.equal(h.calls.soft.length, before, 'no further retries after giving up');
});

test('the error state survives the pause event the site sends after a failed load', async () => {
  const h = setup({ settings: { retryCount: 0 } });
  h.page.autoPlayOnClick = false;
  h.page.clickListenButton = function () {
    setTimeout(() => h.feed('error', { surah: 2 }), 1);
    return true;
  };
  h.startPlaying();
  h.finish();
  await until(() => h.controller.state === 'error');
  h.feed('pause', { surah: 2, paused: true, ended: false, currentTime: 0 });
  assert.equal(h.controller.state, 'error');
  h.feed('play', { surah: 2, session: h.audio.session + 1, paused: false });
  h.feed('playing');
  assert.equal(h.controller.state, 'playing');
  assert.equal(h.controller.lastError, null);
});

test('a retry succeeds when the page recovers', async () => {
  const h = setup({ settings: { retryCount: 2 } });
  h.page.ready = false;
  h.startPlaying();
  h.finish();
  await until(() => h.controller.transition && h.controller.transition.attempt === 2, 2000);
  h.page.ready = true;
  await until(() => h.controller.state === 'playing' && h.audio.surah === 2, 2000);
});

test('AC-15: blocked autoplay is reported without retrying or claiming success', async () => {
  const h = setup({ settings: { retryCount: 3 } });
  h.page.autoPlayOnClick = false;
  h.page.clickListenButton = function () {
    h.calls.clicks.push(2);
    setTimeout(() => h.feed('play-rejected', { surah: 2 }, { errorName: 'NotAllowedError' }), 1);
    return true;
  };
  h.startPlaying();
  h.finish();
  await until(() => h.controller.state === 'error');
  assert.match(h.controller.lastError, /blocked autoplay/);
  assert.equal(h.calls.clicks.length, 1);
});

test('AbortError from a replaced load is not treated as failure', async () => {
  const h = setup();
  const click = h.page.clickListenButton.bind(h.page);
  h.page.clickListenButton = function () {
    h.feed('play-rejected', {}, { errorName: 'AbortError' });
    return click();
  };
  h.startPlaying();
  h.finish();
  await until(() => h.controller.state === 'playing' && h.audio.surah === 2);
});

test('turning auto-play off cancels a pending automatic move', async () => {
  const h = setup();
  h.page.ready = false;
  h.startPlaying();
  h.finish();
  await until(() => h.controller.transition !== null);
  h.controller.setSettings(normalizeSettings({ autoPlayEnabled: false }));
  assert.equal(h.controller.transition, null);
  assert.notEqual(h.controller.state, 'transitioning');
});

test('Stop cancels the move and blocks later automatic moves; Resume re-enables', async () => {
  const h = setup();
  h.page.ready = false;
  h.startPlaying();
  h.finish();
  await until(() => h.controller.transition !== null);
  h.controller.stop();
  assert.equal(h.controller.transition, null);
  assert.equal(h.store.get('sessionStopped'), true);

  h.page.ready = true;
  h.navigateUser(5);
  h.feed('play', { surah: 5, session: h.audio.session + 1, paused: false, ended: false, currentTime: 0 });
  h.feed('playing');
  h.finish();
  await wait(30);
  assert.deepEqual(h.calls.soft, [2], 'no automatic move while stopped');

  h.controller.resume();
  h.feed('play', { session: h.audio.session + 1, paused: false, ended: false, currentTime: 0 });
  h.feed('playing');
  h.finish();
  await until(() => h.controller.state === 'playing' && h.audio.surah === 6);
});

test('AC-12: user playing a different surah mid-transition wins', async () => {
  const h = setup();
  h.page.ready = false;
  h.startPlaying();
  h.finish();
  await until(() => h.controller.transition !== null);
  h.feed('play', { surah: 40, session: h.audio.session + 1, paused: false, ended: false, currentTime: 0 });
  h.feed('playing');
  assert.equal(h.controller.transition, null);
  assert.equal(h.controller.state, 'playing');
});

test('user opening another page mid-transition cancels it', async () => {
  const h = setup();
  h.page.ready = false;
  h.startPlaying();
  h.finish();
  await until(() => h.controller.transition !== null && h.calls.soft.length === 1);
  h.navigateUser(80);
  assert.equal(h.controller.transition, null);
});

test('falls back to a full page load and resumes the move after it', async () => {
  const h = setup();
  h.page.softResult = { ok: false, error: 'no router' };
  h.startPlaying();
  h.finish();
  await until(() => h.calls.hard.length === 1);
  assert.deepEqual(h.calls.hard, [2]);
  const pending = h.store.get('pending');
  assert.equal(pending.target, 2);

  // Simulate the reloaded page: a fresh controller on /2 with the same tab storage.
  const next = setup({ startSurah: 2 });
  for (const [k, v] of h.store) next.store.set(k, v);
  h.controller.clearTransition(); // the old page is gone
  next.controller.resumeFromStore();
  await until(() => next.controller.state === 'playing' && next.audio.surah === 2);
  assert.equal(next.store.has('pending'), false);
});

test('restores the previous playback speed on the new surah', async () => {
  const h = setup();
  h.startPlaying();
  h.feed('ratechange', { playbackRate: 1.5 });
  h.page.clickListenButton = function () {
    setTimeout(() => {
      h.feed('play', { surah: 2, session: h.audio.session + 1, paused: false, ended: false, currentTime: 0, playbackRate: 1 });
      h.feed('playing');
    }, 1);
    return true;
  };
  h.finish();
  await until(() => h.controller.state === 'playing' && h.audio.surah === 2);
  assert.deepEqual(h.calls.rate, [1.5]);
});

function fakeAnnouncer(behaviour = 'resolve') {
  const a = { calls: [], cancels: 0, finish: null };
  a.announce = (n) => {
    a.calls.push(n);
    if (behaviour === 'hang') return new Promise(() => {});
    if (behaviour === 'reject') return Promise.reject(new Error('no voice'));
    return new Promise((resolve) => (a.finish = resolve));
  };
  a.cancel = () => a.cancels++;
  return a;
}

test('announces the next surah and starts it only after the announcement ends', async () => {
  const announcer = fakeAnnouncer();
  const h = setup({ announcer, settings: {} });
  h.startPlaying();
  h.finish();
  await until(() => announcer.calls.length === 1 && h.calls.soft.length === 1);
  assert.deepEqual(announcer.calls, [2]);
  await wait(15);
  assert.deepEqual(h.calls.clicks, [], 'Play pressed while still speaking');
  announcer.finish({ ok: true });
  await until(() => h.controller.state === 'playing' && h.audio.surah === 2);
});

test('a voice that never finishes or fails does not block playback', async () => {
  for (const behaviour of ['hang', 'reject']) {
    const announcer = fakeAnnouncer(behaviour);
    const h = setup({ announcer });
    h.startPlaying();
    h.finish();
    await until(() => h.controller.state === 'playing' && h.audio.surah === 2, 1000);
    assert.deepEqual(announcer.calls, [2], behaviour);
  }
});

test('announcement is off when disabled, and spoken once despite retries', async () => {
  const off = fakeAnnouncer();
  const h1 = setup({ announcer: off, settings: { announceNextSurah: false } });
  h1.startPlaying();
  h1.finish();
  await until(() => h1.controller.state === 'playing' && h1.audio.surah === 2);
  assert.deepEqual(off.calls, []);

  const once = fakeAnnouncer('reject');
  const h2 = setup({ announcer: once, settings: { retryCount: 2 } });
  h2.page.ready = false;
  h2.startPlaying();
  h2.finish();
  await until(() => h2.controller.state === 'error', 2000);
  assert.deepEqual(once.calls, [2]);
});

test('cancelling a move stops the announcement', async () => {
  const announcer = fakeAnnouncer('hang');
  const h = setup({ announcer });
  h.page.ready = false;
  h.startPlaying();
  h.finish();
  await until(() => h.controller.transition !== null);
  h.controller.stop();
  assert.equal(announcer.cancels, 1);
});

test('Next Surah from the popup is announced too', async () => {
  const announcer = fakeAnnouncer('reject');
  const h = setup({ announcer, startSurah: 17 });
  h.startPlaying();
  h.controller.next();
  await until(() => h.controller.state === 'playing' && h.audio.surah === 18);
  assert.deepEqual(announcer.calls, [18]);
});
