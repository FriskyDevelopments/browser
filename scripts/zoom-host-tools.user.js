// ==UserScript==
// @name         Zoom Co-Host Multi-Pin Automation
// @namespace    https://github.com/FriskyDevelopments/browser
// @version      1.0.0
// @description  Automatically grant Multi-Pin permissions to participants who raise their hand during a Zoom meeting.
// @author       FriskyDevelopments
// @match        https://*.zoom.us/wc/*
// @match        https://*.zoom.us/j/*
// @match        https://zoom.us/wc/*
// @match        https://zoom.us/j/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  "use strict";

  // ─────────────────────────────────────────────────────────────────────────────
  // CONFIGURATION
  // ─────────────────────────────────────────────────────────────────────────────

  const DEBUG_MODE = false;

  // Polling interval for DOM fallback (ms)
  const POLL_INTERVAL_MS = 2000;

  // How long to wait (ms) between steps when driving the participant menu
  const ACTION_DELAY_MS = 500;

  // How many times to retry opening a participant menu before giving up
  const MAX_MENU_RETRIES = 3;

  // Selectors are loaded from the companion JSON file.
  // When running as a Tampermonkey script the JSON cannot be imported directly,
  // so the selectors are embedded here and kept in sync with
  // selectors/zoom-dom-selectors.json.
  const SELECTORS = {
    participantList:
      ".participants-wrapper__inner, .participants-list__list, [class*='participants-list']",
    participantRow:
      ".participants-item, .participants-list__item, [class*='participants-item']",
    participantName:
      ".participants-item__display-name, .participants-list__item-name, [class*='display-name']",
    raisedHandIcon:
      ".participants-item__raised-hand, [class*='raised-hand'], [aria-label*='Raised Hand'], [aria-label*='raised hand']",
    participantMenuButton:
      ".participants-item__action-btn--more, [aria-label='More options'], [aria-label*='more option']",
    multipinMenuOption:
      "[aria-label='Allow to Multi-Pin'], [class*='multi-pin']",
    cameraStatusIcon:
      ".participants-item__camera, [class*='video-off'], [aria-label*='Camera Off'], [aria-label*='camera off']",
    chatContainer:
      ".chat-container__main-body, [class*='chat-container'], #chatPanel",
    chatMessage:
      ".chat-message__content, .chat-item, [class*='chat-message']",
    chatInput:
      ".chat-compose__inner input, [class*='chat-input'], #chat-input",
    participantMenuContainer:
      ".participants-item__actions-menu, .dropdown-menu, [class*='dropdown-menu']",
    participantListPanel:
      "#participants-list-panel, .participants-panel, [class*='participants-panel']",
    participantListButton:
      "[aria-label='Participants'], [aria-label='participants']",
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // RUNTIME STATE
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Mutable runtime state collected during the session.
   * Keeping it in one object makes cleanup straightforward (e.g. on SPA navigation).
   */
  const state = {
    /** setInterval ID returned by startDomFallbackPolling() */
    pollIntervalId: null,
    /** MutationObserver instance watching the chat panel */
    chatObserver: null,
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // LOGGING HELPERS
  // ─────────────────────────────────────────────────────────────────────────────

  function log(level, ...args) {
    const prefix = "[ZoomHostTools]";
    if (level === "debug" && !DEBUG_MODE) return;
    const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    fn(prefix, `[${level.toUpperCase()}]`, ...args);
  }

  const debug = (...args) => log("debug", ...args);
  const info = (...args) => log("info", ...args);
  const warn = (...args) => log("warn", ...args);
  const error = (...args) => log("error", ...args);

  // ─────────────────────────────────────────────────────────────────────────────
  // INTERNAL EVENT SYSTEM
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * A minimal publish-subscribe event bus used to decouple detection
   * (WebSocket / DOM) from automation logic.
   *
   * Supported event types:
   *   participant_hand_raised  – a participant raised their hand
   *   participant_joined       – a participant joined the meeting
   *   participant_camera_off   – a participant turned their camera off
   *   chat_message             – a chat message was received
   */
  const eventHandlers = {};

  /**
   * Register a handler for an event type.
   * @param {string} type
   * @param {Function} handler
   */
  function onZoomEvent(type, handler) {
    if (!eventHandlers[type]) {
      eventHandlers[type] = [];
    }
    eventHandlers[type].push(handler);
  }

  /**
   * Emit an internal event, calling all registered handlers.
   * @param {string} type
   * @param {object} payload
   */
  function emitZoomEvent(type, payload) {
    debug(`Event emitted: ${type}`, payload);
    const handlers = eventHandlers[type] || [];
    handlers.forEach((handler) => {
      try {
        handler(payload);
      } catch (err) {
        error(`Handler error for event "${type}":`, err);
      }
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // PARTICIPANT REGISTRY
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Central store of known participants and their automation state.
   *
   * participantsById    – Map<string, object>  keyed by numeric/string participantId
   * participantsByName  – Map<string, object>  keyed by display name (lower-cased)
   * multipinGranted     – Set<string>          participantIds that received Multi-Pin
   * cameraWarningSent   – Set<string>          participantIds that received the camera warning
   */
  const registry = {
    participantsById: new Map(),
    participantsByName: new Map(),
    multipinGranted: new Set(),
    cameraWarningSent: new Set(),

    /** Upsert a participant record. */
    upsert(participant) {
      if (participant.id) {
        this.participantsById.set(String(participant.id), participant);
      }
      if (participant.name) {
        this.participantsByName.set(participant.name.toLowerCase(), participant);
      }
    },

    /** Check whether Multi-Pin has already been granted to a participant. */
    hasMultipin(idOrName) {
      const key = String(idOrName);
      if (this.multipinGranted.has(key)) return true;
      // Also check by name
      const byName = this.participantsByName.get(key.toLowerCase());
      if (byName && this.multipinGranted.has(String(byName.id))) return true;
      return false;
    },

    /** Mark a participant as having received Multi-Pin. */
    markMultipin(idOrName) {
      this.multipinGranted.add(String(idOrName));
      const byName = this.participantsByName.get(String(idOrName).toLowerCase());
      if (byName) this.multipinGranted.add(String(byName.id));
    },
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // WEBSOCKET INTERCEPTION (PRIMARY DETECTION)
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Attempt to detect raised-hand events (and other state changes) from Zoom's
   * WebSocket traffic by monkey-patching window.WebSocket.
   *
   * Zoom's WebSocket protocol is proprietary and not publicly documented, so
   * this function looks for common patterns heuristically.  If a message cannot
   * be reliably decoded the DOM fallback will handle detection instead.
   */
  function installWebSocketInterceptor() {
    const OriginalWebSocket = window.WebSocket;
    if (!OriginalWebSocket) {
      warn("WebSocket not available – skipping interceptor");
      return;
    }

    class InterceptedWebSocket extends OriginalWebSocket {
      constructor(...args) {
        super(...args);
        debug("WebSocket created:", args[0]);
        this.addEventListener("message", (event) => {
          handleWebSocketMessage(event.data);
        });
      }
    }

    window.WebSocket = InterceptedWebSocket;
    // Preserve prototype chain so Zoom's own code can still use `instanceof`
    Object.setPrototypeOf(InterceptedWebSocket.prototype, OriginalWebSocket.prototype);
    info("WebSocket interceptor installed");
  }

  /**
   * Attempt to decode a raw WebSocket message and emit internal events.
   * Zoom sends both binary (protobuf-like) and JSON-encoded frames.
   * @param {string|ArrayBuffer|Blob} data
   */
  function handleWebSocketMessage(data) {
    if (data instanceof ArrayBuffer || data instanceof Blob) {
      // Binary frames — try to read as text in case of JSON-wrapped binary
      const reader = new FileReader();
      reader.onload = () => tryParseZoomFrame(reader.result);
      if (data instanceof Blob) {
        reader.readAsText(data);
      } else {
        reader.readAsText(new Blob([data]));
      }
      return;
    }

    if (typeof data === "string") {
      tryParseZoomFrame(data);
    }
  }

  /**
   * Try to extract Zoom event information from a raw frame (string or decoded binary).
   * Emits internal events when recognised patterns are found.
   * @param {string} raw
   */
  function tryParseZoomFrame(raw) {
    if (!raw || raw.length === 0) return;

    // Attempt JSON parse
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch (_) {
      // Not JSON – inspect as plain text heuristically
    }

    if (parsed) {
      processZoomJsonFrame(parsed);
      return;
    }

    // Heuristic: look for raised-hand keywords in text frames
    if (/raise.*hand|hand.*raise/i.test(raw)) {
      debug("WebSocket heuristic: raised-hand keyword detected in frame");
      // Cannot reliably extract participant details from binary – let DOM fallback handle it
    }
  }

  /**
   * Process a decoded JSON frame from the Zoom WebSocket.
   * Zoom's internal event schema is not public; this function handles several
   * observed shapes heuristically.
   * @param {object} frame
   */
  function processZoomJsonFrame(frame) {
    debug("WebSocket JSON frame:", JSON.stringify(frame).slice(0, 200));

    // Pattern 1: { evt: ..., body: { ... } }
    if (frame.evt !== undefined) {
      handleZoomEvt(frame.evt, frame.body || {});
      return;
    }

    // Pattern 2: { type: ..., data: { ... } }
    if (frame.type !== undefined) {
      handleZoomEvt(frame.type, frame.data || {});
      return;
    }

    // Pattern 3: array of events
    if (Array.isArray(frame)) {
      frame.forEach((item) => processZoomJsonFrame(item));
    }
  }

  /**
   * Map a Zoom internal event type to an internal ZoomHostTools event.
   * @param {string|number} evtType
   * @param {object} body
   */
  function handleZoomEvt(evtType, body) {
    const type = String(evtType).toLowerCase();

    // Raised hand – look for common Zoom event codes and field names
    const isRaisedHandEvent =
      type.includes("hand") ||
      type.includes("raise") ||
      body.bRaiseHand === true ||
      body.raise_hand === true ||
      body.handStatus === 1 ||
      body.hand_status === 1;

    if (isRaisedHandEvent) {
      const participantId =
        body.userId || body.user_id || body.id || body.participantId || null;
      const participantName =
        body.displayName ||
        body.display_name ||
        body.name ||
        body.userName ||
        body.user_name ||
        "Unknown";

      debug(`WebSocket: raised-hand detected for "${participantName}" (id: ${participantId})`);

      if (participantId || participantName !== "Unknown") {
        registry.upsert({ id: participantId, name: participantName });
        emitZoomEvent("participant_hand_raised", { participantId, participantName });
      }
      return;
    }

    // Participant join
    if (type.includes("join") || type.includes("add_user") || type.includes("add_attendee")) {
      const participantId = body.userId || body.user_id || body.id || null;
      const participantName =
        body.displayName || body.display_name || body.name || body.userName || "Unknown";
      if (participantId) {
        registry.upsert({ id: participantId, name: participantName });
        emitZoomEvent("participant_joined", { participantId, participantName });
      }
      return;
    }

    // Camera off
    if (
      type.includes("video") ||
      body.bVideoOn === false ||
      body.video_on === false ||
      body.videoStatus === 0
    ) {
      const participantId = body.userId || body.user_id || body.id || null;
      const participantName =
        body.displayName || body.display_name || body.name || body.userName || "Unknown";
      if (participantId) {
        registry.upsert({ id: participantId, name: participantName });
        emitZoomEvent("participant_camera_off", { participantId, participantName });
      }
      return;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // DOM FALLBACK DETECTION
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Scan the participant list DOM for raised-hand icons.
   * Called on a polling interval as a fallback when WebSocket detection does
   * not fire reliably.
   */
  function scanParticipants() {
    const rows = document.querySelectorAll(SELECTORS.participantRow);
    if (rows.length === 0) {
      debug("DOM scan: no participant rows found");
      return;
    }

    debug(`DOM scan: checking ${rows.length} participant row(s)`);

    rows.forEach((row) => {
      const handIcon = row.querySelector(SELECTORS.raisedHandIcon);
      if (!handIcon) return;

      const nameEl = row.querySelector(SELECTORS.participantName);
      if (!nameEl) {
        warn("DOM scan: raised-hand icon found but could not locate name element");
        return;
      }

      const participantName = (nameEl.textContent || nameEl.innerText || "").trim();
      if (!participantName) return;

      // Avoid emitting the same event repeatedly for the same participant
      if (registry.hasMultipin(participantName)) {
        debug(`DOM scan: "${participantName}" already has Multi-Pin, skipping`);
        return;
      }

      debug(`DOM scan: raised hand detected for "${participantName}"`);
      registry.upsert({ name: participantName });
      emitZoomEvent("participant_hand_raised", {
        participantId: null,
        participantName,
        source: "dom",
      });
    });
  }

  /**
   * Start the DOM fallback polling loop.
   * Returns the interval ID so the caller can stop it if needed.
   * @returns {number}
   */
  function startDomFallbackPolling() {
    info(`DOM fallback polling started (interval: ${POLL_INTERVAL_MS}ms)`);
    return setInterval(scanParticipants, POLL_INTERVAL_MS);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // UTILITY: ASYNC SLEEP
  // ─────────────────────────────────────────────────────────────────────────────

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // MULTIPIN ACTION EXECUTOR
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Grant Multi-Pin permission to the named participant.
   *
   * Steps:
   *   1. Locate the participant row in the participant panel
   *   2. Open their context menu ("More options")
   *   3. Click "Allow to Multi-Pin"
   *   4. Mark them as processed in the registry
   *
   * @param {string} participantName
   * @returns {Promise<boolean>} true on success, false on failure
   */
  async function grantMultipin(participantName) {
    info(`Attempting to grant Multi-Pin to "${participantName}"`);

    if (registry.hasMultipin(participantName)) {
      info(`"${participantName}" already has Multi-Pin – skipping`);
      return true;
    }

    // Ensure the participant panel is open
    await ensureParticipantPanelOpen();
    await sleep(ACTION_DELAY_MS);

    for (let attempt = 1; attempt <= MAX_MENU_RETRIES; attempt++) {
      debug(`grantMultipin: attempt ${attempt}/${MAX_MENU_RETRIES} for "${participantName}"`);

      const row = findParticipantRow(participantName);
      if (!row) {
        warn(`grantMultipin: participant row not found for "${participantName}" (attempt ${attempt})`);
        await sleep(ACTION_DELAY_MS);
        continue;
      }

      // Hover over the row so action buttons become visible
      row.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      row.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
      await sleep(ACTION_DELAY_MS / 2);

      // Find and click the "More options" / "..." button
      const menuButton =
        row.querySelector(SELECTORS.participantMenuButton) ||
        row.querySelector("[aria-label*='more']") ||
        row.querySelector("[aria-label*='More']");

      if (!menuButton) {
        warn(`grantMultipin: menu button not found for "${participantName}" (attempt ${attempt})`);
        await sleep(ACTION_DELAY_MS);
        continue;
      }

      menuButton.click();
      await sleep(ACTION_DELAY_MS);

      // Look for the Multi-Pin option in the newly-opened dropdown
      const multipinOption = findMultipinMenuOption();
      if (!multipinOption) {
        warn(`grantMultipin: Multi-Pin menu option not found (attempt ${attempt})`);
        // Close any open menu before retrying
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await sleep(ACTION_DELAY_MS);
        continue;
      }

      multipinOption.click();
      info(`Multi-Pin granted to "${participantName}"`);

      registry.markMultipin(participantName);

      // Phase 2 scaffold: check camera after granting Multi-Pin
      checkCameraStatus(participantName);

      return true;
    }

    error(`grantMultipin: failed to grant Multi-Pin to "${participantName}" after ${MAX_MENU_RETRIES} attempts`);
    return false;
  }

  /**
   * Find a participant row element by name.
   * @param {string} name
   * @returns {Element|null}
   */
  function findParticipantRow(name) {
    const rows = document.querySelectorAll(SELECTORS.participantRow);
    const nameLower = name.toLowerCase();

    for (const row of rows) {
      const nameEl = row.querySelector(SELECTORS.participantName);
      if (!nameEl) continue;
      const rowName = (nameEl.textContent || nameEl.innerText || "").trim().toLowerCase();
      if (rowName === nameLower || rowName.includes(nameLower)) {
        return row;
      }
    }
    debug(`findParticipantRow: no row found for "${name}"`);
    return null;
  }

  /**
   * Find the "Allow to Multi-Pin" menu option inside the currently-open dropdown.
   * @returns {Element|null}
   */
  function findMultipinMenuOption() {
    // Try the specific aria-label first
    const byLabel = document.querySelector("[aria-label='Allow to Multi-Pin']");
    if (byLabel) return byLabel;

    // Fall back to text content search across all visible menu items
    const items = document.querySelectorAll(
      ".dropdown-menu li, .menu-item, [role='menuitem'], [role='option']"
    );
    for (const item of items) {
      const text = (item.textContent || item.innerText || "").trim().toLowerCase();
      if (text.includes("multi-pin") || text.includes("multipin")) {
        return item;
      }
    }

    debug("findMultipinMenuOption: Multi-Pin option not found in current DOM");
    return null;
  }

  /**
   * Open the Participants panel if it is not already visible.
   */
  async function ensureParticipantPanelOpen() {
    const panel = document.querySelector(SELECTORS.participantListPanel);
    if (panel && isElementVisible(panel)) {
      debug("Participant panel already open");
      return;
    }

    const button = document.querySelector(SELECTORS.participantListButton);
    if (!button) {
      warn("ensureParticipantPanelOpen: could not find Participants button");
      return;
    }

    info("Opening Participants panel");
    button.click();
    await sleep(ACTION_DELAY_MS);
  }

  /**
   * Simple visibility check.
   * Uses getBoundingClientRect() to handle `position: fixed` elements
   * (which have offsetParent === null even when visible).
   * @param {Element} el
   * @returns {boolean}
   */
  function isElementVisible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // PHASE 2 SCAFFOLD: CAMERA CHECK
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Check whether a participant's camera is off after Multi-Pin is granted.
   * If the camera appears to be off, log the situation and prepare a warning.
   *
   * TODO: Implement actual chat message delivery once the correct chat API
   *       endpoint or DOM interaction is identified.  The function
   *       sendCameraWarning() below shows the intended flow.
   *
   * @param {string} participantName
   */
  function checkCameraStatus(participantName) {
    const row = findParticipantRow(participantName);
    if (!row) return;

    const cameraOffIcon = row.querySelector(SELECTORS.cameraStatusIcon);
    if (cameraOffIcon) {
      info(`Camera appears OFF for "${participantName}" after Multi-Pin grant`);

      if (!registry.cameraWarningSent.has(participantName.toLowerCase())) {
        // TODO: Call sendCameraWarning(participantName) once chat messaging is implemented.
        debug(`[PHASE 2 TODO] Would send camera-on warning to "${participantName}"`);
      }
    }
  }

  /**
   * Send a chat message asking a participant to enable their camera.
   *
   * TODO: Implement by locating the chat input, selecting the participant as
   *       the recipient, typing the message, and pressing Enter.  Example flow:
   *
   *   1. Open the chat panel.
   *   2. Find the recipient dropdown and select `participantName`.
   *   3. Focus the chat input (`SELECTORS.chatInput`).
   *   4. Type "Please turn your camera on to use Multi-Pin."
   *   5. Press Enter or click the send button.
   *   6. Call registry.cameraWarningSent.add(participantName.toLowerCase()).
   *
   * @param {string} _participantName  – unused until implementation is complete
   */
  // eslint-disable-next-line no-unused-vars
  function sendCameraWarning(_participantName) {
    // TODO: Implement chat message delivery (Phase 2)
    throw new Error("sendCameraWarning is not yet implemented");
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // PHASE 3 SCAFFOLD: CHAT SPAM DETECTION
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Patterns that indicate potential spam in chat messages.
   */
  const SPAM_PATTERNS = [
    /https?:\/\//i,
    /t\.me\//i,
    /bit\.ly\//i,
    /discord\.gg\//i,
  ];

  /**
   * Observe the chat panel for incoming messages and check them for spam patterns.
   *
   * Uses a MutationObserver so detection is near-real-time rather than polled.
   * The observer reference is stored on `state.chatObserver` so it can be
   * disconnected if needed.
   *
   * @param {number} [retryCount=0] — internal retry counter; stops after 10 attempts
   */
  function startChatSpamMonitor(retryCount = 0) {
    const MAX_CHAT_RETRIES = 10;
    const chatContainer = document.querySelector(SELECTORS.chatContainer);
    if (!chatContainer) {
      if (retryCount >= MAX_CHAT_RETRIES) {
        warn("Chat spam monitor: chat container never found, giving up after max retries");
        return;
      }
      debug(`Chat spam monitor: chat container not found, will retry (${retryCount + 1}/${MAX_CHAT_RETRIES})`);
      setTimeout(() => startChatSpamMonitor(retryCount + 1), 3000);
      return;
    }

    info("Chat spam monitor started");

    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType !== Node.ELEMENT_NODE) return;

          const msgEl =
            node.matches(SELECTORS.chatMessage)
              ? node
              : node.querySelector(SELECTORS.chatMessage);

          if (!msgEl) return;

          const text = (msgEl.textContent || msgEl.innerText || "").trim();
          const senderEl = msgEl.closest("[class*='chat-item']") || msgEl.parentElement;
          let sender = "Unknown";
          if (senderEl) {
            const senderNameEl = senderEl.querySelector("[class*='sender'], [class*='author'], [class*='name']");
            if (senderNameEl) {
              sender = (senderNameEl.textContent || "").trim() || "Unknown";
            }
          }

          checkChatMessage(sender, text);
        });
      });
    });

    observer.observe(chatContainer, { childList: true, subtree: true });
    // Store reference so the caller can disconnect if needed
    state.chatObserver = observer;
  }

  /**
   * Check a single chat message for spam and emit an event if detected.
   * @param {string} senderName
   * @param {string} messageText
   */
  function checkChatMessage(senderName, messageText) {
    const isSpam = SPAM_PATTERNS.some((pattern) => pattern.test(messageText));
    if (!isSpam) return;

    warn(`Chat spam detected from "${senderName}":`, messageText);
    emitZoomEvent("chat_message", { senderName, messageText, flagged: true });

    // TODO (Phase 3): Implement moderation actions.
    // Hooks are prepared below but not yet called:
    //   warnUser(senderName)
    //   moveToWaitingRoom(senderName)
    //   removeParticipant(senderName)
  }

  /**
   * Send a private warning message to a participant.
   * TODO: Implement via Zoom Web chat DOM interaction (Phase 3).
   * @param {string} _participantName
   */
  // eslint-disable-next-line no-unused-vars
  function warnUser(_participantName) {
    // TODO: Implement (Phase 3)
    throw new Error("warnUser is not yet implemented");
  }

  /**
   * Move a participant to the waiting room.
   * TODO: Locate the participant row, open their menu, and click the
   *       "Put in Waiting Room" option (Phase 3).
   * @param {string} _participantName
   */
  // eslint-disable-next-line no-unused-vars
  function moveToWaitingRoom(_participantName) {
    // TODO: Implement (Phase 3)
    throw new Error("moveToWaitingRoom is not yet implemented");
  }

  /**
   * Remove a participant from the meeting.
   * TODO: Locate the participant row, open their menu, and click the
   *       "Remove" option (Phase 3).
   * @param {string} _participantName
   */
  // eslint-disable-next-line no-unused-vars
  function removeParticipant(_participantName) {
    // TODO: Implement (Phase 3)
    throw new Error("removeParticipant is not yet implemented");
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // AUTOMATION LOGIC: WIRE EVENTS TO ACTIONS
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Register all event handlers that drive the automation workflow.
   */
  function registerAutomationHandlers() {
    // PRIMARY: grant Multi-Pin when a participant raises their hand
    onZoomEvent("participant_hand_raised", async ({ participantName }) => {
      info(`participant_hand_raised event received for "${participantName}"`);
      await grantMultipin(participantName);
    });

    // Log participant joins (no action required yet)
    onZoomEvent("participant_joined", ({ participantName }) => {
      debug(`Participant joined: "${participantName}"`);
    });

    // Log camera-off events (Phase 2 hook)
    onZoomEvent("participant_camera_off", ({ participantName }) => {
      debug(`Camera off: "${participantName}"`);
    });

    // Log flagged chat messages (Phase 3 hook)
    onZoomEvent("chat_message", ({ senderName, messageText, flagged }) => {
      if (flagged) {
        warn(`Flagged message from "${senderName}": ${messageText}`);
      }
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // INITIALISATION
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Bootstrap the automation once the page is sufficiently loaded.
   */
  function init() {
    info("Zoom Co-Host Multi-Pin Automation initialising…");

    // 1. Install WebSocket interceptor as early as possible
    installWebSocketInterceptor();

    // 2. Register automation event handlers
    registerAutomationHandlers();

    // 3. Start DOM fallback polling (acts as a safety net); store interval ID
    state.pollIntervalId = startDomFallbackPolling();

    // 4. Start chat spam monitor (deferred – chat panel may not exist yet)
    setTimeout(startChatSpamMonitor, 5000);

    info("Zoom Co-Host Multi-Pin Automation ready");
  }

  // Run init after the page has loaded enough for the Zoom app to start
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    // DOMContentLoaded already fired; schedule after a brief delay to allow
    // Zoom's React/Vue app to mount its initial components
    setTimeout(init, 1000);
  }
})();
