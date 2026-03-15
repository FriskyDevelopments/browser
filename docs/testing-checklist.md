# Zoom Host Automation — Testing Checklist

Manual QA checklist for `scripts/zoom-host-tools.user.js`.

## Prerequisites

- [ ] Tampermonkey extension is installed in the test browser
- [ ] `scripts/zoom-host-tools.user.js` is installed as a Tampermonkey userscript
- [ ] The test Zoom account has **host** or **co-host** privileges
- [ ] A second Zoom account (participant) is available for testing

---

## Test Cases

### 1. Script Loads Correctly

**Steps:**
1. Open a Zoom Web meeting (`https://*.zoom.us/wc/*`) with the host account.
2. Open the browser DevTools console.

**Expected:**
- `[ZoomHostAuto] Zoom Host Automation initializing…` appears in the console.
- `[ZoomHostAuto] Zoom Host Automation active (interval: 2000ms)` appears in the console.
- A floating debug panel is visible in the bottom-right corner of the page showing "🤖 Zoom Host Automation".

**Pass / Fail:** ___

---

### 2. Raised Hand Detected

**Steps:**
1. Have the participant account raise their hand in the meeting.
2. Wait up to 4 seconds (two scan intervals).

**Expected:**
- Console shows: `[ZoomHostAuto] ✋ Raised hand detected: "<participant name>"`
- The "Raised hands" counter in the debug panel increments by 1.

**Pass / Fail:** ___

---

### 3. Multi-Pin Granted Automatically

**Steps:**
1. Continue from Test 2 (participant's hand is raised and Multi-Pin has not been granted yet).
2. Wait up to 4 seconds after the raised-hand log entry.

**Expected:**
- Console shows: `[ZoomHostAuto] ✅ Granted Multi-Pin to "<participant name>"`
- "Multi-Pin grants" counter in the debug panel increments by 1.
- "Last action" in the debug panel updates to `Granted Multi-Pin to <name>`.
- In Zoom's participant list the participant now has Multi-Pin enabled (verify via the participant menu — the "Allow to Multi-Pin" option should be absent or replaced by "Disable Multi-Pin").

**Pass / Fail:** ___

---

### 4. Same Participant Not Processed Twice

**Steps:**
1. After Test 3, have the participant lower and then raise their hand again.
2. Wait for two scan intervals.

**Expected:**
- Console shows: `[ZoomHostAuto] ℹ️  Multi-Pin already granted for "<participant name>"; skipping` **OR** the participant is simply skipped silently (because their name is in `processedParticipants`).
- "Multi-Pin grants" counter does **not** increment again.

**Pass / Fail:** ___

---

### 5. Script Survives Missing Selectors

**Steps:**
1. Temporarily change a selector in the embedded `SELECTORS` object in the script to an invalid value (e.g., `participantList.primary = '.does-not-exist'`).
2. Reload the meeting page.
3. Wait for several scan intervals.

**Expected:**
- No uncaught JavaScript errors or exceptions in the console.
- The script continues to run (polling loop does not crash).
- Selector failures are either silently skipped or logged as warnings.

**Restore:** Revert the selector change after this test.

**Pass / Fail:** ___

---

### 6. Debug Logs Visible in Console

**Steps:**
1. Ensure `DEBUG_MODE = true` in the script (default).
2. Open the meeting with the host account.
3. Observe the DevTools console.

**Expected:**
- All `[ZoomHostAuto]` log lines appear in the console throughout the meeting.
- No logs appear when `DEBUG_MODE` is set to `false`.

**Pass / Fail:** ___

---

### 7. Chat Monitor Detects Spam (Scaffold)

**Steps:**
1. Open the chat panel in the meeting.
2. From the participant account, send a message containing a URL (e.g., `http://example.com`).
3. Observe the DevTools console on the host account's browser.

**Expected:**
- Console shows: `[ZoomHostAuto] ⚠️  Possible spam detected | user: "<name>" | message: "<text>"`
- No automatic moderation action is taken (this is a scaffold — action hooks are not yet implemented).

**Pass / Fail:** ___

---

### 8. Camera-Off Detection Logged (Scaffold)

**Steps:**
1. Ensure the participant's camera is **off**.
2. Have the participant raise their hand.
3. Observe the console after the scan picks up the raised hand.

**Expected:**
- Console shows: `[ZoomHostAuto] 📷 Camera is OFF for "<participant name>"`
- No chat message is sent automatically (full implementation is a TODO).

**Pass / Fail:** ___

---

## Regression Notes

| Date | Tester | Zoom Web Version | Overall Result | Notes |
|------|--------|-----------------|---------------|-------|
|      |        |                 |               |       |
