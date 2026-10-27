/*
 * Text spoken before the next surah starts, and the choice of voice for it.
 */
(function (root) {
  'use strict';

  const QC = (root.QC = root.QC || {});
  const { getSurah } = typeof module !== 'undefined' && module.exports ? require('./surahs.js') : QC.surahs;

  /** Returns { text, lang } for chrome.tts, or null for an unknown surah. */
  function announcementFor(number, language) {
    const surah = getSurah(number);
    if (!surah) return null;
    if (language === 'ar') return { text: `السورة التالية: سورة ${surah.arabicName}`, lang: 'ar' };
    return { text: `Next surah: ${surah.name}, number ${surah.number}.`, lang: 'en-US' };
  }

  const baseLang = (lang) => String(lang || '').toLowerCase().split(/[-_]/)[0];

  /** Best installed voice for `lang`: exact match, then a local voice of the same language, then any. */
  function voiceFor(voices, lang) {
    const matching = (voices || []).filter((v) => v.voiceName && baseLang(v.lang) === baseLang(lang));
    return (
      matching.find((v) => String(v.lang).toLowerCase() === lang.toLowerCase()) ||
      matching.find((v) => !v.remote) ||
      matching[0] ||
      null
    );
  }

  /**
   * Picks what to say and with which voice. Without a voice for the chosen language (common for
   * Arabic) it falls back to English, because a voice of another language reads Arabic text as silence.
   * Returns { text, lang, voiceName, fallback } or null.
   */
  function chooseSpeech(voices, number, language) {
    const primary = announcementFor(number, language);
    if (!primary) return null;
    const primaryVoice = voiceFor(voices, primary.lang);
    if (primaryVoice) return { ...primary, voiceName: primaryVoice.voiceName, fallback: false };
    if (language !== 'en') {
      const english = announcementFor(number, 'en');
      const englishVoice = voiceFor(voices, english.lang);
      if (englishVoice) return { ...english, voiceName: englishVoice.voiceName, fallback: true };
    }
    return { ...primary, voiceName: null, fallback: false }; // let Chrome try its default voice
  }

  const api = { announcementFor, voiceFor, chooseSpeech };
  QC.announcement = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
