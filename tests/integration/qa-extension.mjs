#!/usr/bin/env node
/*
 * End-to-end QA of the real, unpacked extension against live quran.com.
 *
 * Chrome loads the extension folder itself (CDP Extensions.loadUnpacked over --remote-debugging-pipe),
 * so manifest parsing, content-script injection, chrome.storage and messaging are all real.
 * Playback is started with real mouse clicks, so Chrome's autoplay policy applies as for a user.
 *
 * The popup is opened as a page in its own window. Its single change: chrome.tabs.query returns the
 * Quran.com tab under test (a real popup would get the active tab).
 *
 * Usage: node tests/integration/qa-extension.mjs [--show] [--only=<substring>]
 * Screenshots go to $QA_OUT (default: <os tmp>/quran-continuity-qa).
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHROME = process.env.CHROME_BIN || 'google-chrome';
const OUT = process.env.QA_OUT || join(tmpdir(), 'quran-continuity-qa');
const SHOW = process.argv.includes('--show');
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7);
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s]`, ...a);

// ---- CDP over pipe ------------------------------------------------------------------------------

let chrome;
let seq = 0;
const pending = new Map();
const eventHandlers = new Set();
const pageErrors = [];
let extensionId;

function launch(profile) {
  chrome = spawn(
    CHROME,
    [
      ...(SHOW ? [] : ['--headless=new']),
      '--remote-debugging-pipe',
      '--enable-unsafe-extension-debugging',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--mute-audio',
      '--window-size=1280,900',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] },
  );
  let buf = '';
  chrome.stdio[4].on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\0')) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? p.reject(new Error(`${p.method}: ${msg.error.message}`)) : p.resolve(msg.result);
      } else if (msg.method) {
        for (const h of eventHandlers) h(msg);
      }
    }
  });
  return new Promise((r) => chrome.once('exit', r));
}

function send(method, params = {}, sessionId) {
  const id = ++seq;
  const msg = { id, method, params };
  if (sessionId) msg.sessionId = sessionId;
  chrome.stdio[3].write(JSON.stringify(msg) + '\0');
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, method });
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${method}: CDP timeout`));
    }, 30000);
  });
}

eventHandlers.add((msg) => {
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    pageErrors.push({ session: msg.sessionId, text: `${d.text} ${d.exception?.description || ''}`.slice(0, 300), url: d.url || '' });
  } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    const text = msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
    const url = msg.params.stackTrace?.callFrames?.[0]?.url || '';
    pageErrors.push({ session: msg.sessionId, text: text.slice(0, 300), url });
  }
});

async function waitFor(label, fn, timeoutMs = 30000, interval = 250) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err.message;
    }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}${last ? ` (last: ${JSON.stringify(last).slice(0, 200)})` : ''}`);
    await sleep(interval);
  }
}

class Tab {
  static async open(url, { newWindow = false, preload } = {}) {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank', newWindow });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const tab = new Tab(targetId, sessionId);
    await send('Page.enable', {}, sessionId);
    await send('Runtime.enable', {}, sessionId);
    if (preload) await send('Page.addScriptToEvaluateOnNewDocument', { source: preload }, sessionId);
    await tab.goto(url);
    return tab;
  }

  constructor(targetId, sessionId) {
    this.targetId = targetId;
    this.sessionId = sessionId;
  }

  send(method, params) {
    return send(method, params, this.sessionId);
  }

  async goto(url) {
    await this.send('Page.navigate', { url });
    await waitFor(`load ${url}`, () => this.eval(`location.href !== 'about:blank' && document.readyState === 'complete'`), 45000);
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }

  async mouseClick(selector) {
    const rect = await this.eval(`(() => { const b = document.querySelector(${JSON.stringify(selector)}); if (!b) return null;
      b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    if (!rect) throw new Error(`No element ${selector}`);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await this.send('Input.dispatchMouseEvent', { type, x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
    }
  }

  async screenshot(file, clip) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 2 } } : {}) });
    writeFileSync(join(OUT, file), Buffer.from(data, 'base64'));
    return join(OUT, file);
  }

  close() {
    return send('Target.closeTarget', { targetId: this.targetId });
  }
}

// ---- Quran.com helpers --------------------------------------------------------------------------

const AUDIO = `(() => { const a = document.getElementById('audio-player');
  return { path: location.pathname, src: a ? a.currentSrc : '', t: a ? a.currentTime : 0, d: a ? a.duration : NaN,
    paused: a ? a.paused : true, ended: a ? a.ended : false, rate: a ? a.playbackRate : 1 }; })()`;
const surahOfSrc = (src) => Number((/\/(\d{1,3})\.mp3/.exec(src || '') || [])[1]) || null;
const reciterOfSrc = (src) => (/\/qdc\/([^/]+)\//.exec(src || '') || [])[1] || null;

async function audio(tab) {
  return tab.eval(AUDIO);
}

async function waitPlaying(tab, n, timeoutMs = 40000) {
  return waitFor(`surah ${n} playing`, async () => {
    const a = await audio(tab);
    return !a.paused && surahOfSrc(a.src) === n && a.d > 0 ? a : null;
  }, timeoutMs);
}

/** Full page load of a surah, then a real click on Play (retried until the page has hydrated). */
async function startSurah(tab, path, n) {
  await tab.goto(`https://quran.com${path}`);
  await waitFor('listen button', () => tab.eval(`!!document.querySelector('[data-testid="listen-button"]')`));
  for (let i = 0; i < 8; i++) {
    await tab.mouseClick('[data-testid="listen-button"]');
    await sleep(2500);
    const a = await audio(tab);
    if (!a.paused && surahOfSrc(a.src) === n) break;
  }
  return waitPlaying(tab, n, 20000);
}

