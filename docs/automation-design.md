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
│   └── zoom-dom-selectors.json   # Configurable CSS selectors (source of truth)
└── docs/
    ├── automation-design.md      # This file
    └── testing-checklist.md      # Manual QA checklist
```

### Key Design Decisions

| Decision | Rationale |
|---|---|
| Single-file userscript | No build pipeline; install and run directly in TamperMonkey |
| Selectors isolated in JSON | Easy to update when Zoom updates its DOM without touching logic |
| `setInterval` polling (2 s) | Zoom's SPA does not expose reliable hooks; polling is the simplest resilient approach |
| `async/await` throughout | Clicking menus requires waiting for DOM transitions; async keeps the code readable |
| No frameworks | Keeps the payload tiny and the code auditable |

---

## Selector Strategy

CSS selectors for Zoom Web DOM elements are defined in two places:

1. **`selectors/zoom-dom-selectors.json`** — The canonical, human-editable reference.  
   Update this file whenever Zoom changes its DOM.

2. **Embedded `SELECTORS` object in the userscript** — A copy of the JSON embedded directly in the script so TamperMonkey can use them without fetching a separate file.  
   Keep this in sync with the JSON file.

Every selector is represented as `{ primary, fallback }`. The `resolve()` helper tries `primary` first; if it returns no element, it tries `fallback`. This two-layer approach provides resilience against minor DOM changes without requiring an immediate selector update.

---

## Multi-Pin Automation Logic

```
setInterval (every 2 s)
  └─ scanParticipants()
       └─ for each participantRow
            ├─ read name
            ├─ skip if already in processedParticipants Set
            ├─ detect raisedHandIcon
            │    └─ (skip if absent)
            ├─ checkCameraStatus()   ← scaffold, no-op for now
            ├─ needsMultipin()
            │    ├─ open participant menu
            │    ├─ look for "Allow to Multi-Pin" option
            │    └─ close menu; return boolean
            └─ grantMultipin()  (only if needsMultipin returned true)
                 ├─ open participant menu
                 ├─ click "Allow to Multi-Pin"
                 ├─ add name to processedParticipants
                 └─ update debug panel stats
```

### Idempotency

The `processedParticipants` `Set` is maintained in memory for the lifetime of the page. Once a participant has been processed (either Multi-Pin granted, or Multi-Pin was already active), their name is added to the set and they are skipped on all future scans.

> **Note:** The set is cleared if the page is reloaded. This is acceptable because a page reload resets the meeting UI state as well.

### Retry Protection

`grantMultipin()` will attempt to open the menu and find the option up to **two times** before giving up and logging a warning. This guards against transient rendering delays.

---

## Extension Points

### Camera Check (`checkCameraStatus`)

A scaffold function is already in place. To complete it:

1. Implement `sendChatMessage(text)` using the `chatInput` selector.
2. Call `sendChatMessage("Please turn your camera on to use Multi-Pin.")` inside `checkCameraStatus` when `cameraStatusIcon` is detected.

### Chat Moderation (`monitorChat`)

The `MutationObserver` attached to the chat container already detects messages containing known spam patterns. To add moderation actions:

1. Implement `muteParticipant(name)` using the participant menu.
2. Call it from inside the `spamDetected` block in `monitorChat`.

---

## Limitations & Known Risks

- **DOM Changes:** Zoom updates its web client regularly. If the script stops working, inspect the participant list in DevTools and update the selectors.
- **Host Privileges Required:** The script will silently do nothing if the user does not have host or co-host status, because the "Allow to Multi-Pin" menu item will not appear.
- **In-Memory State:** Reloading the page resets `processedParticipants`. This is acceptable but means participants who raised their hand before the reload may be re-processed.
- **Single-Tab:** The script runs independently in each browser tab. Running it in multiple tabs for the same meeting is not recommended.
