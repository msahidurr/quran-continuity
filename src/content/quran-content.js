/*
 * Content-script entry point for quran.com: wires the bridge listener, navigator and playback
 * controller together, keeps settings in sync with chrome.storage.local, and answers the popup.
 */
(function () {
  'use strict';

  if (window.__quranContinuityContent) return;
  window.__quranContinuityContent = true;

  const { MSG } = QC.messages;
  const { STORAGE_KEY } = QC.defaults;
  const { normalizeSettings } = QC.validation;

  let settings = normalizeSettings({});

  // Per-tab runtime flags (stop for this tab, transition interrupted by a full page load).
  // sessionStorage survives reloads in the same tab and is cleared when the tab closes.
  const SESSION_PREFIX = 'quranContinuity.';
  const store = {
    load(key) {
      try {
        return JSON.parse(sessionStorage.getItem(SESSION_PREFIX + key));
      } catch {
        return null;
      }
    },
    save(key, value) {
      try {
        sessionStorage.setItem(SESSION_PREFIX + key, JSON.stringify(value));
      } catch {
        /* storage unavailable: the flag just won't survive a reload */
      }
    },
    remove(key) {
      try {
        sessionStorage.removeItem(SESSION_PREFIX + key);
      } catch {
        /* ignore */
      }
    },
  };

  const showToast = createToaster();

  function broadcast(status) {
    try {
      chrome.runtime.sendMessage({ type: MSG.STATUS_CHANGED, status }).catch(() => {
        /* popup closed: nobody is listening */
      });
    } catch {
      /* extension was reloaded; this content script is orphaned */
    }
  }

  // Speech runs in the service worker (chrome.tts); the promise settles when speaking ends or fails.
  const announcer = {
    announce(surah) {
      try {
        return chrome.runtime.sendMessage({ type: MSG.SPEAK, surah, language: settings.announceLanguage }).catch(() => {});
      } catch {
        return Promise.resolve();
      }
    },
    cancel() {
      try {
        chrome.runtime.sendMessage({ type: MSG.STOP_SPEAKING }).catch(() => {});
      } catch {
        /* orphaned content script */
      }
    },
  };

  const detector = new QC.audio.AudioDetector({ site: QC.site, win: window });
  const quranNavigator = new QC.QuranNavigator({ site: QC.site, detector, win: window });
  const controller = new QC.playback.PlaybackController({
    page: quranNavigator,
    detector,
    store,
    announcer,
    notify: (n) => {
      if (settings.showPageNotifications) showToast(n);
    },
    onStatus: broadcast,
  });

  detector.onMediaEvent((evt) => controller.handleMediaEvent(evt));
  detector.onUrlChange((href) => {
    quranNavigator.noteUrlChange(href);
    controller.handleUrlChange(href);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[STORAGE_KEY]) {
      settings = normalizeSettings(changes[STORAGE_KEY].newValue);
      controller.setSettings(settings);
    }
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return;
    switch (msg.type) {
      case MSG.GET_STATUS:
        sendResponse({ ok: true, status: controller.getStatus() });
        break;
      case MSG.NEXT_SURAH:
        sendResponse({ ...controller.next(), status: controller.getStatus() });
        break;
      case MSG.STOP_AUTOPLAY:
        controller.stop();
        sendResponse({ ok: true, status: controller.getStatus() });
        break;
      case MSG.RESUME_AUTOPLAY:
        controller.resume();
        sendResponse({ ok: true, status: controller.getStatus() });
        break;
    }
  });

  chrome.storage.local.get(STORAGE_KEY).then(
    (result) => start(result[STORAGE_KEY]),
    () => start(undefined),
  );

  function start(stored) {
    settings = normalizeSettings(stored);
    controller.setSettings(settings);
    detector.start();
    controller.resumeFromStore();
  }

  function createToaster() {
    let host = null;
    let box = null;
    let text = null;
    let hideTimer = null;

    function build() {
      host = document.createElement('div');
      host.setAttribute('data-quran-continuity', '');
      const shadow = host.attachShadow({ mode: 'closed' });
      shadow.innerHTML = `
        <style>
          .toast { position: fixed; left: 16px; bottom: 88px; z-index: 2147483647; max-width: min(360px, calc(100vw - 32px));
            display: none; align-items: flex-start; gap: 10px; padding: 12px 12px 12px 14px; border-radius: 10px;
            font: 14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; color: #f4f6f5; background: #1f2b28;
            box-shadow: 0 6px 24px rgba(0,0,0,.25); border-left: 4px solid #2f9e7a; }
          .toast.error { border-left-color: #e5534b; }
          .toast.show { display: flex; }
          .title { font-weight: 600; display: block; margin-bottom: 2px; }
          button { flex: none; border: 0; background: transparent; color: inherit; font-size: 18px; line-height: 1;
            cursor: pointer; padding: 2px 4px; border-radius: 4px; }
          button:focus-visible { outline: 2px solid #8fd3bd; }
        </style>
        <div class="toast" role="status" aria-live="polite">
          <div><span class="title">Quran Continuity</span><span class="msg"></span></div>
          <button type="button" aria-label="Dismiss">×</button>
        </div>`;
      box = shadow.querySelector('.toast');
      text = shadow.querySelector('.msg');
      shadow.querySelector('button').addEventListener('click', () => box.classList.remove('show'));
      document.documentElement.appendChild(host);
    }

    return function show({ level, message }) {
      if (!host || !host.isConnected) build();
      clearTimeout(hideTimer);
      text.textContent = message;
      box.classList.toggle('error', level === 'error');
      box.setAttribute('role', level === 'error' ? 'alert' : 'status');
      box.classList.add('show');
      // Errors stay until dismissed; information fades on its own.
      if (level !== 'error') hideTimer = setTimeout(() => box.classList.remove('show'), 8000);
    };
  }
})();
