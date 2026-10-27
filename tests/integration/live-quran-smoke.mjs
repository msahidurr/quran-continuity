#!/usr/bin/env node
/*
 * Live smoke test against the real quran.com player (needs network and Google Chrome).
 *
 * Branded Chrome no longer accepts --load-extension, so this harness injects the extension's
 * scripts the way Chrome would: the page bridge into the MAIN world and the content scripts into
 * an isolated world (both at document start), with a minimal chrome.* stub. The script lists are
 * read from manifest.json so the test always matches what ships.
 *
 * Scenario (short surahs, seeking near the end to keep it quick):
 *   1. Open /112 and press Play with a real (CDP) mouse click.
 *   2. Pause for a few seconds: the extension must not advance (AC-03), then resume.
 *   3. Seek to the end of 112: Al-Falaq (113) must start playing on its own (AC-01, AC-14).
 *   4. With the ending surah set to 113, seek to its end: playback must stop, no move to 114 (AC-07).
 *
 * Usage: node tests/integration/live-quran-smoke.mjs [--show]   (--show runs Chrome with a window)
 */
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHROME = process.env.CHROME_BIN || 'google-chrome';
const PORT = 9300 + Math.floor(Math.random() * 500);
const SETTINGS = { autoPlayEnabled: true, endSurah: 113, retryCount: 2, retryDelaySeconds: 3 };

const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
const mainScripts = manifest.content_scripts.find((c) => c.world === 'MAIN').js;
const isolatedScripts = manifest.content_scripts.find((c) => c.world !== 'MAIN').js;
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const chromeStub = `
  globalThis.chrome = {
    storage: {
      local: { get: async () => ({ settings: ${JSON.stringify(SETTINGS)} }), set: async () => {} },
      onChanged: { addListener() {} },
    },
    runtime: {
      sendMessage: (msg) => { console.debug('QC_STATUS ' + JSON.stringify(msg.status)); return Promise.resolve(); },
      onMessage: { addListener(fn) { globalThis.__qcOnMessage = fn; } },
    },
  };`;
// document_idle equivalent: run the content scripts once the DOM is parsed.
const isolatedSource = `${chromeStub}
  const __qcRun = () => { ${isolatedScripts.map(read).join('\n;\n')} };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', __qcRun, { once: true }); else __qcRun();`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

const profile = mkdtempSync(join(tmpdir(), 'qc-smoke-'));
const chrome = spawn(
  CHROME,
  [
    ...(process.argv.includes('--show') ? [] : ['--headless=new']),
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--mute-audio',
    '--window-size=1280,900',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

let ws;
let seq = 0;
const pending = new Map();
const statuses = [];

function send(method, params = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
  return r.result.value;
}

async function waitFor(label, fn, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await sleep(250);
  }
}

const AUDIO = `(() => { const a = document.getElementById('audio-player');
  return a && { src: a.currentSrc, t: a.currentTime, d: a.duration, paused: a.paused, ended: a.ended, path: location.pathname }; })()`;
const lastStatus = () => statuses.at(-1) || {};

async function clickListenButton() {
  const rect = await waitFor('listen button', () =>
    evaluate(`(() => { const b = document.querySelector('[data-testid="listen-button"]'); if (!b) return null;
      b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`),
  );
  // The server-rendered button ignores clicks until React hydrates, so retry until audio loads.
  for (let i = 0; i < 6; i++) {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
    }
    await sleep(3000);
    const a = await evaluate(AUDIO);
    if (a && a.src) return;
  }
}

// Pause/resume through the site's own player toggle; calling audio.pause()/play() directly is
// overridden by Quran.com's player state machine.
async function togglePlayerPause() {
  const rect = await waitFor('player pause toggle', () =>
    evaluate(`(() => { const b = document.querySelector('[data-testid^="audio-"][data-testid$="-toggle"]'); if (!b) return null;
      const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`),
  );
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
  }
}

