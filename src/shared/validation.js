/*
 * Settings validation/normalization and the playback rules evaluated when a surah finishes.
 * Rules are fixed, explicit types; nothing user-supplied is ever executed.
 */
(function (root) {
  'use strict';

  const QC = (root.QC = root.QC || {});
  const { DEFAULT_SETTINGS, LIMITS, SETTINGS_VERSION } =
    typeof module !== 'undefined' && module.exports ? require('./defaults.js') : QC.defaults;

  const FIRST_SURAH = 1;
  const LAST_SURAH = 114;

  function isValidSurahNumber(value) {
    return Number.isInteger(value) && value >= FIRST_SURAH && value <= LAST_SURAH;
  }

  /** Returns the surah after `number`, or null after An-Nas. Throws on invalid input. */
  function nextSurah(number) {
    if (!isValidSurahNumber(number)) throw new RangeError(`Invalid surah number: ${number}`);
    return number < LAST_SURAH ? number + 1 : null;
  }

  function toIntegerOrNaN(value) {
    if (typeof value === 'number') return Number.isInteger(value) ? value : NaN;
    if (typeof value === 'string' && /^\s*-?\d+\s*$/.test(value)) return Number.parseInt(value, 10);
    return NaN;
  }

  /**
   * Strict validation for user input (options page / popup).
   * Returns { valid, errors: { field: message }, value } where `value` is the cleaned settings object.
   */
  function validateSettings(input) {
    const errors = {};
    const src = input && typeof input === 'object' ? input : {};
    const value = { ...DEFAULT_SETTINGS };

    for (const key of ['autoPlayEnabled', 'preservePlaybackSpeed', 'showPageNotifications']) {
      if (key in src) {
        if (typeof src[key] === 'boolean') value[key] = src[key];
        else errors[key] = 'Must be on or off.';
      }
    }

    if ('endSurah' in src) {
      if (src.endSurah === null || src.endSurah === '') {
        value.endSurah = null;
      } else {
        const n = toIntegerOrNaN(src.endSurah);
        if (isValidSurahNumber(n)) value.endSurah = n;
        else errors.endSurah = `Choose a surah from ${FIRST_SURAH} to ${LAST_SURAH}, or none.`;
      }
    }

    for (const key of ['retryCount', 'retryDelaySeconds']) {
      if (key in src) {
        const n = toIntegerOrNaN(src[key]);
        const { min, max } = LIMITS[key];
        if (Number.isInteger(n) && n >= min && n <= max) value[key] = n;
        else errors[key] = `Enter a whole number from ${min} to ${max}.`;
      }
    }

    value.settingsVersion = SETTINGS_VERSION;
    return { valid: Object.keys(errors).length === 0, errors, value };
  }

  /**
   * Lenient normalization for stored settings: missing or invalid fields fall back to defaults,
   * so a corrupted or older settings object never breaks playback.
   */
  function normalizeSettings(stored) {
    const migrated = migrateSettings(stored);
    const { value, errors } = validateSettings(migrated);
    for (const key of Object.keys(errors)) value[key] = DEFAULT_SETTINGS[key];
    return value;
  }

  /** Upgrades older settings shapes. Version 1 is the first release, so there is nothing to migrate yet. */
  function migrateSettings(stored) {
    if (!stored || typeof stored !== 'object') return {};
    return { ...stored };
  }

  /**
   * Decides what to do after `finishedSurah` completes.
   * Returns { action: 'next', target } or { action: 'stop', reason: 'end-surah' | 'end-of-quran' }.
   * The ending surah means "do not go past this surah", so starting after it also stops.
   */
  function evaluateCompletion(finishedSurah, settings) {
    if (!isValidSurahNumber(finishedSurah)) throw new RangeError(`Invalid surah number: ${finishedSurah}`);
    const endSurah = settings && isValidSurahNumber(settings.endSurah) ? settings.endSurah : null;
    if (endSurah !== null && finishedSurah >= endSurah) return { action: 'stop', reason: 'end-surah' };
    const target = nextSurah(finishedSurah);
    if (target === null) return { action: 'stop', reason: 'end-of-quran' };
    return { action: 'next', target };
  }

  const api = {
    FIRST_SURAH,
    LAST_SURAH,
    isValidSurahNumber,
    nextSurah,
    validateSettings,
    normalizeSettings,
    evaluateCompletion,
  };
  QC.validation = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
