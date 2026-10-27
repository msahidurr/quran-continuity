/*
 * Page-level actions the playback controller needs: reading the current surah from the URL,
 * navigating to a surah, checking that its page is ready, and pressing the site's Play button.
 * It never clicks anything other than the selectors defined in quran-site.js.
 */
(function (root) {
  'use strict';

  const QC = (root.QC = root.QC || {});

  // A chapter page with no rendered verses (e.g. Mushaf reading mode) is accepted once its URL
  // has been stable this long and the Play button exists.
  const STABLE_URL_MS = 1500;

  class QuranNavigator {
    constructor({ site, detector, win }) {
      this.site = site;
      this.detector = detector;
      this.win = win;
      this.urlChangedAt = Date.now();
      this.lastHref = win.location.href;
    }

    noteUrlChange(href) {
      if (href !== this.lastHref) {
        this.lastHref = href;
        this.urlChangedAt = Date.now();
      }
    }

    parseUrlSurah(href) {
      return this.site.parseLocation(href).surah;
    }

    getUrlSurah() {
      return this.parseUrlSurah(this.win.location.href);
    }

    softNavigate(n) {
      return this.detector.navigate(this.site.routerPathForSurah(n));
    }

    hardNavigate(n) {
      const { locale } = this.site.parseLocation(this.win.location.href);
      this.win.location.assign(this.site.hardPathForSurah(n, locale));
    }

    findListenButton() {
      const button = this.win.document.querySelector(this.site.SELECTORS.listenButton);
      return button && !button.disabled ? button : null;
    }

    isChapterPageReady(n) {
      if (this.getUrlSurah() !== n || !this.findListenButton()) return false;
      if (this.win.document.querySelector(this.site.SELECTORS.verseOfChapter(n))) return true;
      return Date.now() - this.urlChangedAt >= STABLE_URL_MS;
    }

    /** Clicks the site's own Play button. Returns false if it is not present. */
    clickListenButton() {
      const button = this.findListenButton();
      if (!button) return false;
      button.click();
      return true;
    }

    setPlaybackRate(mediaId, rate) {
      this.detector.setPlaybackRate(mediaId, rate);
    }
  }

  QC.QuranNavigator = QuranNavigator;
  if (typeof module !== 'undefined' && module.exports) module.exports = { QuranNavigator };
})(typeof globalThis !== 'undefined' ? globalThis : this);
