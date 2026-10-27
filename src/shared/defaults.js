/*
 * Default settings and limits. Settings live in chrome.storage.local under STORAGE_KEY.
 */
(function (root) {
  'use strict';

  const SETTINGS_VERSION = 1;
  const STORAGE_KEY = 'settings';

  const DEFAULT_SETTINGS = Object.freeze({
    settingsVersion: SETTINGS_VERSION,
    // Continue playback: auto-play the next surah when the current one finishes.
    autoPlayEnabled: true,
    // Ending surah: null (play to An-Nas) or 1-114. Playback stops after this surah.
    endSurah: null,
    // Retry on failure: extra attempts after the first one fails.
    retryCount: 2,
    // Delay between attempts, in seconds.
    retryDelaySeconds: 3,
    // Re-apply the previous surah's playback speed if the new surah starts at a different one.
    preservePlaybackSpeed: true,
    // Show small status messages on the Quran.com page (ending surah reached, errors).
    showPageNotifications: true,
    // Say which surah comes next (Chrome text-to-speech) before it starts playing.
    announceNextSurah: true,
    // Language of the announcement: one of ANNOUNCE_LANGUAGES.
    announceLanguage: 'en',
  });

  const ANNOUNCE_LANGUAGES = Object.freeze(['en', 'ar']);

  const LIMITS = Object.freeze({
    retryCount: Object.freeze({ min: 0, max: 10 }),
    retryDelaySeconds: Object.freeze({ min: 1, max: 60 }),
  });

  const api = { SETTINGS_VERSION, STORAGE_KEY, DEFAULT_SETTINGS, LIMITS, ANNOUNCE_LANGUAGES };
  const QC = (root.QC = root.QC || {});
  QC.defaults = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
