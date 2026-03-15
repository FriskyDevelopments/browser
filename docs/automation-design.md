# Zoom Co-Host Multi-Pin Automation — Design

## Overview

`scripts/zoom-host-tools.user.js` is a Tampermonkey userscript that automatically
grants **Multi-Pin** permissions to Zoom Web meeting participants who raise their
hand.  It runs entirely in the browser under a Host or Co-Host account and
requires no external infrastructure.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                     Tampermonkey Script                      │
│                                                              │
│  ┌─────────────────────┐   ┌────────────────────────────┐   │
│  │  WebSocket          │   │  DOM Fallback              │   │
│  │  Interceptor        │   │  (setInterval poll)        │   │
│  │  (monkey-patch)     │   │                            │   │
│  └──────────┬──────────┘   └────────────┬───────────────┘   │
│             │                           │                    │
│             ▼                           ▼                    │
│       emitZoomEvent("participant_hand_raised", ...)          │
│                         │                                    │
│                         ▼                                    │
│              ┌──────────────────────┐                        │
│              │  Internal Event Bus  │                        │
│              │  onZoomEvent(...)    │                        │
│              └──────────┬───────────┘                        │
│                         │                                    │
│                         ▼                                    │
│              ┌──────────────────────┐                        │
│              │  Automation Logic    │                        │
│              │  grantMultipin(name) │                        │
│              └──────────┬───────────┘                        │
│                         │                                    │
│                         ▼                                    │
│              ┌──────────────────────┐                        │
│              │  Participant         │                        │
│              │  Registry            │                        │
│              └──────────────────────┘                        │
└──────────────────────────────────────────────────────────────┘
```

---

## Components

### 1. WebSocket Interceptor (Primary Detection)

`installWebSocketInterceptor()` monkey-patches `window.WebSocket` before Zoom's
application code runs (`@run-at document-start`).  Every incoming message is
inspected by `handleWebSocketMessage()` / `tryParseZoomFrame()`.

Zoom sends both JSON and binary (protobuf-like) frames.  The interceptor handles
both and emits `participant_hand_raised` when a raised-hand pattern is detected.

Because Zoom's WebSocket protocol is proprietary and undocumented, heuristic
matching is used.  If the protocol changes the DOM fallback ensures continuity.

### 2. DOM Fallback (setInterval polling)

`scanParticipants()` runs every 2 seconds and inspects every participant row for
the raised-hand icon element (using `SELECTORS.raisedHandIcon`).  When found it
emits `participant_hand_raised`.

Duplicate events are suppressed by checking `registry.hasMultipin()` before
emitting.

### 3. Internal Event Bus

A lightweight pub/sub system:

```js
emitZoomEvent(type, payload)   // publish
onZoomEvent(type, handler)     // subscribe
```

This decouples detection from action, making it easy to add more listeners
(e.g. logging, analytics) without modifying detection code.

### 4. Participant Registry

An in-memory store tracking:

| Field | Type | Purpose |
|---|---|---|
| `participantsById` | `Map<string, object>` | Lookup by Zoom numeric ID |
| `participantsByName` | `Map<string, object>` | Lookup by display name |
| `multipinGranted` | `Set<string>` | IDs / names that have Multi-Pin |
| `cameraWarningSent` | `Set<string>` | IDs / names that received camera warning |

The registry is reset on page reload (single-page app navigations may need special handling — see Known Limitations).

### 5. Multi-Pin Action Executor

`grantMultipin(participantName)` drives the Zoom Web UI to grant Multi-Pin:

1. Ensure the Participants panel is open.
2. Find the participant's row.
3. Hover to reveal action buttons.
4. Click the "More options" (`…`) button.
5. Click "Allow to Multi-Pin" in the dropdown.
6. Mark the participant in the registry.

Retry logic (up to `MAX_MENU_RETRIES = 3`) handles timing issues with UI animations.

### 6. Selector Configuration

All CSS selectors are maintained in `selectors/zoom-dom-selectors.json` and
mirrored in the `SELECTORS` constant inside the script.  When Zoom updates its
CSS class names, only these two files need to be updated.

---

## Detection Hierarchy

```
1. WebSocket message → participant_hand_raised  (fast, ~real-time)
         ↓ (if WebSocket frame not parseable)
2. DOM poll every 2 s → participant_hand_raised  (fallback, slightly delayed)
```

Both paths converge on the same internal event, so automation logic is
identical regardless of detection method.

---

## Phase Roadmap

| Phase | Status | Description |
|---|---|---|
| 1 | ✅ Implemented | Detect raised hand → grant Multi-Pin |
| 2 | 🔧 Scaffold | Camera check → chat warning |
| 3 | 🔧 Scaffold | Chat spam detection → moderation hooks |

---

## Known Limitations

- **Undocumented WebSocket protocol** — Zoom's frame format may change without
  notice.  The DOM fallback is the reliability safety net.
- **SPA navigation** — If Zoom navigates between routes without a full page
  reload, the registry is preserved but WebSocket connections may be replaced.
  The interceptor handles new `WebSocket` instances automatically.
- **CSS selector drift** — Zoom's React/Vue component class names are often
  hashed and may change with updates.  Maintaining `zoom-dom-selectors.json`
  after Zoom UI releases is required for continued operation.
- **Menu timing** — Zoom's dropdown animations may cause race conditions.
  `ACTION_DELAY_MS` and `MAX_MENU_RETRIES` mitigate this but may need tuning.

---

## Configuration

All tuneable values are at the top of the script:

| Constant | Default | Purpose |
|---|---|---|
| `DEBUG_MODE` | `true` | Enable verbose console logging |
| `POLL_INTERVAL_MS` | `2000` | DOM fallback polling interval |
| `ACTION_DELAY_MS` | `500` | Delay between UI interaction steps |
| `MAX_MENU_RETRIES` | `3` | Max retries for opening participant menu |

---

## Deployment

1. Install the [Tampermonkey](https://www.tampermonkey.net/) browser extension.
2. Create a new script and paste the contents of `scripts/zoom-host-tools.user.js`.
3. Save the script.
4. Join a Zoom meeting via the web client (`https://*.zoom.us/wc/…`).
5. Open the browser console (F12) to see `[ZoomHostTools]` log output.
