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
  const BOOLEAN_FIELDS = ['autoPlayEnabled', 'preservePlaybackSpeed', 'showPageNotifications'];
  const VALIDATED_FIELDS = ['endSurah', 'retryCount', 'retryDelaySeconds'];

  const endSurah = form.elements.endSurah;
  endSurah.append(new Option('None (continue to An-Nas)', ''));
  for (const s of SURAHS) endSurah.append(new Option(`${s.number}. ${s.name}`, String(s.number)));

  function fill(settings) {
    for (const key of BOOLEAN_FIELDS) form.elements[key].checked = settings[key];
    endSurah.value = settings.endSurah === null ? '' : String(settings.endSurah);
    form.elements.retryCount.value = String(settings.retryCount);
    form.elements.retryDelaySeconds.value = String(settings.retryDelaySeconds);
    showErrors({});
  }

  function read() {
    const value = {};
    for (const key of BOOLEAN_FIELDS) value[key] = form.elements[key].checked;
    value.endSurah = endSurah.value === '' ? null : endSurah.value;
    value.retryCount = form.elements.retryCount.value;
    value.retryDelaySeconds = form.elements.retryDelaySeconds.value;
    return value;
  }

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

  chrome.storage.local.get(STORAGE_KEY).then((stored) => fill(normalizeSettings(stored[STORAGE_KEY])));
})();
