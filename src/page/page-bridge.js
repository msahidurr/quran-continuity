/*
 * Runs in the page's MAIN world at document_start (see manifest.json).
 *
 * The isolated content script cannot see audio elements created with `new Audio()`, catch the
 * promise returned by play(), observe history.pushState, or reach the Next.js router. This bridge
 * does exactly those things and reports them via window.postMessage. It takes no decisions of its
 * own: it only reports events and performs the two commands the content script sends
 * (client-side navigation and restoring playback speed).
 */
(() => {
  'use strict';

  if (window.__quranContinuityBridge) return;
  window.__quranContinuityBridge = true;

  // Keep in sync with BRIDGE in src/content/quran-site.js.
  const FROM_PAGE = 'quran-continuity/page';
  const TO_PAGE = 'quran-continuity/content';
  const PRIMARY_AUDIO_ID = 'audio-player';
  const MEDIA_EVENTS = ['play', 'playing', 'pause', 'ended', 'error', 'ratechange', 'emptied'];
  const MAX_TRACKED = 20; // word-by-word clips create many short-lived elements; don't keep them alive

  const ids = new WeakMap();
  const sessions = new WeakMap(); // incremented on every 'play', so duplicate 'ended' events can be told apart
  const tracked = new Set();
  let nextId = 1;

  function post(type, detail) {
    window.postMessage({ source: FROM_PAGE, type, ...detail }, location.origin);
  }

  function snapshot(el) {
    return {
      mediaId: ids.get(el),
      session: sessions.get(el) || 0,
      src: el.currentSrc || el.src || '',
      currentTime: el.currentTime,
      duration: el.duration,
      paused: el.paused,
      ended: el.ended,
      playbackRate: el.playbackRate,
      isPrimary: el.id === PRIMARY_AUDIO_ID,
    };
  }

  function track(el) {
    if (!(el instanceof HTMLAudioElement) || ids.has(el)) return;
    ids.set(el, nextId++);
    tracked.add(el);
    if (tracked.size > MAX_TRACKED) {
      for (const old of tracked) {
        if (tracked.size <= MAX_TRACKED) break;
        if (old.id !== PRIMARY_AUDIO_ID && old !== el) tracked.delete(old);
      }
    }
    for (const type of MEDIA_EVENTS) {
      el.addEventListener(type, () => {
        if (type === 'play') sessions.set(el, (sessions.get(el) || 0) + 1);
        post('media', { event: type, media: snapshot(el), errorCode: type === 'error' && el.error ? el.error.code : null });
      });
    }
  }

  // Audio played from script, including elements never attached to the DOM.
  const originalPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function play(...args) {
    track(this);
    const result = originalPlay.apply(this, args);
    if (ids.has(this) && result && typeof result.catch === 'function') {
      // Observe the rejection without altering the promise the page receives.
      result.catch((err) => {
        post('media', {
          event: 'play-rejected',
          media: snapshot(this),
          errorName: (err && err.name) || 'Error',
          errorMessage: String((err && err.message) || err),
        });
      });
    }
    return result;
  };

  // Audio elements in the DOM that may start through the autoplay attribute. Capture-phase listeners
  // on document see media events from attached elements; listeners added here still run at the target.
  document.addEventListener('play', (e) => track(e.target), true);
  document.addEventListener('loadstart', (e) => track(e.target), true);

  // SPA navigation.
  for (const method of ['pushState', 'replaceState']) {
    const original = history[method];
    history[method] = function patched(...args) {
      const result = original.apply(this, args);
      post('urlchange', { url: location.href });
      return result;
    };
  }
  window.addEventListener('popstate', () => post('urlchange', { url: location.href }));

  function navigate(requestId, path) {
    const router = window.next && window.next.router;
    if (!router || typeof router.push !== 'function') {
      post('navigate-result', { requestId, ok: false, error: 'Quran.com router is not available.' });
      return;
    }
    Promise.resolve()
      .then(() => router.push(path))
      .then(
        (ok) => post('navigate-result', { requestId, ok: ok !== false }),
        (err) => post('navigate-result', { requestId, ok: false, error: String((err && err.message) || err) }),
      );
  }

  function setPlaybackRate(mediaId, rate) {
    for (const el of tracked) {
      if (ids.get(el) === mediaId) el.playbackRate = rate;
    }
  }

  window.addEventListener('message', (e) => {
    const data = e.data;
    if (e.source !== window || !data || data.source !== TO_PAGE) return;
    switch (data.type) {
      case 'hello':
        post('hello', { url: location.href, media: [...tracked].map(snapshot) });
        break;
      case 'navigate':
        if (typeof data.path === 'string' && data.path.startsWith('/')) navigate(data.requestId, data.path);
        break;
      case 'set-rate':
        if (Number.isFinite(data.rate) && data.rate >= 0.25 && data.rate <= 4) setPlaybackRate(data.mediaId, data.rate);
        break;
    }
  });
})();
