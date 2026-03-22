# Zoom Host Automation — Design Document

## Project Goal

This project provides a lightweight Tampermonkey userscript that runs inside a Zoom Web meeting under a **host or co-host** account. Its primary task is to automatically grant **Multi-Pin** permission to any participant who raises their hand, removing the need for the host to perform this action manually.

Secondary goals include a spam-detection scaffold for the chat panel and a camera-off reminder scaffold.

---

## Architecture

The entire solution is a single self-contained JavaScript file (`scripts/zoom-host-tools.user.js`) executed by the [Tampermonkey](https://www.tampermonkey.net/) browser extension. No backend services, build steps, or external dependencies are required.

```
browser/
├── scripts/
│   └── zoom-host-tools.user.js   # Main TamperMonkey userscript
├── selectors/
│   └── zoom-dom-selectors.json   # Canonical selector reference (update both when DOM changes)
└── docs/
    ├── automation-design.md      # This file
    └── testing-checklist.md      # Manual QA checklist
```

### Key Design Decisions

| Decision | Rationale |
|---|---|
| Single-file userscript | No build pipeline; install and run directly in TamperMonkey |
| Selectors in JSON + embedded copy | JSON is the human-editable reference; embedded object is the runtime source of truth. Both must be kept in sync manually. |
| Self-scheduling `setTimeout` poll (2 s) | Prevents scan overlaps; `isScanning` flag further guards against concurrent runs |
| Polling + MutationObserver hybrid | Observer triggers immediate scans when the participant list changes; poll provides reliable fallback |
| `async/await` throughout | Clicking menus requires waiting for DOM transitions; async keeps the code readable |
| No frameworks | Keeps the payload tiny and the code auditable |

---

## Selector Strategy

CSS selectors for Zoom Web DOM elements are defined in two places:

1. **`selectors/zoom-dom-selectors.json`** — The canonical, human-editable reference.  
   Update this file whenever Zoom changes its DOM.

2. **Embedded `SELECTORS` object in the userscript** — A copy of the JSON embedded directly in the script so TamperMonkey can use them without fetching a separate file.  
   **Both files must be updated together** — the script reads only the embedded object at runtime.

Every selector is represented as `{ primary, fallback }`. The `resolve()` helper tries `primary` first; if it returns no element it tries `fallback` and increments the `selectorFallbacks` counter in the debug panel. This two-layer approach provides resilience against minor DOM changes without requiring an immediate full selector update.

---

## Multi-Pin Automation Logic

```
setTimeout self-scheduling poll (every 2 s)  +  MutationObserver on participant list
  └─ scanParticipants()  [guarded by isScanning flag]
       └─ for each participantRow
            ├─ read display name
            ├─ derive stable key (data-uid / data-userid / data-participantId → name fallback)
            ├─ skip if key already in processedParticipants Set
            ├─ detect raisedHandIcon
            │    └─ (skip if absent)
            ├─ checkCameraStatus()   ← scaffold; logs camera-off, no chat action yet
            ├─ checkMultipinStatus()
            │    ├─ open participant menu
            │    ├─ verify menu opened (any menuItem visible)
            │    ├─ look for "Allow to Multi-Pin" option
            │    └─ close menu; return MULTIPIN enum:
            │         ├─ NEEDS_GRANT     → option visible
            │         ├─ ALREADY_GRANTED → menu opened, option absent
            │         └─ ERROR           → menu did not open (retry next scan)
            ├─ NEEDS_GRANT → grantMultipin()
            │    ├─ open menu, verify opened
            │    ├─ click "Allow to Multi-Pin"
            │    ├─ add key to processedParticipants
            │    └─ update debug panel (grants / lastParticipant / lastGrantResult)
            ├─ ALREADY_GRANTED → add key to processedParticipants; skip silently
            └─ ERROR → do NOT mark processed; will retry on next scan
```

### Idempotency

The `processedParticipants` `Set` is maintained in memory for the lifetime of the page. Once a participant has been confirmed (Multi-Pin granted or already active), their **stable key** is added to the set and they are skipped on all future scans.

Stable keys are derived in order of preference:
1. `data-uid` attribute on the participant row
2. `data-userid` attribute
3. `data-participantId` attribute
4. `data-id` attribute
5. Visible display name (last resort — susceptible to name collisions)

> **Note:** The set is cleared if the page is reloaded. This is acceptable because a page reload resets the meeting UI state as well.

### Retry Protection

`grantMultipin()` will attempt up to **two times** before giving up, logging a specific failure reason at each step:

- *"menu button not found"* — row was removed from DOM mid-scan
- *"menu did not open"* — click landed but no menu items appeared
- *"Allow to Multi-Pin option not found"* — menu opened but option absent (possibly already granted)

If `checkMultipinStatus()` returns `ERROR`, the participant is **not** added to `processedParticipants`, so the scan will retry on the next poll.

---

## Extension Points

### Camera Check (`checkCameraStatus`)

A scaffold function is in place with documented trigger conditions. To complete it:

1. Implement `sendChatMessage(text)` using the `chatInput` selector.
2. Add a `cameraReminderSent` Set to guard against repeated messages.
3. Trigger inside `scanParticipants` after a successful Multi-Pin grant when camera is off.

Trigger conditions (once implemented):
- Participant raised their hand
- Multi-Pin grant confirmed (`NEEDS_GRANT` path)
- `cameraStatusIcon` present in participant row
- Participant not already in `cameraReminderSent`

### Chat Moderation (`monitorChat`)

The `MutationObserver` attached to the chat container already detects messages containing known spam patterns, with:
- Per-sender rate-limiting (`SPAM_COOLDOWN_MS = 10 s`)
- Automatic observer reconnect if the chat container is re-rendered by Zoom's SPA

To add moderation actions:
1. Implement `muteParticipant(name)` using the participant menu.
2. Call it from inside the `spamDetected` block in `monitorChat`.

---

## Limitations & Known Risks

- **DOM Changes:** Zoom updates its web client regularly. If the script stops working, inspect the participant list in DevTools and update the selectors in both `zoom-dom-selectors.json` and the embedded `SELECTORS` object.
- **Host Privileges Required:** The script will silently do nothing if the user does not have host or co-host status, because the "Allow to Multi-Pin" menu item will not appear.
- **In-Memory State:** Reloading the page resets `processedParticipants`. This is acceptable but means participants who raised their hand before the reload may be re-processed.
- **Name Collisions:** Participants with identical display names and no stable `data-*` attribute will share a key. Only the first one will be processed.
- **Single-Tab:** The script runs independently in each browser tab. Running it in multiple tabs for the same meeting is not recommended.

---

## Migration Path

This script is designed as a **Phase-1 behavioral prototype**. The following mapping shows how each function maps to future architecture components if the script is later promoted to a browser extension or platform module:

| Current function | Future component | Notes |
|---|---|---|
| `scanParticipants()` + `watchParticipantList()` | **Event bus subscriber** | Emit `participant.handRaised` events; decouple detection from action |
| `checkMultipinStatus()` + `grantMultipin()` | **Zoom adapter layer** | Isolate all DOM interactions behind a `ZoomAPI` interface |
| `monitorChat()` | **Platform module: moderation** | Promote to full moderation pipeline once action hooks are implemented |
| `checkCameraStatus()` | **Platform module: camera policy** | Trigger-condition logic belongs in a policy engine, not inline |
| `SELECTORS` + `zoom-dom-selectors.json` | **Selector registry** | Load from versioned config; validate against current DOM on startup |
| `processedParticipants` Set | **Session state store** | Persist across page reloads using `sessionStorage` or extension background storage |
| `stats` object + debug panel | **Observability layer** | Emit structured events; replace console logs with structured logging |

**Invariants to preserve** in all future forms:
- Multi-Pin grant remains the primary confirmed behavior
- Selectors stay centralized and updatable without code changes
- Camera-check and moderation features remain honestly labeled as scaffolds until fully implemented
