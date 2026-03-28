# HostPilot — Automation Design

## Overview

`zoom-host-tools.user.js` is a Tampermonkey userscript that automates routine
Host / Co-Host tasks inside the **Zoom Web** client (`*.zoom.us/wc/*` and
`*.zoom.us/j/*`). It runs entirely in the browser — no backend, no external
services, no Zoom API credentials required.

The script is structured in **three phases**:

| Phase | Status | Description |
|-------|--------|-------------|
| 1 | **Fully implemented** | Detect raised hands → auto-grant Multi-Pin |
| 2 | Scaffold | After Multi-Pin grant, check camera state; optionally send a reminder |
| 3 | Scaffold | Monitor chat for spam/suspicious links |

---

## Architecture

```
zoom-host-tools.user.js
│
├── CONFIG              Global tuning knobs (intervals, retries, debug flag)
├── STATE               Runtime state (processed participants set, debug stats)
│
├── Logging layer       log(level, ...args) — respects CONFIG.DEBUG
│
├── Selector layer      SELECTORS map + resolveElement() + resolveAllElements()
│   └── Falls back through candidates array; logs selector mismatches as warnings
│
├── Participant identity  getParticipantId(row) — stable ID, name, or fingerprint
│
├── Phase 1 — Multi-Pin
│   ├── hasRaisedHand(row)
│   ├── alreadyProcessed(participantId)
│   ├── grantMultiPin(row, participantId)   ← async, handles menu open/click/retry
│   └── scanParticipants()                 ← called every SCAN_INTERVAL_MS
│
├── Phase 2 scaffold
│   └── checkCameraStatus(row, participantId)   ← called after every grant
│
├── Phase 3 scaffold
│   ├── checkMessageForSpam(text, sender)
│   └── startChatMonitor()                ← MutationObserver on chat container
│
├── Debug panel         createDebugPanel() / updateDebugPanel()
│
└── Entry point         waitForZoomReady() → startMainLoop()
```

---

## Secret Management

Script configuration (poll intervals, feature flags, spam-word lists) is
managed through [Doppler](https://doppler.com) and injected at **build time**
by `scripts/build-userscript.js`.

```
Doppler dashboard
    │
    │  doppler run -- npm run build
    ▼
scripts/build-userscript.js
    │  reads ZOOM_HOST_* env vars
    │  replaces @@DOPPLER_CONFIG_START…END block
    ▼
dist/zoom-host-tools.user.js   ← install this in Tampermonkey
dist/zoom-host-automation.user.js
```

See [`docs/doppler-setup.md`](doppler-setup.md) for full setup instructions.

---

## DOM Strategy

### Selector Mapping Layer

All CSS selectors are defined in two places that must be kept in sync:

1. **`/selectors/zoom-dom-selectors.json`** — canonical source of truth. Edit
   this file to update selectors after a Zoom UI change. The JSON contains
   multiple `candidates` per element, plus human-readable fallback notes.

2. **`SELECTORS` constant in `zoom-host-tools.user.js`** — an inline copy of
   the candidate arrays so the userscript works as a single self-contained file.

When Zoom changes its DOM, update the JSON first, then copy the relevant
`candidates` arrays into the `SELECTORS` constant in the script.

### Fallback Strategy (per element)

```
Priority 1 → data-testid attribute selectors   (most stable; Zoom uses these internally)
Priority 2 → explicit aria-label attribute      (accessibility labels; change less often)
Priority 3 → class name selectors               (liable to change with UI rebuilds)
Priority 4 → text content / aria-label keywords (last resort; language-dependent)
Priority 5 → structural DOM traversal           (absolute fallback)
```

`resolveElement()` iterates the `candidates` array and returns the first match.
A `[WARN]` log is emitted for any selector that throws (malformed selector) and
a `[DEBUG]` log for every successful match, making selector debugging easy.

---

## Assumptions

1. **Permissions** — The script assumes the logged-in Zoom user has Host or
   Co-Host permissions. It does not verify this; attempting actions without
   permissions will simply result in the menu item being absent or greyed out.

2. **Participant panel must be open** — The script can only scan participants
   when the Participants panel is visible. If it is closed, `getParticipantListContainer()`
   returns `null` and the scan is skipped silently.

3. **Hover reveals menu button** — Zoom hides the "…" (More) button until the
   participant row is hovered. The script dispatches synthetic `mouseover` /
   `mouseenter` / `mousemove` events to reveal it before looking for the button.
   This approach may break if Zoom adds a CSP or replaces hover with a click
   trigger.

4. **Single-session state** — `STATE.processedParticipants` is an in-memory
   `Set`. It is reset when the page reloads (e.g. the user rejoins the meeting).
   This is intentional: a participant who left and rejoin should be re-evaluated.

5. **Multi-Pin menu item text** — The "Allow to Multi-Pin" text is used as the
   final fallback. If Zoom localises this string, `MULTIPIN_TEXT_KEYWORDS` in
   the script must be updated.

6. **Camera detection is uncertain** — Zoom Web does not expose a reliable
   DOM-level camera on/off indicator in all versions. Phase 2's camera check is
   best-effort; it logs the result but does not act on uncertainty.

---

## Extension Points

### Adding a new Phase 2 action

After `grantMultiPin()` calls `checkCameraStatus()`, add your logic inside that
function:

```js
if (cameraOff) {
  // Phase 2: send one-time chat message
  await sendChatMessage(participantName, 'Please turn your camera on to use Multi-Pin.');
}
```

Implement `sendChatMessage(target, message)` using the chat input selectors in
`SELECTORS.chatInput` and `SELECTORS.chatSendButton`.

### Adding a Phase 3 moderation action

Inside `checkMessageForSpam()`, replace the `// TODO` comment with a call to
your moderation function:

```js
if (pattern.test(text)) {
  log('warn', `Spam detected from "${sender}": ${text}`);
  await moderateUser(sender);  // e.g. mute, remove, or warn
}
```

### Adding new spam patterns

Edit `CONFIG.SPAM_PATTERNS` at the top of the script. Each entry is a
`RegExp`:

```js
SPAM_PATTERNS: [
  /https?:\/\//i,
  /t\.me\//i,
  /yournewthing\.com/i,  // <-- add here
],
```

### Updating selectors after a Zoom UI change

1. Open the Zoom Web client in Chrome DevTools.
2. Inspect the affected element.
3. Update the `candidates` array for that element in
   `/selectors/zoom-dom-selectors.json`.
4. Copy the updated array into the matching entry in the `SELECTORS` constant
   in `zoom-host-tools.user.js`.
5. Reload the script in Tampermonkey and verify in the browser console that the
   `[DEBUG] Selector matched` log points at your new selector.

---

## Security Considerations

- The script runs entirely in the browser under the user's existing Zoom session.
- No credentials are stored or transmitted.
- No external resources are loaded.
- The debug panel uses `innerHTML` with string interpolation for internal
  status messages; values are numeric counters or strings taken from the Zoom
  DOM (for example, participant identifiers derived from display names).
- DOM events dispatched (`mouseover`, `keydown`) are standard synthetic events
  and do not exfiltrate data.

---

## Files

| File | Purpose |
|------|---------|
| `scripts/zoom-host-tools.user.js` | Main Tampermonkey userscript |
| `selectors/zoom-dom-selectors.json` | Selector map and fallback notes |
| `docs/automation-design.md` | This file — architecture and assumptions |
| `docs/testing-checklist.md` | Manual test plan |
