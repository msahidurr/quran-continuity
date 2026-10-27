/*
 * Advanced settings page. Values are validated with QC.validation before they are saved.
 */
(function () {
  'use strict';

  const { STORAGE_KEY, DEFAULT_SETTINGS } = QC.defaults;
  const { normalizeSettings, validateSettings } = QC.validation;
  const { SURAHS } = QC.surahs;

  const form = document.getElementById('form');
  const saved = document.getElementById('saved');
  const BOOLEAN_FIELDS = ['autoPlayEnabled', 'preservePlaybackSpeed', 'showPageNotifications', 'announceNextSurah'];
  const VALIDATED_FIELDS = ['endSurah', 'retryCount', 'retryDelaySeconds'];

  const endSurah = form.elements.endSurah;
  endSurah.append(new Option('None (continue to An-Nas)', ''));
  for (const s of SURAHS) endSurah.append(new Option(`${s.number}. ${s.name}`, String(s.number)));

  function fill(settings) {
    for (const key of BOOLEAN_FIELDS) form.elements[key].checked = settings[key];
    endSurah.value = settings.endSurah === null ? '' : String(settings.endSurah);
    form.elements.retryCount.value = String(settings.retryCount);
    form.elements.retryDelaySeconds.value = String(settings.retryDelaySeconds);
    form.elements.announceLanguage.value = settings.announceLanguage;
    showErrors({});
  }

  function read() {
    const value = {};
    for (const key of BOOLEAN_FIELDS) value[key] = form.elements[key].checked;
    value.endSurah = endSurah.value === '' ? null : endSurah.value;
    value.retryCount = form.elements.retryCount.value;
    value.retryDelaySeconds = form.elements.retryDelaySeconds.value;
    value.announceLanguage = form.elements.announceLanguage.value;
    return value;
  }

  const voiceResult = document.getElementById('voice-result');
  const LANGUAGE_NAMES = { en: 'English', ar: 'Arabic' };

  function getVoices() {
    return new Promise((resolve) => (chrome.tts ? chrome.tts.getVoices((v) => resolve(v || [])) : resolve(null)));
  }

  /** Says up front whether the chosen language has a voice on this computer. */
  async function describeVoice() {
    const voices = await getVoices();
    // chrome.tts is missing until Chrome re-reads the manifest (the "tts" permission was added in an update).
    if (!voices) return 'Voice is not enabled yet. Reload the extension at chrome://extensions, then try again.';
    const language = form.elements.announceLanguage.value;
    const speech = QC.announcement.chooseSpeech(voices, 2, language);
    if (speech.fallback) return `No ${LANGUAGE_NAMES[language]} voice is installed on this computer, so announcements are spoken in English. See "No Arabic voice" in the README to add one.`;
    return speech.voiceName ? `Voice: ${speech.voiceName}` : 'No matching voice found; Chrome will try its default voice.';
  }

  async function refreshVoiceInfo() {
    voiceResult.textContent = await describeVoice();
  }

  form.elements.announceLanguage.addEventListener('change', refreshVoiceInfo);

  document.getElementById('test-voice').addEventListener('click', async () => {
    const voices = await getVoices();
    if (!voices) {
      voiceResult.textContent = await describeVoice();
      return;
    }
    const speech = QC.announcement.chooseSpeech(voices, 2, form.elements.announceLanguage.value);
    const info = await describeVoice();
    voiceResult.textContent = `Speaking… ${info}`;
    chrome.tts.speak(speech.text, {
      lang: speech.lang,
      ...(speech.voiceName ? { voiceName: speech.voiceName } : {}),
      onEvent: (e) => {
        if (e.type === 'end') voiceResult.textContent = info;
        else if (e.type === 'error') voiceResult.textContent = `Chrome couldn't speak: ${e.errorMessage || 'no voice available'}.`;
      },
    });
  });

  function showErrors(errors) {
    for (const key of VALIDATED_FIELDS) {
      const message = errors[key];
      const node = document.getElementById(`${key}-error`);
      node.textContent = message || '';
      node.hidden = !message;
      form.elements[key].setAttribute('aria-invalid', String(Boolean(message)));
    }
  }

  async function save(settings) {
    try {
      await chrome.storage.local.set({ [STORAGE_KEY]: settings });
      saved.textContent = 'Saved.';
    } catch (err) {
      saved.textContent = `Couldn't save: ${err.message}`;
    }
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    saved.textContent = '';
    const { valid, errors, value } = validateSettings(read());
    showErrors(errors);
    if (!valid) {
      saved.textContent = 'Fix the highlighted fields to save.';
      form.elements[Object.keys(errors)[0]].focus();
      return;
    }
    await save(value);
  });

  document.getElementById('reset').addEventListener('click', async () => {
    fill(DEFAULT_SETTINGS);
    await save({ ...DEFAULT_SETTINGS });
  });

  form.addEventListener('input', () => {
    saved.textContent = '';
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[STORAGE_KEY]) fill(normalizeSettings(changes[STORAGE_KEY].newValue));
  });

  chrome.storage.local.get(STORAGE_KEY).then((stored) => {
    fill(normalizeSettings(stored[STORAGE_KEY]));
    refreshVoiceInfo();
  });
})();
