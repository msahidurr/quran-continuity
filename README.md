# Quran Continuity

A Chrome extension (Manifest V3) for listening on [Quran.com](https://quran.com) without stopping
between surahs. When the surah that is playing finishes, it opens the next surah and starts it with the
same reciter and speed.

- Follows whatever surah you start. There is no starting point to configure.
- Pausing never counts as finishing, and anything you do on the page takes priority over automatic moves.
- Announces the next surah by voice (English or Arabic) before it starts.
- Optional ending surah, plus a configurable retry count and delay.
- Needs only the `storage` and `tts` (text-to-speech) permissions and runs only on `https://quran.com/*`. No backend, no
  analytics, no network requests of its own.

## Install (unpacked)

1. Open `chrome://extensions` in Chrome (version 111 or newer).
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose this `quran-continuity` folder (the one containing `manifest.json`).
4. Pin the extension so its icon is visible.
5. **Reload any Quran.com tabs that were already open**; content scripts only attach to pages loaded after install.

## Use

1. Open a surah on Quran.com, choose a reciter as usual, and press **Play**.
2. Open the extension popup. It shows what is playing, plus these controls:
   - **Auto-play next surah**: on by default.
   - **Stop after**: optional ending surah.
   - **Next Surah**: move on now, without waiting for the surah to finish.
   - **Stop Auto-Play / Resume Auto-Play**: switch off automatic moves for this tab only. The current
     recitation keeps playing.
3. **Advanced settings** has the retry rules and the remaining options.

Errors, and the "ending surah reached" message, also appear briefly in the bottom-left corner of the
Quran.com page. You can turn this off in the settings.

## Settings and rules

| Setting | Default | Meaning |
| --- | --- | --- |
| Continue playback | on | When a surah finishes, play the next one. |
| Ending surah | none | Stop after this surah. If you start *after* it, auto-play stops when the current surah finishes. |
| Retries | 2 | Extra attempts if the next surah fails to load or start (0–10). |
| Retry delay | 3 s | Wait between attempts (1–60 s). |
| Keep playback speed | on | If the new surah starts at a different speed, restore the previous one. |
| Notices on Quran.com | on | Show the on-page notice. |
| Announce the next surah | on | Say "Next surah: Al-Baqarah, number 2." while the next page loads. The recitation starts after the announcement, never over it. |
| Announcement language | English | English or Arabic ("السورة التالية: سورة البقرة"). Use **Test voice** to check that a voice exists. |

These are always on and have no setting:
- A manual pause never triggers a move.
- When you play another surah, auto-play follows it. Opening a different page during a move cancels the move.
- The extension never changes the reciter.
- After the last retry fails, it stops and shows an error.

Settings are stored in `chrome.storage.local`, so they survive browser restarts. The "stopped for this tab"
flag lives in the tab's `sessionStorage` and is cleared when the tab is closed.

## How it works

```
page-bridge.js (MAIN world)          content scripts (isolated world)
  patches HTMLMediaElement.play  ─┐    audio-detector.js   active player, snapshots, CompletionTracker
  listens to audio events         ├─▶  playback-controller  state machine + transitions + retries
  watches history.pushState      ─┘    navigation.js        URL → surah, Play button, page readiness
  runs router.push / playbackRate ◀─   quran-site.js        all Quran.com selectors and URL rules
                                       quran-content.js     settings, popup messages, on-page notice
```

1. Quran.com plays each surah as a single chapter file through `<audio id="audio-player">`. A surah
   counts as finished only when that player fires `ended` and has reached its full duration. The same
   playback session can't count twice, and the event must come from the active player (word-by-word
   clips under `/wbw/` are ignored).
2. The extension then waits one second. If Quran.com restarts the audio (repeat mode, or you pressed
   play), nothing happens.
