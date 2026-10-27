/*
 * Everything specific to Quran.com's markup, routes and audio URLs lives here, so a site change
 * should only require editing this file. Verified against quran.com on 2026-10-27:
 *   - chapter pages are Next.js (pages router) routes /[chapterId]; /2 redirects to /al-baqarah
 *   - locales other than English are path prefixes (/bn/al-baqarah)
 *   - the chapter audio element is <audio id="audio-player">
 *   - the chapter "Play Surah ..." button is [data-testid="listen-button"]
 *   - chapter audio files end in /<chapter>.mp3 (e.g. .../qdc/mishari_al_afasy/murattal/2.mp3);
 *     word-by-word clips live under /wbw/ and must be ignored
 */
(function (root) {
  'use strict';

  const QC = (root.QC = root.QC || {});
  const isNode = typeof module !== 'undefined' && module.exports;
  const { surahNumberFromSlug, getSurah } = isNode ? require('../shared/surahs.js') : QC.surahs;
  const { isValidSurahNumber } = isNode ? require('../shared/validation.js') : QC.validation;

  // Keep in sync with src/page/page-bridge.js.
  const BRIDGE = Object.freeze({ FROM_PAGE: 'quran-continuity/page', TO_PAGE: 'quran-continuity/content' });

  const LOCALES = Object.freeze(['en', 'ar', 'bn', 'fa', 'fr', 'id', 'it', 'nl', 'pt', 'ru', 'sq', 'th', 'tr', 'ur', 'zh', 'ms', 'es', 'sw', 'vi']);
  const DEFAULT_LOCALE = 'en';

  const SELECTORS = Object.freeze({
    listenButton: '[data-testid="listen-button"]',
    // Any rendered verse of chapter n confirms the page content belongs to that chapter.
    verseOfChapter: (n) => `[data-testid^="verse-${n}:"], [data-testid^="verse-arabic-${n}:"], [data-verse-key^="${n}:"]`,
  });

  const CHAPTER_AUDIO_RE = /\/(\d{1,3})\.mp3(?:[?#]|$)/i;
  const WORD_AUDIO_RE = /\/wbw\//i;
  const CHAPTER_SEGMENT_RE = /^(\d{1,3})(?::\d+(?:-\d+)?)?$/;

  /** Parses a Quran.com URL into { locale, surah }. `surah` is null for non-chapter pages. */
  function parseLocation(href) {
    let url;
    try {
      url = new URL(href);
    } catch {
      return { locale: DEFAULT_LOCALE, surah: null };
    }
    const segments = url.pathname.split('/').filter(Boolean).map((s) => decodeURIComponent(s).toLowerCase());
    let locale = DEFAULT_LOCALE;
    if (segments.length && LOCALES.includes(segments[0])) locale = segments.shift();
    const first = segments[0];
    if (!first) return { locale, surah: null };

    const numeric = CHAPTER_SEGMENT_RE.exec(first);
    if (numeric) {
      const n = Number.parseInt(numeric[1], 10);
      return { locale, surah: isValidSurahNumber(n) ? n : null };
    }
    return { locale, surah: surahNumberFromSlug(first) };
  }

  /** Surah number of a chapter audio file, or null for anything else (word clips, unknown URLs). */
  function surahFromAudioSrc(src) {
    if (!src || WORD_AUDIO_RE.test(src)) return null;
    const match = CHAPTER_AUDIO_RE.exec(src);
    if (!match) return null;
    const n = Number.parseInt(match[1], 10);
    return isValidSurahNumber(n) ? n : null;
  }

  /** Whether a media snapshot from the bridge is the chapter recitation (not a word clip or other sound). */
  function isChapterAudio(media) {
    if (!media || !media.src || WORD_AUDIO_RE.test(media.src)) return false;
    return media.isPrimary === true || surahFromAudioSrc(media.src) !== null;
  }

  /** Path for client-side navigation; the Next.js router keeps the current locale itself. */
  function routerPathForSurah(n) {
    const surah = getSurah(n);
    return surah ? `/${surah.slug}` : `/${n}`;
  }

  /** Path for a full page load; the server redirects /<n> to the canonical slug. */
  function hardPathForSurah(n, locale) {
    return locale && locale !== DEFAULT_LOCALE ? `/${locale}/${n}` : `/${n}`;
  }

  const api = {
    BRIDGE,
    LOCALES,
    DEFAULT_LOCALE,
    SELECTORS,
    parseLocation,
    surahFromAudioSrc,
    isChapterAudio,
    routerPathForSurah,
    hardPathForSurah,
  };
  QC.site = api;
  if (isNode) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
