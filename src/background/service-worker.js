/*
 * Speaks the next-surah announcement. chrome.tts is not available to content scripts, so the
 * content script asks here and gets a reply once speech has finished (or failed).
 */
importScripts('../shared/messages.js', '../shared/surahs.js', '../shared/announcement.js');

const { MSG } = self.QC.messages;
const { chooseSpeech } = self.QC.announcement;
const FINAL_EVENTS = new Set(['end', 'interrupted', 'cancelled', 'error']);

function getVoices() {
  return new Promise((resolve) => chrome.tts.getVoices((voices) => resolve(voices || [])));
}

async function speak(surah, language) {
  const speech = chooseSpeech(await getVoices(), surah, language);
  if (!speech) return { ok: false, error: 'unknown surah' };
  return new Promise((resolve) => {
    let replied = false;
    const reply = (result) => {
      if (!replied) {
        replied = true;
        resolve({ ...result, text: speech.text, voiceName: speech.voiceName, fallback: speech.fallback });
      }
    };
    chrome.tts.speak(
      speech.text,
      {
        lang: speech.lang,
        ...(speech.voiceName ? { voiceName: speech.voiceName } : {}),
        enqueue: false,
        onEvent: (e) => {
          if (FINAL_EVENTS.has(e.type)) reply({ ok: e.type === 'end', event: e.type, error: e.errorMessage });
        },
      },
      () => {
        if (chrome.runtime.lastError) reply({ ok: false, error: chrome.runtime.lastError.message });
      },
    );
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || sender.id !== chrome.runtime.id) return;

  if (!chrome.tts) {
    // Permission not granted yet (extension not reloaded after an update): skip the announcement.
    if (msg.type === MSG.SPEAK) sendResponse({ ok: false, error: 'chrome.tts unavailable' });
    return;
  }

  if (msg.type === MSG.SPEAK && Number.isInteger(msg.surah)) {
    speak(msg.surah, msg.language).then(sendResponse);
    return true; // reply asynchronously
  }

  if (msg.type === MSG.STOP_SPEAKING) chrome.tts.stop();
});