3. It applies the rules (ending surah, end of the Quran), starts the spoken announcement
   (Chrome's `chrome.tts`, via the background service worker), and navigates using Quran.com's own Next.js
   router. The tab never reloads, so Chrome still allows audio playback.
4. When the new chapter page is ready, it presses the site's **Play Surah** button
   (`[data-testid="listen-button"]`). The transition only counts as done once the audio element reports
   `playing` with that surah's file. It waits for the announcement first, for at most 8 seconds, so a
   missing or broken voice never blocks playback. Retries don't repeat the announcement.
5. If something fails, it retries within your limits and then shows an error. If client-side navigation
   isn't available, it falls back to a full page load and resumes the move from there.

## Development

Requires Node 20 or newer. There are no dependencies to install.

```bash
npm test             # unit tests: rules, URL/audio parsing, duplicate detection, full controller scenarios
npm run test:live    # live smoke test on quran.com in headless Chrome (needs network + google-chrome)
npm run test:qa      # full QA: loads the real unpacked extension, 21 end-to-end scenarios incl. popup,
                     # options page, retries with the audio host blocked, and a browser restart (~5 min)
npm run package      # zip for distribution / Chrome Web Store upload
```

The live test injects the extension's scripts in the same worlds and order as `manifest.json`, because
branded Chrome no longer supports `--load-extension`. It then plays 112, pauses and resumes, checks that
113 starts by itself, and checks that playback stops at the configured ending surah. Pass `--show` to
watch it run in a visible window. Manual acceptance tests are in
[tests/manual/acceptance-tests.md](tests/manual/acceptance-tests.md).

### When Quran.com changes

All site-specific details are in [src/content/quran-site.js](src/content/quran-site.js): selectors,
locale list, URL and audio-file patterns. The player element id is in
[src/page/page-bridge.js](src/page/page-bridge.js). If transitions stop working:

1. Run `npm run test:live`. The failure output includes the page and audio state.
2. On quran.com, check in DevTools that `[data-testid="listen-button"]` and `audio#audio-player` still
   exist, and that `window.next.router` is defined.
3. Update `quran-site.js`, then rerun both test suites.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Popup says "Not on Quran.com" on a Quran.com tab | Reload the tab (it was open before the extension was installed or updated). |
| "Chrome blocked autoplay" | Press Play once on the page. This happens after a full page load in a tab you haven't interacted with. Normal moves don't reload the page, so it rarely appears. |
| "Couldn't find Quran.com's Play button" | Quran.com's markup changed. See *When Quran.com changes*. |
| Retries then an error | Check your connection or whether the audio host is blocked (ad blockers, network filters). |
| No announcement | Click **Test voice** in settings; the line under it names the voice in use. |
| Arabic is announced in English | No Arabic voice is installed. See *No Arabic voice* below. |
| Doesn't advance | Check that auto-play is on, the tab isn't stopped (popup shows **Resume Auto-Play**), and no ending surah applies. |

### No Arabic voice

Chrome's built-in online voices don't include Arabic, so Arabic announcements need a voice installed in
the operating system. Until one exists, the extension speaks the English announcement instead of staying
silent, and the settings page says so.

- **Windows 10/11:** Settings → Time & language → Language & region → Add a language → Arabic, with
  *Text-to-speech* ticked. This adds voices such as Microsoft Hoda or Naayf.
- **macOS:** System Settings → Accessibility → Spoken Content → System voice → Manage Voices… → Arabic
  (e.g. Majed).
- **Linux:** Chrome uses system voices through speech-dispatcher. Install `speech-dispatcher` and
  `espeak-ng`; the Arabic voice is understandable but robotic.

Then **quit and restart Chrome** completely, open the extension settings, choose Arabic and click
**Test voice**. The line under the button should name the Arabic voice.

## Known limitations

- Only the full-surah chapter player is handled. Playing a verse range stops where Quran.com stops it, and
  no move happens.
- If the audio file name doesn't contain the chapter number, the surah is taken from the page URL instead.
- After a full page reload, the site's Play button ignores clicks until the page has hydrated. The first
  attempt may time out, and the next retry succeeds.
- Moves can only happen while the Quran.com tab is open. If Chrome discards a background tab to save
  memory, playback stops.
- Verified against quran.com on 2026-10-27. The site can change without notice.

## Privacy

There is no tracking or telemetry, and the extension sends nothing to any server. Announcements use Chrome's
voices; Chrome's own online "Google" voices may send the announcement text (the surah name) to Google. The only data stored
is your settings, in this browser.
