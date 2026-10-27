# Manual acceptance tests

Run these against the extension loaded unpacked in Chrome (see README). Use short surahs
(e.g. 112–114, or 93–105) and drag Quran.com's progress bar near the end to save time. Run at
least one full, un-seeked surah before release.

Columns: **Auto** = covered by an automated test as well (U = unit tests with a fake page,
L = live smoke test against quran.com, `npm run test:live`).

| ID | Steps | Expected | Auto | Result |
| --- | --- | --- | --- | --- |
| AC-01 | Auto-play on. Open `/112`, press Play, let it finish. | Al-Falaq (113) opens and starts playing on its own; popup shows "Playing 113. Al-Falaq". | U, L | |
| AC-02 | Turn auto-play off in the popup. Let a surah finish. | Nothing happens; popup says auto-play is off. | U | |
| AC-03 | While playing, press pause on Quran.com's player and wait 30 s. | No navigation; popup shows "Paused". | U, L | |
| AC-04 | Press play again. | Same surah continues from where it stopped. | U, L | |
| AC-05 | While a surah plays, click **Next Surah** in the popup. | Next surah opens and starts immediately. | U | |
| AC-06 | While 1 plays, open `/36` and press Play there. Let 36 finish. | 37 plays next (not 2). | U | |
| AC-07 | Set "Stop after" to 113. Play 112 → 113. | After 113 finishes playback stops, an on-page notice says the ending surah was reached, and the URL stays on 113. | U, L | |
| AC-08 | (Duplicate events) Play several consecutive surahs. | Each finish causes exactly one move; no surah is skipped. | U | |
| AC-09 | DevTools → Network → block `download.quranicaudio.com`, then let a surah finish. | Popup shows "attempt 2 of 3", then "attempt 3 of 3", with the configured delay between them. | U | |
| AC-10 | Keep the block from AC-09 in place. | After the last attempt: red error in the popup and on the page; no more attempts. | U | |
| AC-11 | Change settings, quit Chrome completely, reopen. | Settings in popup and options page are unchanged. | – | |
| AC-12 | Change the reciter in Quran.com settings mid-surah, then let the surah finish. | The next surah plays with the new reciter. The extension never changes the reciter. | U (cancel on manual play) | |
| AC-13 | Open any other website and click the extension icon. | Popup says "Not on Quran.com"; buttons disabled; nothing runs on the page. | – | |
| AC-14 | Navigate between surahs with Quran.com's own links (no reload). | Popup's current surah updates; the next auto-move follows the surah that is playing. | U, L | |
| AC-15 | Open `/112` in a **new tab**, don't click anything, then use popup → Next Surah. | If Chrome blocks audio: an error says autoplay was blocked and asks you to press Play. It never claims to be playing. | U | |

## Additional checks

- **Stop / Resume**: Popup → Stop Auto-Play while a surah plays. The current recitation keeps playing and
  the next surah doesn't start. Resume Auto-Play re-enables it. The stop applies only to that tab and
  survives a reload of that tab.
- **Playback speed**: set 1.5× in Quran.com's player, let a surah finish; the next one plays at 1.5×.
- **Locale**: repeat AC-01 on `https://quran.com/bn/112`; the next page stays in Bengali.
- **Word-by-word audio**: click individual words while a surah is paused; nothing advances.
- **Repeat**: enable Quran.com's repeat for a surah; when it repeats, the extension doesn't move on.
- **Slow connection**: DevTools → Network → "Slow 3G"; transitions still complete (allow up to 20 s per attempt).
- **Keyboard**: popup and options page are fully usable with Tab / Space / Enter and show a focus ring.