async function seekNearEnd(tab, seconds = 2.5) {
  await waitFor('duration', async () => (await audio(tab)).d > 0, 15000);
  await tab.eval(`(() => { const a = document.getElementById('audio-player'); a.currentTime = a.duration - ${seconds}; })()`);
}

async function togglePlayer(tab) {
  await waitFor('player toggle', () => tab.eval(`!!document.querySelector('[data-testid^="audio-"][data-testid$="-toggle"]')`), 10000);
  await tab.mouseClick('[data-testid^="audio-"][data-testid$="-toggle"]');
}

// ---- extension helpers (through a real extension page) -----------------------------------------

let control; // an extension page with chrome.* APIs

async function openControl() {
  control = await Tab.open(`chrome-extension://${extensionId}/src/options/options.html`, { newWindow: true });
}

async function getSettings() {
  return (await control.eval(`chrome.storage.local.get('settings')`)).settings;
}

async function setSettings(patch) {
  const current = (await getSettings()) || {};
  await control.eval(`chrome.storage.local.set({ settings: ${JSON.stringify({ ...current, ...patch })} })`);
}

async function status(tabId) {
  const r = await control.eval(`chrome.tabs.sendMessage(${tabId}, { type: 'qc:get-status' }).then((r) => r, (e) => ({ fail: String(e) }))`);
  if (!r || r.fail) throw new Error(`no status: ${r && r.fail}`);
  return r.status;
}

async function openPopup(tabId) {
  const preload = `if (location.protocol === 'chrome-extension:') {
    const q = async () => [{ id: ${tabId === null ? 'undefined' : tabId} }];
    try { chrome.tabs.query = q; } catch {}
    if (chrome.tabs.query !== q) Object.defineProperty(chrome.tabs, 'query', { value: q });
  }`;
  const popup = await Tab.open(`chrome-extension://${extensionId}/src/popup/popup.html`, { newWindow: true, preload });
  await popup.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 420, deviceScaleFactor: 1, mobile: false });
  await waitFor('popup status', () => popup.eval(`document.getElementById('status-text').textContent !== 'Checking this tab…'`), 10000);
  return popup;
}

async function popupState(popup) {
  return popup.eval(`({
    text: document.getElementById('status-text').textContent,
    detail: document.getElementById('status-detail').hidden ? '' : document.getElementById('status-detail').textContent,
    autoplay: document.getElementById('autoplay').checked,
    endSurah: document.getElementById('end-surah').value,
    stop: document.getElementById('stop').textContent,
    nextDisabled: document.getElementById('next').disabled,
    message: document.getElementById('message').hidden ? '' : document.getElementById('message').textContent,
  })`);
}