async function seekNearEnd(seconds = 3) {
  await evaluate(`(() => { const a = document.getElementById('audio-player'); a.currentTime = a.duration - ${seconds}; })()`);
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  const version = await waitFor('Chrome DevTools endpoint', async () => {
    try {
      return await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
    } catch {
      return null;
    }
  });
  log('Chrome', version.Browser);
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    } else if (msg.method === 'Runtime.consoleAPICalled') {
      const text = msg.params.args[0]?.value;
      if (typeof text === 'string' && text.startsWith('QC_STATUS ')) {
        const s = JSON.parse(text.slice(10));
        const prev = lastStatus();
        statuses.push(s);
        if (s.state !== prev.state || s.currentSurah !== prev.currentSurah || s.notice !== prev.notice || s.error !== prev.error) {
          log(`  status: ${s.state} surah=${s.currentSurah}${s.transition ? ` → ${s.transition.target} (attempt ${s.transition.attempt})` : ''}${s.notice ? ` | ${s.notice}` : ''}${s.error ? ` | ERROR ${s.error}` : ''}`);
        }
      }
    }
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: mainScripts.map(read).join('\n;\n') });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: isolatedSource, worldName: 'quran-continuity' });
  await send('Page.navigate', { url: 'https://quran.com/112' });

  // 1. Start playback with a real click.
  await clickListenButton();
  const started = await waitFor('surah 112 playing', async () => {
    const a = await evaluate(AUDIO);
    return a && !a.paused && /\/112\.mp3/.test(a.src) && a.d > 0 ? a : null;
  });
  log('Playing', started.src, `duration ${started.d.toFixed(1)}s`);
  await waitFor('extension sees playing', () => lastStatus().state === 'playing' && lastStatus().currentSurah === 112, 5000);
  check('detects the playing surah', true);

  // 2. Manual pause must not advance.
  await togglePlayerPause();
  await sleep(4000);
  const afterPause = await evaluate(AUDIO);
  check('manual pause does not advance (AC-03)', lastStatus().state === 'paused' && /\/112\.mp3/.test(afterPause.src) && afterPause.path.includes('ikhlas'), `state=${lastStatus().state} path=${afterPause.path}`);
  await togglePlayerPause();
  await waitFor('resumed', () => lastStatus().state === 'playing', 5000);
  check('resume continues the same surah (AC-04)', true);

  // 3. Let 112 finish: 113 must start by itself.
  await seekNearEnd();
  const next = await waitFor(
    'surah 113 playing',
    async () => {
      const a = await evaluate(AUDIO);
      return a && !a.paused && /\/113\.mp3/.test(a.src) && lastStatus().state === 'playing' ? a : null;
    },
    45000,
  );
  check('auto-plays the next surah (AC-01)', true, `${next.path} ${next.src}`);
  check('URL follows the transition (AC-14)', next.path.includes('falaq'), next.path);
  const transitionsTo113 = statuses.filter((s) => s.transition && s.transition.target === 113 && s.transition.attempt === 1).length > 0;
  check('single transition attempt', transitionsTo113 && !statuses.some((s) => s.transition && s.transition.attempt > 1));

  // 4. Ending surah = 113: must stop and stay on 113.
  await waitFor('113 duration', async () => (await evaluate(AUDIO)).d > 0, 10000);
  await seekNearEnd();
  await waitFor('113 finished', async () => (await evaluate(AUDIO)).ended, 20000);
  await sleep(6000);
  const end = await evaluate(AUDIO);
  check('stops after the ending surah (AC-07)', /\/113\.mp3/.test(end.src) && end.path.includes('falaq') && /ending surah/.test(lastStatus().notice || ''), `${end.path} | ${lastStatus().notice}`);
  const toast = await evaluate(`!!document.querySelector('[data-quran-continuity]')`);
  check('shows an on-page notice', toast);
}

let exitCode = 0;
try {
  await main();
} catch (err) {
  log('ERROR', err.message);
  try {
    log('page state:', JSON.stringify(await evaluate(`(() => {
      const a = document.getElementById('audio-player');
      const b = document.querySelector('[data-testid="listen-button"]');
      const r = b && b.getBoundingClientRect();
      const hit = r && document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return { path: location.pathname, audio: a && { src: a.currentSrc, paused: a.paused, t: a.currentTime, err: a.error && a.error.code, ready: a.readyState },
        button: b && b.getAttribute('aria-label'), hit: hit && (hit.outerHTML || '').slice(0, 160) };
    })()`)));
  } catch {}
  exitCode = 1;
} finally {
  try {
    ws?.close();
  } catch {}
  chrome.kill();
  await sleep(500);
  rmSync(profile, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok).length;
log(`${results.length - failed}/${results.length} checks passed`);
process.exit(exitCode || (failed ? 1 : 0));
