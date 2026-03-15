# Zoom Host Tools — Manual Testing Checklist

Use this checklist to verify that the script is working correctly in a live or
test Zoom Web meeting. All tests assume you are logged in with **Host** or
**Co-Host** permissions.

---

## Prerequisites

- [ ] Tampermonkey (or Violentmonkey) extension installed in Chrome / Firefox / Edge
- [ ] `zoom-host-tools.user.js` installed in Tampermonkey and enabled
- [ ] A test Zoom Web meeting open at `https://*.zoom.us/wc/*` or `https://*.zoom.us/j/*`
- [ ] At least two participants in the meeting (one as host/co-host, one as a test participant)
- [ ] Browser DevTools console open (F12 → Console) so you can read script logs

---

## 1 — Script Load

| # | Test | Expected Result | Pass/Fail |
|---|------|-----------------|-----------|
| 1.1 | Open a Zoom Web meeting URL | Script matches the `@match` URL patterns | |
| 1.2 | Check browser console | `[ZoomHostTools] [INFO] Waiting for Zoom Web to be ready…` log appears | |
| 1.3 | Wait ~5 seconds after meeting loads | `[ZoomHostTools] [INFO] Zoom Web ready. Starting automation.` log appears | |
| 1.4 | Check bottom-right of page | A small dark debug panel labelled "🔧 ZoomHostTools" appears | |
| 1.5 | Open `about:blank` in a new tab | No script logs appear (URL does not match `@match`) | |

---

## 2 — Raised Hand Detection

| # | Test | Expected Result | Pass/Fail |
|---|------|-----------------|-----------|
| 2.1 | Open the Participants panel in Zoom | Debug panel "Scans" counter increments every ~2.5 seconds | |
| 2.2 | Test participant raises their hand | Console log: `[ZoomHostTools] [INFO] Detected raised hand: name:<ParticipantName>` | |
| 2.3 | Test participant lowers their hand | On the next scan, no raised-hand log for that participant | |
| 2.4 | Close the Participants panel | No error logs appear; scans continue silently | |

---

## 3 — Multi-Pin Grant (Phase 1 — Core Feature)

| # | Test | Expected Result | Pass/Fail |
|---|------|-----------------|-----------|
| 3.1 | Test participant raises their hand (first time) | Console: `[INFO] Granting multipin for participant: name:<ParticipantName>` | |
| 3.2 | Same scan | Participant's action menu opens briefly and closes | |
| 3.3 | Same scan | Console: `[INFO] Multi-Pin granted successfully for participant: name:<ParticipantName>` | |
| 3.4 | Verify in Zoom | Participant now has Multi-Pin permission (visible in Zoom participant list or menu) | |
| 3.5 | Debug panel | "Grants attempted" counter increments by 1 | |

---

## 4 — Deduplication (No Repeated Grants)

| # | Test | Expected Result | Pass/Fail |
|---|------|-----------------|-----------|
| 4.1 | Keep test participant's hand raised after grant | On next scan, console: `[DEBUG] Participant already processed, skipping: name:<ParticipantName>` | |
| 4.2 | Test participant lowers and re-raises hand | Participant is already in the processed set — no repeated grant | |
| 4.3 | Reload the page and repeat 3.1 | Grant executes again (state was reset on reload — expected) | |

---

## 5 — Error Handling and Selector Failures

| # | Test | Expected Result | Pass/Fail |
|---|------|-----------------|-----------|
| 5.1 | Temporarily change a selector in `SELECTORS` to `"[data-testid='does-not-exist']"` | Console: `[WARN] Failed to find menu button for participant: …` — script does NOT crash | |
| 5.2 | Open a non-Zoom HTTPS page | No logs, no debug panel (URL does not match) | |
| 5.3 | Revoke Co-Host before a grant attempt | Menu opens; "Allow to Multi-Pin" is absent; console: `[WARN] Failed to find Multi-Pin menu item for participant: …` | |
| 5.4 | Use DevTools to delete the participant list container from the DOM | Console: `[DEBUG] Participant list container not found` — script continues to run | |

---

## 6 — Selector Debugging Workflow

| # | Test | Expected Result | Pass/Fail |
|---|------|-----------------|-----------|
| 6.1 | Enable `CONFIG.DEBUG = true` | All `[DEBUG]` logs visible in console | |
| 6.2 | Trigger a participant scan | Console shows `[DEBUG] Selector matched: "<selector>"` for each element found | |
| 6.3 | Update a selector to a new value in the script | Console immediately shows the new selector in the "matched" log | |
| 6.4 | View `selectors/zoom-dom-selectors.json` | File contains `candidates` arrays and `fallbackStrategy` notes for every element | |

---

## 7 — Phase 2 Camera Check (Scaffold Verification)

| # | Test | Expected Result | Pass/Fail |
|---|------|-----------------|-----------|
| 7.1 | Grant Multi-Pin to a participant with camera ON | Console: `[INFO] Camera appears ON for participant: …` OR `[DEBUG] Camera status: unable to detect…` | |
| 7.2 | Grant Multi-Pin to a participant with camera OFF | Console: `[INFO] Camera is OFF for participant: …` OR `[DEBUG] Camera status: unable to detect…` | |
| 7.3 | Review Phase 2 TODO comments in script | `checkCameraStatus()` contains clear `// TODO (Phase 2):` comments describing next steps | |

---

## 8 — Phase 3 Chat Monitoring (Scaffold Verification)

| # | Test | Expected Result | Pass/Fail |
|---|------|-----------------|-----------|
| 8.1 | Send a normal chat message | No warning log | |
| 8.2 | Send a chat message containing `https://example.com` | Console: `[WARN] Potential spam detected from "…": …` | |
| 8.3 | Send a message containing `t.me/something` | Console: `[WARN] Potential spam detected from "…": …` | |
| 8.4 | Send a message containing `discord.gg/invite` | Console: `[WARN] Potential spam detected from "…": …` | |
| 8.5 | Review Phase 3 TODO comments in script | `checkMessageForSpam()` has clear `// TODO (Phase 3):` comments for future moderation actions | |

---

## 9 — Extension and Maintainability

| # | Test | Expected Result | Pass/Fail |
|---|------|-----------------|-----------|
| 9.1 | Read `docs/automation-design.md` | Architecture, assumptions, and extension points are clearly documented | |
| 9.2 | Find all `// TODO` comments in the script | Each TODO belongs to a clearly labelled Phase (2 or 3) | |
| 9.3 | Identify where to add a new spam pattern | `CONFIG.SPAM_PATTERNS` array at the top of the script — one line to add | |
| 9.4 | Identify where to update a broken selector | `SELECTORS` constant in the script and matching entry in `selectors/zoom-dom-selectors.json` | |

---

## Notes

- Zoom Web's DOM structure can change with any Zoom update. If any test in
  section 3 fails, compare the live DOM in DevTools against the selectors in
  `SELECTORS` and update the `candidates` arrays.
- Camera detection (section 7) is explicitly best-effort. Failure to detect
  camera state is not a bug — see Phase 2 design notes in `automation-design.md`.
- All Phase 3 chat tests only verify logging; no automated moderation action
  should be triggered at this stage.