// ---- test runner --------------------------------------------------------------------------------

const results = [];
async function scenario(name, fn) {
  if (ONLY && !name.startsWith('Install') && !name.toLowerCase().includes(ONLY.toLowerCase())) return;
  log(`▶ ${name}`);
  const started = Date.now();
  try {
    const note = await fn();
    results.push({ name, ok: true, note });
    log(`  PASS ${name}${note ? ` — ${note}` : ''} (${((Date.now() - started) / 1000).toFixed(0)}s)`);
  } catch (err) {
    results.push({ name, ok: false, note: err.message });
    log(`  FAIL ${name} — ${err.message}`);
  }
}
function expect(cond, message) {
  if (!cond) throw new Error(message);
}

// ---- scenarios ----------------------------------------------------------------------------------

async function run() {
  const profile = mkdtempSync(join(tmpdir(), 'qc-qa-profile-'));
  let exited = launch(profile);
  ({ id: extensionId } = await send('Extensions.loadUnpacked', { path: ROOT }));
  log('Loaded extension', extensionId);
  await openControl();

  const quran = await Tab.open('https://quran.com/112');
  let tabId;

  await scenario('Install: content scripts run on quran.com and answer the popup', async () => {
    expect(await quran.eval('window.__quranContinuityBridge === true'), 'page bridge not injected');
    const ids = await control.eval(`chrome.tabs.query({}).then((ts) => ts.map((t) => t.id))`);
    const answering = [];
    for (const id of ids) {
      const r = await control.eval(`chrome.tabs.sendMessage(${id}, { type: 'qc:get-status' }).then((r) => r, () => null)`);
      if (r && r.ok) answering.push({ id, status: r.status });
    }
    expect(answering.length === 1, `expected exactly 1 tab with the content script, got ${answering.length}`);
    tabId = answering[0].id;
    const st = answering[0].status;
    expect(st.currentSurah === 112 && st.state === 'idle', `status ${JSON.stringify(st)}`);
    return `tab ${tabId}, status idle on 112`;
  });

  await scenario('AC-13: nothing runs on unrelated sites; popup says so', async () => {
    const other = await Tab.open('https://example.com/');
    expect((await other.eval('typeof window.__quranContinuityBridge')) === 'undefined', 'bridge injected on example.com');
    const ids = await control.eval(`chrome.tabs.query({}).then((ts) => ts.map((t) => t.id))`);
    let answering = 0;
    for (const id of ids) {
      if (await control.eval(`chrome.tabs.sendMessage(${id}, { type: 'qc:get-status' }).then(() => true, () => false)`)) answering++;
    }
    expect(answering === 1, `content script answered in ${answering} tabs`);
    const otherId = ids.find((id) => id !== tabId && id !== undefined);
    const popup = await openPopup(otherId ?? -1);
    const ps = await popupState(popup);
    await popup.screenshot('popup-not-quran.png', { x: 0, y: 0, width: 320, height: 300 });
    await popup.close();
    await other.close();
    expect(ps.text === 'Not on Quran.com' && ps.nextDisabled, `popup ${JSON.stringify(ps)}`);
    return 'popup: "Not on Quran.com", buttons disabled';
  });

  await scenario('Defaults: popup shows auto-play on and no ending surah', async () => {
    const popup = await openPopup(tabId);
    const ps = await popupState(popup);
    await popup.close();
    expect(ps.autoplay === true && ps.endSurah === '', JSON.stringify(ps));
    return `"${ps.text}"`;
  });

  let reciter;
  await scenario('AC-01/AC-08/AC-12/AC-14: 112 ends → 113 plays once, same reciter, URL follows', async () => {
    const a = await startSurah(quran, '/112', 112);
    reciter = reciterOfSrc(a.src);
    await waitFor('status playing 112', async () => (await status(tabId)).state === 'playing', 5000);
    await seekNearEnd(quran);
    // AC-08: extra 'ended' events on the real element right after it finishes.
    await waitFor('112 ended', async () => (await audio(quran)).ended, 15000, 50);
    await quran.eval(`(() => { const a = document.getElementById('audio-player'); a.dispatchEvent(new Event('ended')); a.dispatchEvent(new Event('ended')); })()`);
    const b = await waitPlaying(quran, 113);
    await sleep(6000);
    const c = await audio(quran);
    const st = await status(tabId);
    expect(surahOfSrc(c.src) === 113 && c.path.includes('falaq'), `drifted past 113: ${c.path} ${c.src}`);
    expect(st.state === 'playing' && st.currentSurah === 113, `status ${JSON.stringify(st)}`);
    expect(reciterOfSrc(b.src) === reciter, `reciter changed ${reciter} → ${reciterOfSrc(b.src)}`);
    return `${c.path}, reciter ${reciter}, duplicate ended events ignored`;
  });

  await scenario('AC-03/AC-04: manual pause never advances; resume continues', async () => {
    await togglePlayer(quran);
    await waitFor('paused status', async () => (await status(tabId)).state === 'paused', 5000);
    const popup = await openPopup(tabId);
    const ps = await popupState(popup);
    await popup.screenshot('popup-paused.png', { x: 0, y: 0, width: 320, height: 300 });
    await popup.close();
    await sleep(5000);
    const a = await audio(quran);
    expect(a.paused && surahOfSrc(a.src) === 113 && a.path.includes('falaq'), `advanced while paused ${JSON.stringify(a)}`);
    const before = a.t;
    await togglePlayer(quran);
    const b = await waitPlaying(quran, 113, 10000);
    expect(Math.abs(b.t - before) < 3, `resume jumped from ${before} to ${b.t}`);
    return `popup "${ps.text}"`;
  });

  await scenario('Premature ended event mid-surah is ignored', async () => {
    await quran.eval(`document.getElementById('audio-player').dispatchEvent(new Event('ended'))`);
    await sleep(4000);
    const a = await audio(quran);
    expect(surahOfSrc(a.src) === 113 && !a.paused, `moved or stopped: ${JSON.stringify(a)}`);
  });

  await scenario('Set a non-default speed before the next transition', async () => {
    // Quran.com's speed menu sets the element rate; set it the same way.
    await quran.eval(`document.getElementById('audio-player').playbackRate = 1.5`);
    await sleep(500);
    expect((await audio(quran)).rate === 1.5, 'rate not applied');
  });

  await scenario('AC-02: auto-play off (popup switch) → no move after the surah ends', async () => {
    const popup = await openPopup(tabId);
    await popup.eval(`document.getElementById('autoplay').click()`);
    await waitFor('saved off', async () => (await getSettings())?.autoPlayEnabled === false, 5000);
    await popup.close();
    await seekNearEnd(quran);
    await waitFor('113 ended', async () => (await audio(quran)).ended, 15000);
    await sleep(6000);
    const a = await audio(quran);
    const st = await status(tabId);
    expect(a.path.includes('falaq') && surahOfSrc(a.src) === 113, `moved: ${a.path}`);
    expect(st.notice === 'Surah finished. Auto-play is off.', `notice ${st.notice}`);
    const popup2 = await openPopup(tabId);
    await popup2.eval(`document.getElementById('autoplay').click()`);
    await waitFor('saved on', async () => (await getSettings())?.autoPlayEnabled === true, 5000);
    await popup2.close();
    return `stayed on ${a.path}`;
  });

  await scenario('AC-05: popup Next Surah → 114 starts immediately; speed restored', async () => {
    const popup = await openPopup(tabId);
    await popup.eval(`document.getElementById('next').click()`);
    const a = await waitPlaying(quran, 114);
    await sleep(1500);
    const ps = await popupState(popup);
    await popup.screenshot('popup-playing.png', { x: 0, y: 0, width: 320, height: 300 });
    await popup.close();
    const rate = (await audio(quran)).rate;
    expect(a.path.includes('nas'), `path ${a.path}`);
    expect(/114/.test(ps.text), `popup did not update live: ${ps.text}`);
    return `${a.path}, popup "${ps.text}", rate ${rate}${rate === 1.5 ? '' : ' (site reset speed; extension re-applies only when it differs from the last observed rate)'}`;
  });

  await scenario('End of Quran: An-Nas ends → stops with a notice', async () => {
    await seekNearEnd(quran);
    await waitFor('114 ended', async () => (await audio(quran)).ended, 15000);
    await sleep(4000);
    const st = await status(tabId);
    const a = await audio(quran);
    expect(a.path.includes('nas') && /last surah/.test(st.notice || ''), `${a.path} ${st.notice}`);
    return st.notice;
  });

  await scenario('AC-06/AC-14: user switches surah in-app → extension follows the new one', async () => {
    await startSurah(quran, '/105', 105);
    // Same as clicking a link on Quran.com: client-side navigation, then the user presses Play.
    await sendRouterPush(quran, '/al-kawthar');
    await waitFor('url 108', async () => (await status(tabId)).currentSurah === 105 && (await quran.eval('location.pathname')) === '/al-kawthar', 15000);
    await sleep(1500);
    await quran.mouseClick('[data-testid="listen-button"]');
    await waitPlaying(quran, 108);
    await seekNearEnd(quran);
    const a = await waitPlaying(quran, 109);
    return `followed 108 → ${a.path} (not 106)`;
  });

  await scenario('AC-07: ending surah (popup select) stops after that surah', async () => {
    const popup = await openPopup(tabId);
    await popup.eval(`(() => { const s = document.getElementById('end-surah'); s.value = '109'; s.dispatchEvent(new Event('change')); })()`);
    await waitFor('saved endSurah', async () => (await getSettings())?.endSurah === 109, 5000);
    await popup.close();
    await seekNearEnd(quran);
    await waitFor('109 ended', async () => (await audio(quran)).ended, 15000);
    await sleep(5000);
    const a = await audio(quran);
    const st = await status(tabId);
    const toast = await quran.eval(`!!document.querySelector('[data-quran-continuity]')`);
    await quran.screenshot('page-ending-notice.png');
    await setSettings({ endSurah: null });
    expect(a.path.includes('kafirun') && surahOfSrc(a.src) === 109, `moved past 109: ${a.path}`);
    expect(/ending surah/.test(st.notice || '') && toast, `notice ${st.notice}, toast ${toast}`);
    return st.notice;
  });

  await scenario('Stop / Resume: stop is per tab, survives reload, resume re-enables', async () => {
    await startSurah(quran, '/100', 100);
    const popup = await openPopup(tabId);
    await popup.eval(`document.getElementById('stop').click()`);
    await waitFor('stopped', async () => (await status(tabId)).sessionStopped === true, 5000);
    const ps = await popupState(popup);
    await popup.close();
    expect(ps.stop === 'Resume Auto-Play', `button "${ps.stop}"`);
    const playing = await audio(quran);
    expect(!playing.paused, 'Stop paused the recitation');
    await seekNearEnd(quran);
    await waitFor('100 ended', async () => (await audio(quran)).ended, 15000);
    await sleep(5000);
    expect((await audio(quran)).path.includes('adiyat'), 'moved while stopped');
    await quran.goto('https://quran.com/100');
    await waitFor('status after reload', async () => (await status(tabId)).sessionStopped === true, 10000);
    const popup2 = await openPopup(tabId);
    await popup2.eval(`document.getElementById('stop').click()`);
    await waitFor('resumed', async () => (await status(tabId)).sessionStopped === false, 5000);
    await popup2.close();
    await startSurah(quran, '/100', 100);
    await seekNearEnd(quran);
    const a = await waitPlaying(quran, 101);
    return `stayed on 100 while stopped (also after reload); after resume → ${a.path}`;
  });

  await scenario('AC-09/AC-10: audio host blocked → bounded retries, then visible error', async () => {
    await startSurah(quran, '/101', 101); // the user has interacted with this tab, as in normal listening
    await setSettings({ retryCount: 1, retryDelaySeconds: 1 });
    await quran.send('Network.enable');
    await quran.send('Network.setBlockedURLs', { urls: ['*quranicaudio.com*'] });
    try {
    const popup = await openPopup(tabId);
    await popup.eval(`document.getElementById('next').click()`);
    const attempts = new Set();
    let lastLine;
    const st = await waitFor(
      'error state',
      async () => {
        const s = await status(tabId);
        if (s.transition) attempts.add(s.transition.attempt);
        const line = `${s.state} ${s.transition ? 'attempt ' + s.transition.attempt : ''} ${s.notice || ''} ${s.error || ''}`;
        if (line !== lastLine) log('   ', (lastLine = line), JSON.stringify(await audio(quran)));
        return s.state === 'error' ? s : null;
      },
      120000,
      200,
    );
    await sleep(500);
    const ps = await popupState(popup);
    await popup.screenshot('popup-error.png', { x: 0, y: 0, width: 320, height: 300 });
    await popup.close();
    const role = await quran.eval(`(() => { const h = document.querySelector('[data-quran-continuity]'); return !!h; })()`);
    await quran.screenshot('page-error-notice.png');
    await sleep(5000);
    const later = await status(tabId);
    expect(/after 2 attempts/.test(st.error), `error "${st.error}"`);
    expect(later.state === 'error' && !later.transition, 'kept retrying after giving up');
    expect(ps.text === 'Playback problem' && role, `popup ${JSON.stringify(ps)}`);
    return `attempts seen ${[...attempts].sort().join(',')}; "${st.error}"`;
    } finally {
      await quran.send('Network.setBlockedURLs', { urls: [] });
      await setSettings({ retryCount: 2, retryDelaySeconds: 3 });
    }
  });

  await scenario('AC-15: no user gesture in tab → blocked playback is reported, never claimed', async () => {
    const fresh = await Tab.open('https://quran.com/110', { newWindow: true });
    await sleep(2000);
    const ids = await control.eval(`chrome.tabs.query({}).then((ts) => ts.map((t) => t.id))`);
    let freshId = null;
    for (const id of ids) {
      if (id === tabId) continue;
      const r = await control.eval(`chrome.tabs.sendMessage(${id}, { type: 'qc:get-status' }).then((r) => r, () => null)`);
      if (r && r.ok) freshId = id;
    }
    expect(freshId !== null, 'fresh tab has no content script');
    const popup = await openPopup(freshId);
    await popup.eval(`document.getElementById('next').click()`);
    const st = await waitFor('outcome', async () => {
      const s = await status(freshId);
      return s.state === 'playing' || s.state === 'error' ? s : null;
    }, 90000);
    const a = await audio(fresh);
    const ps = await popupState(popup);
    await popup.close();
    await fresh.close();
    if (st.state === 'playing') {
      expect(!a.paused && surahOfSrc(a.src) === 111, `claims playing but audio is ${JSON.stringify(a)}`);
      return 'Chrome allowed playback in this profile; status matches real audio';
    }
    expect(a.paused, 'error reported while audio actually plays');
    return `"${st.error}" | popup: "${ps.detail}"`;
  });

  await scenario('Locale: /bn/ pages stay in Bengali after a transition', async () => {
    await startSurah(quran, '/bn/112', 112);
    await seekNearEnd(quran);
    const a = await waitPlaying(quran, 113);
    expect(a.path.startsWith('/bn/'), `locale lost: ${a.path}`);
    return a.path;
  });

  await scenario('Options page: validation, save, restore defaults', async () => {
    const opts = await Tab.open(`chrome-extension://${extensionId}/src/options/options.html`, { newWindow: true });
    await opts.send('Emulation.setDeviceMetricsOverride', { width: 760, height: 1200, deviceScaleFactor: 1, mobile: false });
    const before = await getSettings();
    await opts.eval(`(() => { const f = document.getElementById('form'); f.elements.retryCount.value = '99'; f.elements.retryDelaySeconds.value = '0';
      f.requestSubmit(); })()`);
    await sleep(500);
    const invalid = await opts.eval(`({
      rc: document.getElementById('retryCount-error').textContent, rd: document.getElementById('retryDelaySeconds-error').textContent,
      aria: document.getElementById('retryCount').getAttribute('aria-invalid'), focus: document.activeElement.id,
      saved: document.getElementById('saved').textContent })`);
    await opts.screenshot('options-invalid.png');
    expect(JSON.stringify(await getSettings()) === JSON.stringify(before), 'invalid values were saved');
    expect(invalid.rc && invalid.rd && invalid.aria === 'true' && invalid.focus === 'retryCount', JSON.stringify(invalid));
    await opts.eval(`(() => { const f = document.getElementById('form'); f.elements.retryCount.value = '4'; f.elements.retryDelaySeconds.value = '7';
      f.elements.endSurah.value = '18'; f.elements.preservePlaybackSpeed.checked = false; f.requestSubmit(); })()`);
    const saved = await waitFor('saved', async () => {
      const s = await getSettings();
      return s.retryCount === 4 ? s : null;
    }, 5000);
    expect(saved.retryDelaySeconds === 7 && saved.endSurah === 18 && saved.preservePlaybackSpeed === false, JSON.stringify(saved));
    await opts.screenshot('options-saved.png');
    await opts.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
    await opts.screenshot('options-dark.png');
    await opts.close();
    return `rejected 99/0 with inline errors; saved ${JSON.stringify({ retryCount: 4, retryDelaySeconds: 7, endSurah: 18 })}`;
  });

  await scenario('Keyboard: popup controls reachable with Tab and have labels', async () => {
    const popup = await openPopup(tabId);
    const order = [];
    for (let i = 0; i < 6; i++) {
      await popup.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
      await popup.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
      order.push(await popup.eval(`document.activeElement.id || document.activeElement.tagName`));
    }
    const unlabeled = await popup.eval(`[...document.querySelectorAll('input, select')].filter((el) => !document.querySelector('label[for="' + el.id + '"]')).map((el) => el.id)`);
    await popup.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
    await popup.screenshot('popup-dark.png', { x: 0, y: 0, width: 320, height: 300 });
    await popup.close();
    for (const id of ['autoplay', 'end-surah', 'next', 'stop', 'open-options']) expect(order.includes(id), `${id} not reachable: ${order}`);
    expect(unlabeled.length === 0, `unlabeled: ${unlabeled}`);
    return order.join(' → ');
  });

  await scenario('AC-11: settings survive a full browser restart', async () => {
    const before = await getSettings();
    await send('Browser.close').catch(() => {});
    await exited;
    exited = launch(profile);
    const { id } = await send('Extensions.loadUnpacked', { path: ROOT });
    expect(id === extensionId, `extension id changed ${extensionId} → ${id}`);
    await openControl();
    const after = await getSettings();
    expect(JSON.stringify(after) === JSON.stringify(before), `before ${JSON.stringify(before)} after ${JSON.stringify(after)}`);
    return JSON.stringify(after);
  });

  await scenario('No errors from extension code in any page', async () => {
    const ours = pageErrors.filter((e) => e.url.includes(extensionId) || /Quran Continuity|QC\./.test(e.text));
    for (const e of pageErrors) log('  console error:', e.url.slice(0, 80), e.text.slice(0, 160));
    expect(ours.length === 0, ours.map((e) => e.text).join(' | '));
    return `${pageErrors.length} page errors total, ${ours.length} from the extension`;
  });

  await send('Browser.close').catch(() => {});
  await Promise.race([exited, sleep(3000)]);
  chrome.kill();
  rmSync(profile, { recursive: true, force: true });
}

/** Client-side navigation exactly as a Quran.com link click does it. */
async function sendRouterPush(tab, path) {
  await tab.eval(`window.next.router.push(${JSON.stringify(path)})`);
}

try {
  await run();
} catch (err) {
  log('HARNESS ERROR', err.stack);
  chrome?.kill();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} scenarios passed. Screenshots: ${OUT}`);
for (const r of results) console.log(`${r.ok ? '✔' : '✖'} ${r.name}${r.note ? `\n    ${r.note}` : ''}`);
process.exit(failed.length ? 1 : 0);
