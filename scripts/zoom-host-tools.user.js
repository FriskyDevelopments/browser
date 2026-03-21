// ==UserScript==
// @name         HostPilot – Multi-Pin Auto-Grant
// @namespace    https://github.com/FriskyDevelopments/browser
// @version      1.0.0
// @description  Automatically grants Multi-Pin permission to participants who raise their hand in Zoom Web. Requires Host or Co-Host permissions.
// @author       FriskyDevelopments
// @match        https://*.zoom.us/wc/*
// @match        https://*.zoom.us/j/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ─────────────────────────────────────────────────────────────────────────────
  // CONFIG
  // Toggle DEBUG to see verbose console output in the browser console.
  // ─────────────────────────────────────────────────────────────────────────────
  const CONFIG = {
    DEBUG: true,               // Set false to silence non-critical logs
    SCAN_INTERVAL_MS: 2500,    // How often to scan for raised hands (ms)
    MENU_OPEN_WAIT_MS: 600,    // Time to wait after opening a participant menu (ms)
    MENU_CLICK_RETRIES: 3,     // Max retries when looking for the Multi-Pin menu item
    MENU_RETRY_WAIT_MS: 400,   // Wait between each retry (ms)
    SPAM_PATTERNS: [           // Phase 3 – chat link patterns to flag
      /https?:\/\//i,
      /t\.me\//i,
      /bit\.ly\//i,
      /discord\.gg\//i,
    ],
    ZOOM_READY_TIMEOUT_S: 60,  // Max seconds to wait for Zoom Web to be ready
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // STATE
  // ─────────────────────────────────────────────────────────────────────────────
  const STATE = {
    // Set of participant identifiers that have already been processed.
    // Prevents repeated Multi-Pin grants for the same participant.
    processedParticipants: new Set(),

    // Grant queue — ensures Multi-Pin grants are serialised to avoid menu race conditions.
    grantQueue: [],
    grantQueueRunning: false,

    // Debug panel counters (only used when debug panel is active)
    stats: {
      scans: 0,
      raisedHandsFound: 0,
      multipinGrantsAttempted: 0,
      lastAction: 'idle',
    },
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // LOGGING
  // ─────────────────────────────────────────────────────────────────────────────
  function log(level, ...args) {
    const prefix = '[HostPilot]';
    if (level === 'debug' && !CONFIG.DEBUG) return;
    const fn = level === 'warn' ? console.warn : level === 'error' ? console.error : console.log;
    fn(prefix, `[${level.toUpperCase()}]`, ...args);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SELECTOR RESOLUTION
  // This userscript embeds an inline selector map so it can run as a single file
  // without fetching external resources at runtime. To update selectors, edit
  // /selectors/zoom-dom-selectors.json in the repo (or another reference file)
  // and manually copy the relevant candidate arrays back into the map below.
  // ─────────────────────────────────────────────────────────────────────────────

  // Inline copy of the selector map used by this userscript.
  const SELECTORS = {
    participantListContainer: [
      "[data-testid='participant-list']",
      '.participants-section-container__participants',
      '.participants-section',
      "[aria-label='Participant list']",
      '.participants-ul',
    ],
    participantRow: [
      "[data-testid='participant-item']",
      '.participants-item',
      '.participant-item__container',
      'li.participants-item',
    ],
    raisedHandIndicator: [
      "[aria-label='Raise Hand']",
      "[aria-label='Hand raised']",
      '.participants-item__raise-hand',
      '.raise-hand-icon',
      "[data-testid='raise-hand-icon']",
      "svg[aria-label*='hand' i]",
      'span.hand-icon',
    ],
    participantName: [
      "[data-testid='participant-name']",
      '.participants-item__display-name',
      '.participant-item__display-name',
      '.participants-item__name',
      '.participant-name',
    ],
    participantMenuButton: [
      "[aria-label='More options for participant']",
      "[data-testid='participant-more-button']",
      '.participants-item__more-btn',
      "button[aria-label*='more' i]",
      "button[aria-label*='options' i]",
      '.participants-item__action-more',
    ],
    multiPinMenuItem: [
      "[aria-label='Allow to Multi-Pin']",
      "[data-testid='allow-multipin']",
    ],
    cameraStatusIndicator: [
      "[aria-label='Stop Video']",
      "[aria-label='Start Video']",
      "[data-testid='video-status-icon']",
      '.participants-item__video-status',
      '.video-icon--off',
      '.video-icon--on',
      "svg[aria-label*='video' i]",
    ],
    chatContainer: [
      "[data-testid='chat-message-list']",
      '.chat-message__container',
      '.chatbox-messages',
      '.chat-list',
      "[aria-label='Chat message list']",
    ],
    chatMessageRow: [
      "[data-testid='chat-message']",
      '.chat-message',
      '.chatbox-message-item',
      'li.chat-message',
    ],
    chatInput: [
      "[data-testid='chat-input']",
      "[aria-label='Type message here']",
      '.chat-box__chat-input',
      "div[contenteditable='true']",
      'textarea.chat-message-input',
    ],
    chatSendButton: [
      "[aria-label='Send chat message']",
      "[data-testid='chat-send-button']",
      'button.chat-box__send-btn',
      "button[aria-label*='send' i]",
    ],
    chatMessageSender: [
      "[data-testid='chat-message-sender']",
      '.chat-message__sender',
      '.chatbox-message-sender',
      'span.chat-message-author',
    ],
  };

  // Multi-Pin text keywords used as a last-resort fallback when attribute
  // selectors fail (Zoom may render menu items as plain text nodes).
  const MULTIPIN_TEXT_KEYWORDS = ['Allow to Multi-Pin', 'Multi-Pin', 'multipin'];

  /**
   * Resolves the first matching element from a candidates array.
   * Tries each selector in order; returns the first hit or null.
   *
   * @param {string[]} candidates  - Array of CSS selectors to try.
   * @param {Element|Document} root - DOM root to query against.
   * @returns {Element|null}
   */
  function resolveElement(candidates, root = document) {
    for (const selector of candidates) {
      try {
        const el = root.querySelector(selector);
        if (el) {
          log('debug', `Selector matched: "${selector}"`);
          return el;
        }
      } catch (err) {
        log('warn', `Selector error for "${selector}":`, err.message);
      }
    }
    return null;
  }

  /**
   * Resolves all matching elements from a candidates array.
   *
   * @param {string[]} candidates
   * @param {Element|Document} root
   * @returns {Element[]}
   */
  function resolveAllElements(candidates, root = document) {
    for (const selector of candidates) {
      try {
        const els = Array.from(root.querySelectorAll(selector));
        if (els.length > 0) {
          log('debug', `Selector matched ${els.length} element(s): "${selector}"`);
          return els;
        }
      } catch (err) {
        log('warn', `Selector error for "${selector}":`, err.message);
      }
    }
    return [];
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // PARTICIPANT IDENTITY
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Returns the most stable identifier available for a participant row element.
   * Priority: data-participant-id > data-id > display name > row fingerprint.
   *
   * @param {Element} row
   * @returns {string}
   */
  function getParticipantId(row) {
    // Prefer explicit ID attributes injected by Zoom
    const explicitId =
      row.dataset.participantId ||
      row.dataset.id ||
      row.getAttribute('data-participant-id') ||
      row.getAttribute('data-id');
    if (explicitId) return `id:${explicitId}`;

    // Fall back to display name + a structural fingerprint to avoid collisions
    const nameEl = resolveElement(SELECTORS.participantName, row);
    const name = nameEl ? nameEl.textContent.trim() : '';

    // Build a more unique fingerprint using DOM structure and sibling index
    const parent = row.parentElement;
    let index = -1;
    if (parent) {
      const siblings = Array.from(parent.children);
      index = siblings.indexOf(row);
    }
    const fingerprint = [
      row.tagName || '',
      row.className || '',
      String(row.children.length),
      index >= 0 ? String(index) : ''
    ].join('|');

    if (name) {
      const compositeId = `name:${name}|fp:${fingerprint}`;
      log('debug', 'Using composite participant identifier:', compositeId);
      return compositeId;
    }

    // Last resort: use structural fingerprint only
    const fpOnly = `fp:${fingerprint}`;
    log('warn', 'Could not find explicit participant ID or name; using DOM fingerprint:', fpOnly);
    return fpOnly;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // RAISED HAND DETECTION
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Returns true if the participant row currently shows a raised-hand indicator.
   *
   * Strategy:
   *   1. Try explicit selectors (aria-label, data-testid, class names)
   *   2. Fall back to aria-label / text content containing "hand"
   *
   * @param {Element} row
   * @returns {boolean}
   */
  function hasRaisedHand(row) {
    // Strategy 1 – direct selector match
    const bySelector = resolveElement(SELECTORS.raisedHandIndicator, row);
    if (bySelector) return true;

    // Strategy 2 – text/aria fallback
    const allDescendants = row.querySelectorAll('*');
    for (const el of allDescendants) {
      const label = (el.getAttribute('aria-label') || '').toLowerCase();
      const text = (el.textContent || '').toLowerCase().trim();
      if (label.includes('hand') || text.includes('✋') || label.includes('raise')) {
        log('debug', 'Raised hand detected via fallback traversal');
        return true;
      }
    }

    return false;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // MULTI-PIN STATUS DETECTION
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Attempts to determine whether a participant already has Multi-Pin enabled.
   *
   * Because Zoom does not expose a reliable "multipin granted" indicator in the
   * participant row, we rely on:
   *   1. The processed-participants set (STATE.processedParticipants) – most
   *      reliable guard against repeat grants.
   *   2. Checking the open participant menu for "Remove Multi-Pin" text, which
   *      would indicate the permission is already granted.
   *
   * This function only covers the in-memory state check (1).
   * The menu check (2) is done inside grantMultiPin() after the menu is open.
   *
   * @param {string} participantId
   * @returns {boolean}
   */
  function alreadyProcessed(participantId) {
    return STATE.processedParticipants.has(participantId);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // MULTI-PIN GRANTING
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Utility: returns a Promise that resolves after `ms` milliseconds.
   *
   * @param {number} ms
   * @returns {Promise<void>}
   */
  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Looks for the Multi-Pin menu item inside a currently-open participant menu.
   *
   * Strategy:
   *   1. Try explicit selectors / aria-label
   *   2. Iterate all [role=menuitem] elements and match text against keywords
   *
   * @returns {Element|null}
   */
  function findMultiPinMenuItem() {
    // Strategy 1 – attribute selectors
    const byAttr = resolveElement(SELECTORS.multiPinMenuItem);
    if (byAttr) return byAttr;

    // Strategy 2 – text match across all visible menu items
    const menuItems = document.querySelectorAll('[role="menuitem"], [role="option"], li.menu-item');
    for (const item of menuItems) {
      const text = item.textContent.trim();
      for (const keyword of MULTIPIN_TEXT_KEYWORDS) {
        if (text.toLowerCase().includes(keyword.toLowerCase())) {
          log('debug', `Multi-Pin menu item found via text match: "${text}"`);
          return item;
        }
      }
    }

    return null;
  }

  /**
   * Checks whether the open menu contains a "Remove Multi-Pin" entry, which
   * indicates that Multi-Pin has already been granted.
   *
   * @returns {boolean}
   */
  function menuShowsMultiPinAlreadyGranted() {
    const menuItems = document.querySelectorAll('[role="menuitem"], [role="option"], li.menu-item');
    const removeKeywords = ['Remove Multi-Pin', 'Revoke Multi-Pin', 'Disallow Multi-Pin'];
    for (const item of menuItems) {
      const text = item.textContent.trim();
      for (const keyword of removeKeywords) {
        if (text.toLowerCase().includes(keyword.toLowerCase())) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Attempts to hover over a participant row so that the menu button appears.
   * Zoom hides the "More" button until the row is hovered.
   *
   * @param {Element} row
   */
  function hoverRow(row) {
    // Dispatch both mouseover and mouseenter to maximise compatibility
    ['mouseover', 'mouseenter', 'mousemove'].forEach(type => {
      row.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
    });
  }

  /**
   * Adds a pending Multi-Pin grant to the serialised queue and starts the
   * drain loop if it is not already running.
   *
   * @param {Element} row           - Participant row element
   * @param {string}  participantId - Stable participant identifier
   */
  function enqueueGrant(row, participantId) {
    STATE.grantQueue.push({ row, participantId });
    log('debug', `Queued grant for ${participantId} (queue length: ${STATE.grantQueue.length})`);
    if (!STATE.grantQueueRunning) {
      drainGrantQueue();
    }
  }

  /**
   * Drains the grant queue one entry at a time so that only a single
   * grantMultiPin() call is ever in-flight at once.
   * This prevents concurrent menu interactions from racing against each other
   * on the single shared participant-action UI surface.
   */
  async function drainGrantQueue() {
    // JavaScript is single-threaded: the guard check and flag assignment below
    // execute synchronously before the first await, so no two calls can both
    // pass the check simultaneously — this is not a TOCTOU race in JS.
    if (STATE.grantQueueRunning) return;
    STATE.grantQueueRunning = true;
    log('debug', 'Grant queue drain started.');
    while (STATE.grantQueue.length > 0) {
      const { row, participantId } = STATE.grantQueue.shift();
      try {
        await grantMultiPin(row, participantId);
      } catch (err) {
        log('error', `Unexpected error while granting Multi-Pin for ${participantId}:`, err);
      }
    }
    STATE.grantQueueRunning = false;
    log('debug', 'Grant queue drain complete.');
  }

  /**
   * Core function: opens the participant action menu and clicks "Allow to
   * Multi-Pin". Records the participant in STATE.processedParticipants on
   * success to prevent future reprocessing.
   *
   * @param {Element} row          - Participant row element
   * @param {string}  participantId - Stable participant identifier
   * @returns {Promise<void>}
   */
  async function grantMultiPin(row, participantId) {
    log('info', `Granting multipin for participant: ${participantId}`);
    STATE.stats.lastAction = `Granting multipin: ${participantId}`;
    STATE.stats.multipinGrantsAttempted++;
    updateDebugPanel();

    // Step 1: hover row to reveal the menu button
    hoverRow(row);
    await sleep(200);

    // Step 2: find and click the menu button
    const menuBtn = resolveElement(SELECTORS.participantMenuButton, row);
    if (!menuBtn) {
      log('warn', `Failed to find menu button for participant: ${participantId}`);
      STATE.stats.lastAction = `Menu button not found: ${participantId}`;
      updateDebugPanel();
      return;
    }
    menuBtn.click();
    await sleep(CONFIG.MENU_OPEN_WAIT_MS);

    // Step 3: check if Multi-Pin is already granted (menu-level check)
    if (menuShowsMultiPinAlreadyGranted()) {
      log('info', `Participant already has multipin (menu check): ${participantId}`);
      STATE.processedParticipants.add(participantId);
      STATE.stats.lastAction = `Already has multipin: ${participantId}`;
      closeOpenMenu();
      updateDebugPanel();
      return;
    }

    // Step 4: retry loop — find the Multi-Pin menu item
    let menuItem = null;
    for (let attempt = 1; attempt <= CONFIG.MENU_CLICK_RETRIES; attempt++) {
      menuItem = findMultiPinMenuItem();
      if (menuItem) break;
      log('debug', `Multi-Pin menu item not found (attempt ${attempt}/${CONFIG.MENU_CLICK_RETRIES}); retrying…`);
      await sleep(CONFIG.MENU_RETRY_WAIT_MS);
    }

    if (!menuItem) {
      log('warn', `Failed to find Multi-Pin menu item for participant: ${participantId}`);
      STATE.stats.lastAction = `Menu item not found: ${participantId}`;
      updateDebugPanel();
      closeOpenMenu();
      return;
    }

    // Step 5: click the menu item
    menuItem.click();
    log('info', `Multi-Pin granted successfully for participant: ${participantId}`);
    STATE.processedParticipants.add(participantId);
    STATE.stats.lastAction = `Multipin granted: ${participantId}`;
    updateDebugPanel();

    // Step 6: Phase 2 scaffold — check camera status after granting
    await sleep(300);
    checkCameraStatus(row, participantId);
  }

  /**
   * Closes any currently open participant menu by pressing Escape.
   * This is a safe fallback that should not harm the page.
   */
  function closeOpenMenu() {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // CAMERA STATUS CHECK (Phase 2 – scaffold)
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Attempts to detect whether a participant's camera is currently on or off.
   * Camera state in Zoom Web is difficult to detect reliably; this function
   * uses best-effort DOM inspection and falls back gracefully.
   *
   * TODO (Phase 2): If camera is off, send the participant a one-time chat
   *   message: "Please turn your camera on to use Multi-Pin."
   *
   * @param {Element} row          - Participant row element
   * @param {string}  participantId - Stable participant identifier
   */
  function checkCameraStatus(row, participantId) {
    const cameraEl = resolveElement(SELECTORS.cameraStatusIndicator, row);

    if (!cameraEl) {
      log('debug', `Camera status: unable to detect for participant ${participantId}. Selector mismatch or element not present.`);
      // TODO (Phase 2): implement alternative camera detection strategies
      return;
    }

    const label = (cameraEl.getAttribute('aria-label') || '').toLowerCase();
    const classList = Array.from(cameraEl.classList).join(' ').toLowerCase();

    // "Start Video" aria-label → camera is currently OFF
    const cameraOff =
      label.includes('start video') ||
      classList.includes('video-icon--off') ||
      classList.includes('video-off');

    if (cameraOff) {
      log('info', `Camera is OFF for participant: ${participantId}`);
      // TODO (Phase 2): call sendCameraOnRequest(participantId) here
    } else {
      log('info', `Camera appears ON for participant: ${participantId}`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // PARTICIPANT SCANNING
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Locates the participant list container in the DOM.
   * Logs a warning and returns null if not found (e.g. panel is closed).
   *
   * @returns {Element|null}
   */
  function getParticipantListContainer() {
    const container = resolveElement(SELECTORS.participantListContainer);
    if (!container) {
      log('debug', 'Participant list container not found — panel may be closed or selectors need updating.');
    }
    return container;
  }

  /**
   * Scans all participant rows and grants Multi-Pin to any participant who has
   * their hand raised and has not already been processed.
   *
   * @returns {Promise<void>}
   */
  async function scanParticipants() {
    STATE.stats.scans++;
    updateDebugPanel();

    const container = getParticipantListContainer();
    if (!container) return;

    const rows = resolveAllElements(SELECTORS.participantRow, container);
    if (rows.length === 0) {
      log('debug', 'No participant rows found.');
      return;
    }

    log('debug', `Scanning ${rows.length} participant row(s)…`);

    for (const row of rows) {
      if (!hasRaisedHand(row)) continue;

      STATE.stats.raisedHandsFound++;
      updateDebugPanel();

      const participantId = getParticipantId(row);
      log('info', `Detected raised hand: ${participantId}`);

      if (alreadyProcessed(participantId)) {
        log('debug', `Participant already processed, skipping: ${participantId}`);
        continue;
      }

      // Enqueue the grant so that Multi-Pin actions are serialised one at a
      // time, preventing concurrent menu interactions from racing each other.
      enqueueGrant(row, participantId);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // CHAT MONITORING (Phase 3 – scaffold)
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Checks a chat message string against configured spam patterns.
   * Logs any match; no punitive action is taken yet.
   *
   * TODO (Phase 3): Add moderation hooks here (e.g. remove message, warn user,
   *   auto-mute, notify host via chat).
   *
   * @param {string} text    - Message text content
   * @param {string} sender  - Sender display name (if available)
   */
  function checkMessageForSpam(text, sender) {
    for (const pattern of CONFIG.SPAM_PATTERNS) {
      if (pattern.test(text)) {
        log('warn', `Potential spam detected from "${sender}": ${text}`);
        // TODO (Phase 3): trigger moderation action
        return;
      }
    }
  }

  /**
   * Attaches a MutationObserver to the chat container to monitor new messages.
   * Safe to call even when the chat panel is not yet visible; it will retry
   * until the container appears.
   */
  function startChatMonitor() {
    const tryAttach = () => {
      const container = resolveElement(SELECTORS.chatContainer);
      if (!container) {
        log('debug', 'Chat container not found; will retry when it appears.');
        return false;
      }

      log('info', 'Attaching chat MutationObserver.');
      const observer = new MutationObserver(mutations => {
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) {
            if (node.nodeType !== Node.ELEMENT_NODE) continue;
            // Determine whether this node is a chat message row
            const isMessageRow = SELECTORS.chatMessageRow.some(sel => {
              try { return node.matches(sel); } catch { return false; }
            });
            if (!isMessageRow) continue;

            const text = node.textContent || '';
            // Use the centralised SELECTORS.chatMessageSender candidates
            const senderEl = resolveElement(SELECTORS.chatMessageSender, node);
            const sender = senderEl ? senderEl.textContent.trim() : 'unknown';
            checkMessageForSpam(text, sender);
          }
        }
      });

      observer.observe(container, { childList: true, subtree: true });
      return true;
    };

    if (!tryAttach()) {
      // Poll until the chat container appears (it may not be open yet)
      const interval = setInterval(() => {
        if (tryAttach()) clearInterval(interval);
      }, 3000);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // DEBUG PANEL (optional UI)
  // ─────────────────────────────────────────────────────────────────────────────

  let debugPanel = null;

  /**
   * Creates a small floating debug panel in the bottom-right corner of the page.
   * Only created when CONFIG.DEBUG is true.
   * The panel is built entirely with DOM APIs — no innerHTML — to prevent any
   * risk of HTML injection. STATE.stats.lastAction (and any future stat field)
   * may contain participant display names taken verbatim from the Zoom DOM;
   * those strings are treated as plain text by textContent and never parsed as
   * markup.
   */
  function createDebugPanel() {
    if (!CONFIG.DEBUG) return;

    const panel = document.createElement('div');
    panel.id = 'hostpilot-debug';

    // Inline styles — self-contained, no external stylesheet needed
    Object.assign(panel.style, {
      position: 'fixed',
      bottom: '20px',
      right: '20px',
      zIndex: '999999',
      background: 'linear-gradient(135deg, #0f0f1a 0%, #1a1a2e 100%)',
      color: '#c8d6e5',
      fontFamily: "'Segoe UI', system-ui, sans-serif",
      fontSize: '12px',
      padding: '0',
      borderRadius: '10px',
      minWidth: '240px',
      boxShadow: '0 4px 20px rgba(0,0,0,0.55), 0 0 0 1px rgba(110,86,207,0.45)',
      pointerEvents: 'none',
      overflow: 'hidden',
    });

    // ── Header bar ──
    const header = document.createElement('div');
    Object.assign(header.style, {
      display: 'flex',
      alignItems: 'center',
      gap: '7px',
      padding: '8px 12px',
      background: 'rgba(110,86,207,0.22)',
      borderBottom: '1px solid rgba(110,86,207,0.35)',
    });

    const logo = document.createElement('span');
    logo.textContent = '⚡';
    logo.style.fontSize = '14px';

    const title = document.createElement('span');
    title.textContent = 'HostPilot';
    Object.assign(title.style, {
      fontWeight: '700',
      fontSize: '13px',
      letterSpacing: '0.3px',
      color: '#a78bfa',
    });

    const badge = document.createElement('span');
    badge.textContent = 'LIVE';
    Object.assign(badge.style, {
      marginLeft: 'auto',
      fontSize: '9px',
      fontWeight: '700',
      letterSpacing: '0.8px',
      color: '#4ade80',
      background: 'rgba(74,222,128,0.12)',
      border: '1px solid rgba(74,222,128,0.35)',
      borderRadius: '4px',
      padding: '1px 5px',
    });

    header.appendChild(logo);
    header.appendChild(title);
    header.appendChild(badge);

    // ── Stats body ──
    const body = document.createElement('div');
    body.id = 'hostpilot-debug-body';
    Object.assign(body.style, {
      padding: '8px 12px 10px',
      lineHeight: '1.8',
    });

    panel.appendChild(header);
    panel.appendChild(body);
    document.body.appendChild(panel);
    debugPanel = panel;
    log('info', 'Debug panel created.');
  }

  /**
   * Refreshes the debug panel content with current stats.
   * Each stat row is built with textContent — never innerHTML — so values that
   * include participant display names (e.g. lastAction = "Multipin granted: Alice<script>…")
   * are rendered as literal text and cannot inject markup or execute scripts.
   */
  function updateDebugPanel() {
    if (!debugPanel) return;

    const body = debugPanel.querySelector('#hostpilot-debug-body');
    if (!body) return;

    // Clear previous rows safely
    while (body.firstChild) body.removeChild(body.firstChild);

    const s = STATE.stats;
    const rows = [
      ['🔍 Scans', String(s.scans)],
      ['✋ Raised hands', String(s.raisedHandsFound)],
      ['📌 Grants', String(s.multipinGrantsAttempted)],
      ['⚡ Last action', s.lastAction],
    ];

    for (const [label, value] of rows) {
      const row = document.createElement('div');
      Object.assign(row.style, {
        display: 'flex',
        justifyContent: 'space-between',
        gap: '8px',
        fontSize: '12px',
      });

      const labelEl = document.createElement('span');
      labelEl.textContent = label;
      labelEl.style.color = '#94a3b8';

      const valueEl = document.createElement('span');
      // textContent assignment is safe — any HTML in the value is treated as plain text
      valueEl.textContent = value;
      Object.assign(valueEl.style, {
        color: '#e2e8f0',
        fontWeight: '600',
        textAlign: 'right',
        maxWidth: '150px',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      });

      row.appendChild(labelEl);
      row.appendChild(valueEl);
      body.appendChild(row);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // MAIN LOOP
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Main polling loop. Scans participants every SCAN_INTERVAL_MS milliseconds.
   * Also starts the chat monitor.
   */
  function startMainLoop() {
    log('info', 'HostPilot started. Scan interval:', CONFIG.SCAN_INTERVAL_MS, 'ms');
    createDebugPanel();
    startChatMonitor();

    // Initial scan immediately
    scanParticipants();

    // Then scan on a regular interval
    setInterval(() => {
      scanParticipants().catch(err => {
        log('error', 'Error during participant scan:', err);
      });
    }, CONFIG.SCAN_INTERVAL_MS);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // ENTRY POINT
  // Wait for the page to be sufficiently ready before starting.
  // Zoom is a heavy SPA; the DOM we need won't exist at document-idle for
  // the very first load, so we wait for the first meaningful participant list
  // appearance using a short poll.
  // ─────────────────────────────────────────────────────────────────────────────
  function waitForZoomReady() {
    log('info', 'Waiting for Zoom Web to be ready…');
    const maxWait = CONFIG.ZOOM_READY_TIMEOUT_S; // seconds
    let elapsed = 0;

    const check = setInterval(() => {
      elapsed++;
      // Consider Zoom "ready" when either the participant list OR the meeting
      // toolbar appears. These are reliable indicators that the meeting has
      // loaded.
      const participantListPresent = !!resolveElement(SELECTORS.participantListContainer);
      const toolbarPresent = !!document.querySelector(
        '[data-testid="meeting-toolbar"], .meeting-toolbar, .footer-toolbar'
      );

      if (participantListPresent || toolbarPresent) {
        clearInterval(check);
        log('info', 'Zoom Web ready. Starting automation.');
        startMainLoop();
      } else if (elapsed >= maxWait) {
        clearInterval(check);
        log('warn', 'Zoom Web did not become ready within timeout. Starting anyway.');
        startMainLoop();
      }
    }, 1000);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // COMMONJS EXPORT (unit-test harness only)
  // In the browser (Tampermonkey) `module` is undefined, so the else branch runs
  // and the script starts normally. In Node.js / Jest, pure-logic helpers are
  // exported so tests can import them without starting the polling loop.
  // ─────────────────────────────────────────────────────────────────────────────
  /* istanbul ignore else */
  if (typeof module !== 'undefined') {
    module.exports = {
      CONFIG,
      STATE,
      log,
      resolveElement,
      resolveAllElements,
      getParticipantId,
      hasRaisedHand,
      alreadyProcessed,
      checkMessageForSpam,
      menuShowsMultiPinAlreadyGranted,
      findMultiPinMenuItem,
      enqueueGrant,
      drainGrantQueue,
      sleep,
      hoverRow,
      closeOpenMenu,
    };
  } else {
    // Kick off
    waitForZoomReady();
  }
})();
