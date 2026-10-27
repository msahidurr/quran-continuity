/*
 * Playback state machine: idle / playing / paused / transitioning / error.
 *
 * A transition (auto after completion, or manual "Next Surah") navigates to the target surah,
 * waits for its page, presses the site's Play button and waits for the audio to actually play.
 * Failed attempts are retried within the configured limits. User actions always win: pausing
 * never advances, playing another surah or navigating elsewhere cancels a pending transition,
 * and "Stop" disables automatic continuation for the tab.
 */
(function (root) {
  'use strict';

  const QC = (root.QC = root.QC || {});
  const isNode = typeof module !== 'undefined' && module.exports;
  const { STATE } = isNode ? require('../shared/messages.js') : QC.messages;
  const { DEFAULT_SETTINGS } = isNode ? require('../shared/defaults.js') : QC.defaults;
  const { evaluateCompletion, nextSurah, isValidSurahNumber } = isNode ? require('../shared/validation.js') : QC.validation;
  const { getSurah } = isNode ? require('../shared/surahs.js') : QC.surahs;
  const { CompletionTracker } = isNode ? require('./audio-detector.js') : QC.audio;

  const DEFAULT_TIMING = Object.freeze({
    graceMs: 1000, // after 'ended', wait this long to make sure the site isn't repeating the surah
    pageTimeoutMs: 20000,
    playTimeoutMs: 20000,
    pollMs: 250,
    secondMs: 1000,
    pendingMaxAgeMs: 60000,
  });

  class TransitionError extends Error {
    constructor(message, { fatal = false } = {}) {
      super(message);
      this.fatal = fatal;
    }
  }

  class CancelledError extends Error {}

  function label(n) {
    const surah = getSurah(n);
    return surah ? `Surah ${n} (${surah.name})` : `Surah ${n}`;
  }

  class PlaybackController {
    constructor({ page, detector, store, notify = () => {}, onStatus = () => {}, timing = {} }) {
      this.page = page;
      this.detector = detector;
      this.store = store;
      this.notify = notify;
      this.onStatus = onStatus;
      this.timing = { ...DEFAULT_TIMING, ...timing };
      this.tracker = new CompletionTracker();

      this.settings = { ...DEFAULT_SETTINGS };
      this.state = STATE.IDLE;
      this.sessionStopped = false;
      this.urlSurah = page.getUrlSurah();
      this.audioSurah = null;
      this.lastRate = null;
      this.transition = null;
      this.waiters = new Set();
      this.lastError = null;
      this.notice = null;
      this.seq = 0;
    }

    // ---- status -------------------------------------------------------------------------------

    getStatus() {
      const t = this.transition;
      return {
        state: this.state,
        autoPlayEnabled: this.settings.autoPlayEnabled,
        endSurah: this.settings.endSurah,
        sessionStopped: this.sessionStopped,
        currentSurah: this.referenceSurah(),
        transition: t ? { target: t.target, origin: t.origin, attempt: t.attempt, maxAttempts: this.settings.retryCount + 1 } : null,
        error: this.lastError,
        notice: this.notice,
      };
    }

    emit() {
      this.onStatus(this.getStatus());
    }

    /** The surah "Next" is relative to: the loaded recitation if one is in progress, else the page. */
    referenceSurah() {
      const m = this.detector.getActiveMedia();
      if (m && m.surah !== null && !m.ended && (!m.paused || m.currentTime > 0)) return m.surah;
      return this.urlSurah ?? this.audioSurah;
    }

    deriveState() {
      const m = this.detector.getActiveMedia();
      if (!m) return STATE.IDLE;
      if (!m.paused) return STATE.PLAYING;
      if (!m.ended && m.currentTime > 0) return STATE.PAUSED;
      return STATE.IDLE;
    }

    // ---- inputs -------------------------------------------------------------------------------

    setSettings(settings) {
      const wasEnabled = this.settings.autoPlayEnabled;
      this.settings = settings;
      if (wasEnabled && !settings.autoPlayEnabled && this.transition && this.transition.origin === 'auto') {
        this.cancelTransition('Auto-play turned off.');
      } else {
        this.emit();
      }
    }

    /** Called once after settings are loaded: restores the tab's stop flag and any transition interrupted by a full page load. */
    resumeFromStore() {
      this.sessionStopped = this.store.load('sessionStopped') === true;
      const pending = this.store.load('pending');
      this.store.remove('pending');
      this.emit();
      if (!pending || !isValidSurahNumber(pending.target)) return;
      if (!(Date.now() - pending.savedAt <= this.timing.pendingMaxAgeMs)) return;
      if (pending.origin === 'auto' && (!this.settings.autoPlayEnabled || this.sessionStopped)) return;
      if (this.page.getUrlSurah() !== pending.target) return;
      this.startTransition(pending.target, pending.origin, pending.from, Math.max(0, (pending.attempt || 1) - 1));
    }

    handleUrlChange(href) {
      const surah = this.page.parseUrlSurah(href);
      this.urlSurah = surah;
      const t = this.transition;
      if (t) {
        if (surah === t.target) {
          t.arrived = true;
        } else if (t.arrived || surah !== t.startUrlSurah) {
          this.cancelTransition('You opened a different page, so the automatic move was cancelled.');
          return;
        }
      }
      this.emit();
    }

    handleMediaEvent(evt) {
      const { event, media } = evt;
      this.settleWaiters(evt);
      const t = this.transition;
      switch (event) {
        case 'playing':
          if (media.surah !== null) this.audioSurah = media.surah;
          if (t && media.surah !== null && media.surah !== t.target) {
            this.cancelTransition(`${label(media.surah)} started playing, so the automatic move was cancelled.`);
            return;
          }
          if (!t) {
            this.state = STATE.PLAYING;
            this.lastError = null;
            this.lastRate = media.playbackRate;
            this.emit();
          }
          break;
        case 'pause':
          // An error stays visible until audio actually plays again; the site pauses after failed loads.
          if (!t && this.state !== STATE.ERROR && !media.ended && media.mediaId === this.detector.activeMediaId) {
            this.state = STATE.PAUSED;
            this.emit();
          }
          break;
        case 'ratechange':
          if (!t) this.lastRate = media.playbackRate;
          break;
        case 'error':
          if (!t && media.mediaId === this.detector.activeMediaId) {
            this.state = STATE.ERROR;
            this.lastError = 'The recitation audio failed to load on Quran.com.';
            this.emit();
          }
          break;
        case 'ended':
          this.handleEnded(media);
          break;
      }
    }

    async handleEnded(media) {
      const verdict = this.tracker.check(media, this.detector.activeMediaId);
      if (!verdict.genuine) return;
      if (media.surah !== null) this.audioSurah = media.surah;
      if (this.transition) return;

      const finished = media.surah ?? this.urlSurah;
      this.state = STATE.IDLE;
      this.notice = null;
      if (!this.settings.autoPlayEnabled) {
        this.notice = 'Surah finished. Auto-play is off.';
        this.emit();
        return;
      }
      if (this.sessionStopped) {
        this.notice = 'Surah finished. Auto-play is stopped for this tab.';
        this.emit();
        return;
      }
      this.emit();

      await this.sleep(this.timing.graceMs);
      const latest = this.detector.getMedia(media.mediaId);
      const restarted = latest && (latest.session !== media.session || !latest.paused);
      if (this.transition || restarted || this.detector.activeMediaId !== media.mediaId) return;
      if (!this.settings.autoPlayEnabled || this.sessionStopped) return;

      if (finished === null) {
        this.setError("Couldn't tell which surah just finished, so auto-play stopped.");
        return;
      }
      const decision = evaluateCompletion(finished, this.settings);
      if (decision.action === 'stop') {
        this.notice =
          decision.reason === 'end-surah'
            ? `Finished ${label(finished)}, your ending surah. Auto-play stopped.`
            : `Finished ${label(finished)}, the last surah. Auto-play stopped.`;
        this.notify({ level: 'info', message: this.notice });
        this.emit();
        return;
      }
      this.startTransition(decision.target, 'auto', finished);
    }

    // ---- commands -----------------------------------------------------------------------------

    next() {
      const base = this.referenceSurah();
      if (base === null) return { ok: false, error: 'Open a surah on Quran.com first.' };
      const target = nextSurah(base);
      if (target === null) return { ok: false, error: 'An-Nas (114) is the last surah.' };
      this.startTransition(target, 'manual', base);
      return { ok: true, target };
    }

    stop() {
      this.sessionStopped = true;
      this.store.save('sessionStopped', true);
      this.clearTransition();
      if (this.state === STATE.TRANSITIONING || this.state === STATE.ERROR) this.state = this.deriveState();
      this.lastError = null;
      this.notice = 'Auto-play stopped for this tab. The current recitation is not affected.';
      this.emit();
    }

    resume() {
      this.sessionStopped = false;
      this.store.remove('sessionStopped');
      if (this.state === STATE.ERROR) this.state = this.deriveState();
      this.lastError = null;
      this.notice = 'Auto-play resumed for this tab.';
      this.emit();
    }

    // ---- transitions --------------------------------------------------------------------------

    startTransition(target, origin, from, attemptsUsed = 0) {
      this.clearTransition();
      const t = {
        id: ++this.seq,
        target,
        origin,
        from,
        startUrlSurah: this.urlSurah,
        arrived: this.urlSurah === target,
        attempt: attemptsUsed,
        timer: null,
      };
      this.transition = t;
      this.state = STATE.TRANSITIONING;
      this.lastError = null;
      this.notice = `Moving to ${label(target)}…`;
      this.emit();
      this.runAttempt(t);
      return t;
    }

    isActive(t) {
      return this.transition === t;
    }

    assertActive(t) {
      if (!this.isActive(t)) throw new CancelledError();
    }

    async runAttempt(t) {
      t.attempt += 1;
      this.emit();
      try {
        await this.ensureOnPage(t);
        await this.startAndVerify(t);
        this.assertActive(t);
        this.transition = null;
        this.store.remove('pending');
        this.state = STATE.PLAYING;
        this.lastError = null;
        this.notice = `Now playing ${label(t.target)}.`;
        this.emit();
      } catch (err) {
        if (!this.isActive(t)) return;
        if (!(err instanceof TransitionError)) err = new TransitionError(String((err && err.message) || err));
        if (err.fatal || t.attempt > this.settings.retryCount) {
          this.failTransition(t, err);
          return;
        }
        const delay = this.settings.retryDelaySeconds;
        this.notice = `Attempt ${t.attempt} failed: ${err.message} Retrying in ${delay}s…`;
        this.emit();
        t.timer = setTimeout(() => {
          if (this.isActive(t)) this.runAttempt(t);
        }, delay * this.timing.secondMs);
      }
    }

    async ensureOnPage(t) {
      if (this.page.getUrlSurah() !== t.target) {
        const result = await this.page.softNavigate(t.target);
        this.assertActive(t);
        if (!result.ok) {
          // Client-side navigation unavailable: fall back to a full page load and resume there.
          this.store.save('pending', { target: t.target, origin: t.origin, from: t.from, attempt: t.attempt, savedAt: Date.now() });
          this.page.hardNavigate(t.target);
        }
      }
      await this.waitUntil(() => this.page.isChapterPageReady(t.target), this.timing.pageTimeoutMs, t, 'The page did not finish loading.');
    }

    async startAndVerify(t) {
      const active = this.detector.getActiveMedia();
      if (active && active.surah === t.target && !active.paused) return;

      const waiter = this.createWaiter(t.target);
      if (!this.page.clickListenButton()) {
        waiter.cancel();
        throw new TransitionError("Couldn't find Quran.com's Play button.");
      }
      const media = await waiter.promise;
      this.assertActive(t);

      if (this.settings.preservePlaybackSpeed && this.lastRate && Math.abs(media.playbackRate - this.lastRate) > 0.01) {
        this.page.setPlaybackRate(media.mediaId, this.lastRate);
      }
    }

    createWaiter(target) {
      let waiter;
      const promise = new Promise((resolve, reject) => {
        const finish = (fn, value) => {
          clearTimeout(waiter.timer);
          this.waiters.delete(waiter);
          fn(value);
        };
        waiter = {
          target,
          resolve: (v) => finish(resolve, v),
          reject: (e) => finish(reject, e),
          cancel: () => {
            clearTimeout(waiter.timer);
            this.waiters.delete(waiter);
          },
          timer: setTimeout(
            () => waiter.reject(new TransitionError('Playback did not start.')),
            this.timing.playTimeoutMs,
          ),
        };
        this.waiters.add(waiter);
      });
      waiter.promise = promise;
      return waiter;
    }

    settleWaiters({ event, media, errorName }) {
      for (const w of [...this.waiters]) {
        if (event === 'playing' && (media.surah === w.target || media.surah === null)) {
          w.resolve(media);
        } else if (event === 'play-rejected' && errorName !== 'AbortError') {
          // AbortError only means a newer load replaced the request; the site does that routinely.
          const blocked = errorName === 'NotAllowedError';
          w.reject(
            new TransitionError(
              blocked
                ? `Chrome blocked autoplay for ${label(w.target)}. Press Play on the page; auto-play continues after that.`
                : `Quran.com could not play it (${errorName}).`,
              { fatal: blocked },
            ),
          );
        } else if (event === 'error' && media.mediaId === this.detector.activeMediaId) {
          w.reject(new TransitionError('The audio failed to load.'));
        }
      }
    }

    async waitUntil(predicate, timeoutMs, t, message) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        this.assertActive(t);
        if (predicate()) return;
        if (Date.now() >= deadline) throw new TransitionError(message);
        await this.sleep(this.timing.pollMs);
      }
    }

    sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    /** Drops the current transition without changing state; returns whether one existed. */
    clearTransition() {
      const t = this.transition;
      if (!t) return false;
      clearTimeout(t.timer);
      this.transition = null;
      this.store.remove('pending');
      for (const w of [...this.waiters]) w.reject(new CancelledError());
      return true;
    }

    cancelTransition(notice) {
      if (!this.clearTransition()) return false;
      this.state = this.deriveState();
      this.notice = notice;
      this.emit();
      return true;
    }

    failTransition(t, err) {
      this.clearTransition();
      const attempts = `${t.attempt} attempt${t.attempt === 1 ? '' : 's'}`;
      this.setError(err.fatal ? err.message : `Couldn't start ${label(t.target)} after ${attempts}. ${err.message}`);
    }

    setError(message) {
      this.state = STATE.ERROR;
      this.lastError = message;
      this.notice = null;
      this.notify({ level: 'error', message });
      this.emit();
    }
  }

  const api = { PlaybackController, TransitionError, DEFAULT_TIMING };
  QC.playback = api;
  if (isNode) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
