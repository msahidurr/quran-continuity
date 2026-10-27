/*
 * Popup: simple controls. Settings are written straight to chrome.storage.local; tab commands
 * (Next, Stop/Resume) and status go to the content script in the active tab.
 */
(function () {
  'use strict';

  const { MSG, STATE } = QC.messages;
  const { STORAGE_KEY } = QC.defaults;
  const { normalizeSettings, validateSettings } = QC.validation;
  const { SURAHS, getSurah } = QC.surahs;

  const el = {
    status: document.getElementById('status'),
    dot: document.getElementById('status-dot'),
    text: document.getElementById('status-text'),
    detail: document.getElementById('status-detail'),
    autoplay: document.getElementById('autoplay'),
    endSurah: document.getElementById('end-surah'),
    next: document.getElementById('next'),
    stop: document.getElementById('stop'),
    message: document.getElementById('message'),
    options: document.getElementById('open-options'),
  };

  let settings = normalizeSettings({});
  let tabId = null;
  let status = null;

  function surahLabel(n) {
    const s = getSurah(n);
    return s ? `${n}. ${s.name}` : String(n);
  }

  function fillSurahSelect() {
    el.endSurah.append(new Option('No limit (An-Nas)', ''));
    for (const s of SURAHS) el.endSurah.append(new Option(`${s.number}. ${s.name}`, String(s.number)));
  }

  function showMessage(text) {
    el.message.textContent = text || '';
    el.message.hidden = !text;
  }

  function renderSettings() {
    el.autoplay.checked = settings.autoPlayEnabled;
    el.endSurah.value = settings.endSurah === null ? '' : String(settings.endSurah);
  }

  function renderStatus() {
    el.status.classList.remove('error');
    el.dot.className = 'dot';
    el.next.disabled = !status;
    el.stop.disabled = !status;

    if (!status) {
      el.text.textContent = 'Not on Quran.com';
      el.detail.textContent = 'Open a surah on quran.com in this tab to use auto-play.';
      el.detail.hidden = false;
      el.stop.textContent = 'Stop Auto-Play';
      return;
    }

    const current = status.currentSurah ? surahLabel(status.currentSurah) : null;
    let text;
    switch (status.state) {
      case STATE.PLAYING:
        text = current ? `Playing ${current}` : 'Playing';
        el.dot.classList.add('playing');
        break;
      case STATE.PAUSED:
        text = current ? `Paused · ${current}` : 'Paused';
        break;
      case STATE.TRANSITIONING: {
        const t = status.transition;
        text = `Moving to ${surahLabel(t.target)}`;
        if (t.attempt > 1) text += ` (attempt ${t.attempt} of ${t.maxAttempts})`;
        el.dot.classList.add('transitioning');
        break;
      }
      case STATE.ERROR:
        text = 'Playback problem';
        el.dot.classList.add('error');
        el.status.classList.add('error');
        break;
      default:
        text = current ? `Not playing · ${current}` : 'Not playing';
    }
    el.text.textContent = text;

    let detail = status.error || status.notice || '';
    if (!detail && status.sessionStopped) detail = 'Auto-play is stopped for this tab.';
    else if (!detail && !status.autoPlayEnabled) detail = 'Auto-play is off.';
    el.detail.textContent = detail;
    el.detail.hidden = !detail;

    el.stop.textContent = status.sessionStopped ? 'Resume Auto-Play' : 'Stop Auto-Play';
    el.stop.setAttribute('aria-pressed', String(status.sessionStopped));
  }

  async function saveSettings(patch) {
    const { valid, value, errors } = validateSettings({ ...settings, ...patch });
    if (!valid) {
      showMessage(Object.values(errors)[0]);
      renderSettings();
      return;
    }
    settings = value;
    showMessage('');
    try {
      await chrome.storage.local.set({ [STORAGE_KEY]: settings });
    } catch (err) {
      showMessage(`Couldn't save: ${err.message}`);
    }
  }

  async function sendToTab(type) {
    if (tabId === null) return null;
    try {
      return await chrome.tabs.sendMessage(tabId, { type });
    } catch {
      return null; // no content script: not a quran.com tab, or the tab was opened before install
    }
  }

  async function refreshStatus() {
    const response = await sendToTab(MSG.GET_STATUS);
    status = response && response.ok ? response.status : null;
    renderStatus();
  }

  el.autoplay.addEventListener('change', () => saveSettings({ autoPlayEnabled: el.autoplay.checked }));
  el.endSurah.addEventListener('change', () => saveSettings({ endSurah: el.endSurah.value === '' ? null : el.endSurah.value }));

  el.next.addEventListener('click', async () => {
    showMessage('');
    const response = await sendToTab(MSG.NEXT_SURAH);
    if (!response) {
      showMessage('Reload the Quran.com tab, then try again.');
      return;
    }
    if (!response.ok) showMessage(response.error);
    status = response.status;
    renderStatus();
  });

  el.stop.addEventListener('click', async () => {
    showMessage('');
    const response = await sendToTab(status && status.sessionStopped ? MSG.RESUME_AUTOPLAY : MSG.STOP_AUTOPLAY);
    if (!response) {
      showMessage('Reload the Quran.com tab, then try again.');
      return;
    }
    status = response.status;
    renderStatus();
  });

  el.options.addEventListener('click', () => chrome.runtime.openOptionsPage());

  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (msg && msg.type === MSG.STATUS_CHANGED && sender.tab && sender.tab.id === tabId) {
      status = msg.status;
      renderStatus();
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[STORAGE_KEY]) {
      settings = normalizeSettings(changes[STORAGE_KEY].newValue);
      renderSettings();
    }
  });

  async function init() {
    fillSurahSelect();
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    settings = normalizeSettings(stored[STORAGE_KEY]);
    renderSettings();
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = tab ? tab.id : null;
    await refreshStatus();
  }

  init();
})();
