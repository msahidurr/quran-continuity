/*
 * Receives events from the page bridge, keeps the latest snapshot of each chapter-audio element,
 * and tracks which element is the active player. CompletionTracker decides whether an 'ended'
 * event is a genuine, not-yet-handled completion.
 */
(function (root) {
  'use strict';

  const QC = (root.QC = root.QC || {});
  const isNode = typeof module !== 'undefined' && module.exports;

  const NAVIGATE_TIMEOUT_MS = 10000;
  const END_TOLERANCE_SECONDS = 1.5;
  const MAX_HANDLED_KEYS = 50;

  class CompletionTracker {
    constructor({ endToleranceSeconds = END_TOLERANCE_SECONDS } = {}) {
      this.endToleranceSeconds = endToleranceSeconds;
      this.handled = new Set();
    }

    /**
     * Returns { genuine: true } at most once per playback session of an element, and only when the
     * element is the active player and really reached the end of its media.
     */
    check(media, activeMediaId) {
      if (!media) return { genuine: false, reason: 'no-media' };
      if (activeMediaId != null && media.mediaId !== activeMediaId) return { genuine: false, reason: 'stale-instance' };
      const key = `${media.mediaId}:${media.session}`;
      if (this.handled.has(key)) return { genuine: false, reason: 'duplicate' };
      if (!media.ended) return { genuine: false, reason: 'not-ended' };
      if (!(Number.isFinite(media.duration) && media.duration > 0)) return { genuine: false, reason: 'unknown-duration' };
      if (media.currentTime < media.duration - this.endToleranceSeconds) return { genuine: false, reason: 'not-at-end' };

      this.handled.add(key);
      if (this.handled.size > MAX_HANDLED_KEYS) this.handled.delete(this.handled.values().next().value);
      return { genuine: true };
    }
  }

  class AudioDetector {
    constructor({ site, win }) {
      this.site = site;
      this.win = win;
      this.media = new Map();
      this.activeMediaId = null;
      this.mediaListeners = [];
      this.urlListeners = [];
      this.pendingNavigations = new Map();
      this.requestSeq = 0;
      this.onMessage = this.onMessage.bind(this);
    }

    start() {
      this.win.addEventListener('message', this.onMessage);
      this.send('hello');
    }

    onMediaEvent(fn) {
      this.mediaListeners.push(fn);
    }

    onUrlChange(fn) {
      this.urlListeners.push(fn);
    }

    getMedia(mediaId) {
      return this.media.get(mediaId) || null;
    }

    getActiveMedia() {
      return this.activeMediaId == null ? null : this.getMedia(this.activeMediaId);
    }

    send(type, payload = {}) {
      this.win.postMessage({ source: this.site.BRIDGE.TO_PAGE, type, ...payload }, this.win.location.origin);
    }

    /** Asks the page to navigate client-side. Resolves { ok, error? }; never rejects. */
    navigate(path) {
      const requestId = ++this.requestSeq;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          this.pendingNavigations.delete(requestId);
          resolve({ ok: false, error: 'Navigation timed out.' });
        }, NAVIGATE_TIMEOUT_MS);
        this.pendingNavigations.set(requestId, (result) => {
          clearTimeout(timer);
          resolve(result);
        });
        this.send('navigate', { requestId, path });
      });
    }

    setPlaybackRate(mediaId, rate) {
      this.send('set-rate', { mediaId, rate });
    }

    onMessage(e) {
      const data = e.data;
      if (e.source !== this.win || !data || data.source !== this.site.BRIDGE.FROM_PAGE) return;
      switch (data.type) {
        case 'media':
          this.ingest(data);
          break;
        case 'hello':
          this.ingestSnapshot(data.media);
          this.emitUrl(data.url);
          break;
        case 'urlchange':
          this.emitUrl(data.url);
          break;
        case 'navigate-result': {
          const done = this.pendingNavigations.get(data.requestId);
          if (done) {
            this.pendingNavigations.delete(data.requestId);
            done({ ok: data.ok === true, error: data.error });
          }
          break;
        }
      }
    }

    normalize(raw) {
      if (!raw || typeof raw !== 'object' || !Number.isInteger(raw.mediaId)) return null;
      const media = {
        mediaId: raw.mediaId,
        session: Number.isInteger(raw.session) ? raw.session : 0,
        src: typeof raw.src === 'string' ? raw.src : '',
        currentTime: Number(raw.currentTime) || 0,
        duration: Number(raw.duration),
        paused: raw.paused !== false,
        ended: raw.ended === true,
        playbackRate: Number(raw.playbackRate) || 1,
        isPrimary: raw.isPrimary === true,
      };
      if (!this.site.isChapterAudio(media)) return null;
      media.surah = this.site.surahFromAudioSrc(media.src);
      return media;
    }

    ingest(data) {
      const media = this.normalize(data.media);
      if (!media) return;
      this.media.set(media.mediaId, media);
      if (data.event === 'play' || data.event === 'playing') this.activeMediaId = media.mediaId;
      const event = { event: data.event, media, errorName: data.errorName || null, errorCode: data.errorCode ?? null };
      for (const fn of this.mediaListeners) fn(event);
    }

    ingestSnapshot(list) {
      if (!Array.isArray(list)) return;
      for (const raw of list) {
        const media = this.normalize(raw);
        if (!media) continue;
        this.media.set(media.mediaId, media);
        if (!media.paused) {
          this.activeMediaId = media.mediaId;
          for (const fn of this.mediaListeners) fn({ event: 'playing', media, errorName: null, errorCode: null });
        }
      }
    }

    emitUrl(url) {
      if (typeof url !== 'string') return;
      for (const fn of this.urlListeners) fn(url);
    }
  }

  const api = { AudioDetector, CompletionTracker, END_TOLERANCE_SECONDS };
  QC.audio = api;
  if (isNode) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
