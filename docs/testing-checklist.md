# Zoom Co-Host Multi-Pin Automation — Testing Checklist

Use this checklist to verify the automation before deploying it in a live
meeting.  Each section corresponds to a functional area of the script.

---

## Pre-Flight

- [ ] Tampermonkey (or Violentmonkey) is installed in the browser
- [ ] The userscript is installed from `scripts/zoom-host-tools.user.js`
- [ ] The script is **enabled** in the Tampermonkey dashboard
- [ ] You are signed into Zoom Web as a Host or Co-Host
- [ ] Browser console is open (F12) to monitor `[ZoomHostTools]` output

---

## 1. Script Load

- [ ] Navigating to `https://*.zoom.us/wc/<id>/join` shows the following console message:
  ```
  [ZoomHostTools] [INFO] Zoom Co-Host Multi-Pin Automation initialising…
  ```
- [ ] The following message appears shortly after:
  ```
  [ZoomHostTools] [INFO] Zoom Co-Host Multi-Pin Automation ready
  ```
- [ ] No uncaught JavaScript errors appear in the console during load

---

## 2. WebSocket Interceptor

- [ ] Console shows:
  ```
  [ZoomHostTools] [INFO] WebSocket interceptor installed
  ```
- [ ] When a participant raises their hand, the console shows a `WebSocket JSON
  frame` debug line (if `DEBUG_MODE = true`)
- [ ] A `participant_hand_raised` event is emitted via the WebSocket path
  (look for `[ZoomHostTools] [DEBUG] Event emitted: participant_hand_raised`)

---

## 3. DOM Fallback Polling

- [ ] Console shows:
  ```
  [ZoomHostTools] [INFO] DOM fallback polling started (interval: 2000ms)
  ```
- [ ] When a participant raises their hand and the WebSocket path does **not**
  emit an event, the DOM fallback emits `participant_hand_raised` within ~2 s
- [ ] Console shows a `DOM scan:` debug line confirming the raised-hand icon
  was detected

---

## 4. Multi-Pin Grant — Happy Path

- [ ] A second browser session joins as a non-host participant
- [ ] The participant raises their hand
- [ ] Within a few seconds the console shows:
  ```
  [ZoomHostTools] [INFO] Attempting to grant Multi-Pin to "<name>"
  [ZoomHostTools] [INFO] Multi-Pin granted to "<name>"
  ```
- [ ] The participant's entry in the Participants panel shows they now have
  Multi-Pin permission (typically indicated by a pin icon or a label)
- [ ] The console does **not** show a second grant attempt for the same
  participant after the first succeeds

---

## 5. Duplicate Prevention

- [ ] Raise the same participant's hand a second time (lower it first, then
  raise again)
- [ ] Console shows:
  ```
  [ZoomHostTools] [INFO] "<name>" already has Multi-Pin – skipping
  ```
- [ ] No second Multi-Pin grant UI interaction is attempted

---

## 6. Retry Logic

- [ ] (Simulate by temporarily hiding the "More options" button via DevTools)
- [ ] Console shows retry messages:
  ```
  [ZoomHostTools] [WARN] grantMultipin: menu button not found for "<name>" (attempt 1)
  [ZoomHostTools] [WARN] grantMultipin: menu button not found for "<name>" (attempt 2)
  ```
- [ ] After `MAX_MENU_RETRIES` attempts, an error is logged and the function exits cleanly

---

## 7. Chat Spam Monitor

- [ ] Console shows:
  ```
  [ZoomHostTools] [INFO] Chat spam monitor started
  ```
  (may be deferred by ~5 s after page load)
- [ ] When a chat message containing `http://`, `https://`, `t.me/`, `bit.ly/`,
  or `discord.gg/` is sent by a participant, the console shows:
  ```
  [ZoomHostTools] [WARN] Chat spam detected from "<name>": <message>
  ```
- [ ] No moderation action is taken (Phase 3 is scaffold only)

---

## 8. Selector Health Check

Run the following in the browser console to verify selectors resolve against
the live Zoom DOM:

```js
const S = {
  participantList: ".participants-wrapper__inner, .participants-list__list, [class*='participants-list']",
  participantRow: ".participants-item, .participants-list__item, [class*='participants-item']",
  participantName: ".participants-item__display-name, .participants-list__item-name, [class*='display-name']",
  raisedHandIcon: ".participants-item__raised-hand, [class*='raised-hand'], [aria-label*='Raised Hand'], [aria-label*='raised hand']",
  participantMenuButton: ".participants-item__action-btn--more, [aria-label='More options'], [aria-label*='more option']",
  multipinMenuOption: "[aria-label='Allow to Multi-Pin'], [class*='multi-pin']",
};
Object.entries(S).forEach(([name, sel]) => {
  const el = document.querySelector(sel);
  console.log(name, el ? "✅ FOUND" : "❌ NOT FOUND", sel);
});
```

- [ ] `participantList` — ✅ FOUND
- [ ] `participantRow` — ✅ FOUND (at least one participant visible)
- [ ] `participantName` — ✅ FOUND
- [ ] `raisedHandIcon` — ✅ FOUND (only when someone has their hand raised)
- [ ] `participantMenuButton` — ✅ FOUND (hover over a row first)
- [ ] `multipinMenuOption` — ✅ FOUND (only when the "More options" menu is open)

If any selector returns ❌, update `selectors/zoom-dom-selectors.json` and the
corresponding entry in the `SELECTORS` constant inside the userscript.

---

## 9. DEBUG_MODE Toggle

- [ ] Set `DEBUG_MODE = false` inside the script
- [ ] Reload the meeting page
- [ ] Confirm that `[DEBUG]` lines no longer appear in the console
- [ ] Confirm that `[INFO]` and `[WARN]` lines still appear

---

## 10. Edge Cases

- [ ] Participant joins the meeting after the script has loaded → still
  detected and processed correctly
- [ ] Multiple participants raise their hand at the same time → all receive
  Multi-Pin grants (each handled independently)
- [ ] Participant raises hand before the Participants panel has been opened →
  script opens the panel automatically before acting
- [ ] Zoom UI updates cause a selector to stop matching → DOM fallback
  continues working for any selector that still matches; logs indicate which
  selector failed

---

## Known Issues / Out of Scope

- Phase 2 (camera warning chat message) is not yet implemented — `sendCameraWarning()` will throw if called.
- Phase 3 (moderation actions) is not yet implemented — `warnUser()`, `moveToWaitingRoom()`, and `removeParticipant()` will throw if called.
- Binary WebSocket frames (protobuf) are not decoded; these fall through to the DOM fallback.
