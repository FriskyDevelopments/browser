// ==UserScript==
// @name         Zoom Host Automation
// @namespace    https://github.com/FriskyDevelopments/browser
// @version      1.0.0
// @description  Automates host tasks in the Zoom Web client: grants multi-pin on raised hand, prompts camera-off participants, and moderates chat for links/spam.
// @author       FriskyDevelopments
// @match        https://app.zoom.us/wc/*
// @match        https://*.zoom.us/wc/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Configuration — edit these values to tune behaviour
  // ---------------------------------------------------------------------------
  const CONFIG = {
    // How often (ms) to poll for raised hands and camera status
    pollIntervalMs: 2000,

    // How often (ms) to poll the chat window for new messages
    chatPollIntervalMs: 3000,

    // Words/patterns that trigger chat moderation (Phase 3).
    // Uses whole-word boundaries (\b) to reduce false positives.
    spamWords: ['buy now', 'click here', 'free money', 'earn cash', 'discount code'],

    // URL pattern used to detect links in chat messages
    linkPattern: /https?:\/\/\S+/i,

    // Number of warnings before escalating to waiting-room action
    warnBeforeEscalate: 2,

    // Maximum characters shown when logging a chat message snippet
    logMessageMaxLength: 80,

    // Maximum ms to wait for the meeting UI before giving up on bootstrap
    bootstrapTimeoutMs: 60000,

    // Enable / disable each phase independently
    phases: {
      raisedHand: true,   // Phase 1
      cameraCheck: true,  // Phase 2
      chatMod: true,      // Phase 3
    },
  };

  // ---------------------------------------------------------------------------
  // Stable DOM selector helpers
  //
  // Zoom's web client renders inside a deeply nested shadow DOM / React tree.
  // The selectors below rely on stable aria-labels and data attributes that
  // change far less often than class names.  A thin helper layer means only
  // this section needs updating when Zoom tweaks their markup.
  // ---------------------------------------------------------------------------
  const SELECTORS = {
    // Participant list panel
    participantPanel: '[aria-label="Participants"]',

    // Individual participant rows inside the panel
    participantRow: '[role="listitem"]',

    // "Raised hand" indicator inside a participant row
    raisedHandIcon: '[aria-label*="raised hand"], [data-icon="hand-raise"], .hand-raise-icon',

    // Participant display name inside a row
    participantName: '[class*="participant-name"], [class*="attendee-name"], .participants-item__name',

    // "More options" / context menu button inside a participant row
    moreOptionsBtn: '[aria-label*="More"], [aria-label*="options"], button[class*="more"]',

    // Menu items inside the context/dropdown menu
    contextMenuItem: '[role="menuitem"]',

    // Camera-off indicator inside a participant row
    cameraOffIcon: '[aria-label*="video off"], [aria-label*="camera off"], [data-icon="video-off"], .video-off-icon',

    // Chat panel container
    chatPanel: '[aria-label="Chat"], .chat-container',

    // Individual chat message elements
    chatMessage: '[class*="chat-message"], [role="listitem"][class*="message"]',

    // Sender name inside a chat message
    chatSender: '[class*="chat-message__sender"], [class*="message-sender"]',

    // Message text content inside a chat message
    chatText: '[class*="chat-message__text"], [class*="message-content"]',

    // "Send a message" input inside the chat panel
    chatInput: '[aria-label*="Type message"], [placeholder*="message"]',
  };

  // ---------------------------------------------------------------------------
  // State tracking
  // ---------------------------------------------------------------------------

  /** Set of participant names that have already been multi-pinned this session. */
  const pinnedParticipants = new Set();

  /** Set of participant names that have already been prompted about their camera. */
  const cameraMsgSent = new Set();

  /**
   * Map of participantName → { warnings: number, escalated: boolean }
   * Used by Phase 3 to track repeat offenders.
   */
  const chatOffenders = new Map();

  /**
   * Set of already-seen chat message DOM nodes so we don't re-process them.
   * A WeakSet is used (rather than Set) so that DOM nodes are automatically
   * garbage-collected once they are removed from the page by Zoom's virtual
   * list renderer, preventing a memory leak over long meetings.
   */
  const seenChatMessages = new WeakSet();

  // ---------------------------------------------------------------------------
  // Utility helpers
  // ---------------------------------------------------------------------------

  /**
   * Find the first element matching `selector` inside an optional `root`.
   * Returns null instead of throwing when nothing is found.
   *
   * @param {string} selector
   * @param {Element|Document} [root=document]
   * @returns {Element|null}
   */
  function $(selector, root = document) {
    try {
      return root.querySelector(selector);
    } catch {
      return null;
    }
  }

  /**
   * Find all elements matching `selector` inside an optional `root`.
   *
   * @param {string} selector
   * @param {Element|Document} [root=document]
   * @returns {Element[]}
   */
  function $$(selector, root = document) {
    try {
      return Array.from(root.querySelectorAll(selector));
    } catch {
      return [];
    }
  }

  /**
   * Click an element and return whether the click succeeded.
   *
   * @param {Element|null} el
   * @returns {boolean}
   */
  function safeClick(el) {
    if (!el) return false;
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return true;
  }

  /**
   * Wait for an element matching `selector` to appear in the DOM (up to
   * `timeoutMs` milliseconds), then resolve with the element.
   *
   * @param {string} selector
   * @param {number} [timeoutMs=3000]
   * @param {Element|Document} [root=document]
   * @returns {Promise<Element|null>}
   */
  function waitForElement(selector, timeoutMs = 3000, root = document) {
    return new Promise((resolve) => {
      const existing = $(selector, root);
      if (existing) return resolve(existing);

      // `settled` prevents a race where the timeout fires while the observer
      // callback is still executing.
      let settled = false;

      const observer = new MutationObserver(() => {
        if (settled) return;
        const el = $(selector, root);
        if (el) {
          settled = true;
          observer.disconnect();
          resolve(el);
        }
      });
      observer.observe(root === document ? document.body : root, {
        childList: true,
        subtree: true,
      });

      setTimeout(() => {
        if (settled) return;
        settled = true;
        observer.disconnect();
        resolve(null);
      }, timeoutMs);
    });
  }

  /**
   * Return the trimmed display name for a participant row element.
   *
   * @param {Element} row
   * @returns {string}
   */
  function getParticipantName(row) {
    const nameEl = $(SELECTORS.participantName, row);
    return nameEl ? nameEl.textContent.trim() : '';
  }

  /**
   * Log a message to the browser console with a consistent prefix.
   *
   * @param {...any} args
   */
  function log(...args) {
    console.log('[ZoomHostBot]', ...args);
  }

  // ---------------------------------------------------------------------------
  // Phase 1 — Raised-hand detection → multi-pin
  // ---------------------------------------------------------------------------

  /**
   * Open the context menu for a participant row and click a menu item whose
   * text content matches `actionText` (case-insensitive).
   *
   * @param {Element} row          Participant list row element
   * @param {string}  actionText   Substring to match in the menu item label
   * @returns {Promise<boolean>}   Resolves to true if the action was clicked
   */
  async function clickParticipantMenuAction(row, actionText) {
    const moreBtn = $(SELECTORS.moreOptionsBtn, row);
    if (!safeClick(moreBtn)) {
      log('Could not find "More options" button for row', row);
      return false;
    }

    // Wait for the context menu to appear
    const menu = await waitForElement(SELECTORS.contextMenuItem, 2000);
    if (!menu) {
      log('Context menu did not appear');
      return false;
    }

    const lowerAction = actionText.toLowerCase();
    const items = $$(SELECTORS.contextMenuItem);
    const target = items.find((i) => i.textContent.toLowerCase().includes(lowerAction));

    if (!safeClick(target)) {
      log(`Menu item "${actionText}" not found`);
      // Close the menu by pressing Escape
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return false;
    }

    return true;
  }

  /**
   * Phase 1 tick: scan participant rows for raised-hand indicators and grant
   * multi-pin to any that don't have it yet.
   */
  async function phaseOneRaisedHand() {
    const rows = $$(SELECTORS.participantRow);
    for (const row of rows) {
      const handIcon = $(SELECTORS.raisedHandIcon, row);
      if (!handIcon) continue;

      const name = getParticipantName(row);
      if (!name || pinnedParticipants.has(name)) continue;

      log(`Phase 1: "${name}" has their hand raised — granting multi-pin`);
      const granted = await clickParticipantMenuAction(row, 'multi-pin');
      if (granted) {
        pinnedParticipants.add(name);
        log(`Phase 1: Multi-pin granted to "${name}"`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Phase 2 — Camera-off check → chat prompt
  // ---------------------------------------------------------------------------

  /**
   * Send a direct / private chat message to a participant by their display
   * name.  Falls back to sending a public message mentioning the name if the
   * private-message flow isn't available.
   *
   * @param {string} toName    Recipient's display name
   * @param {string} message   Text to send
   * @returns {Promise<void>}
   */
  async function sendChatMessage(toName, message) {
    const chatPanel = $(SELECTORS.chatPanel);
    if (!chatPanel) {
      log('Chat panel not found — cannot send message to', toName);
      return;
    }

    const input = $(SELECTORS.chatInput, chatPanel);
    if (!input) {
      log('Chat input not found');
      return;
    }

    // Focus the input and set the value.
    // Zoom's web client is a React app, so we must use the native input setter
    // to properly trigger React's synthetic onChange handler, then also fire
    // both 'input' and 'change' events so the framework updates its state.
    input.focus();
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
      || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
    if (nativeSetter && nativeSetter.set) {
      nativeSetter.set.call(input, message);
    } else {
      input.value = message;
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));

    // Submit by pressing Enter
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
    log(`Phase 2: Sent chat message to "${toName}"`);
  }

  /**
   * Phase 2 tick: for each participant that was recently multi-pinned, check
   * if their camera is off and, if so, send them a polite reminder.
   */
  async function phaseTwoCameraCheck() {
    if (pinnedParticipants.size === 0) return;

    const rows = $$(SELECTORS.participantRow);
    for (const row of rows) {
      const name = getParticipantName(row);
      if (!name || !pinnedParticipants.has(name)) continue;
      if (cameraMsgSent.has(name)) continue;

      const cameraOff = $(SELECTORS.cameraOffIcon, row);
      if (!cameraOff) continue;

      log(`Phase 2: "${name}" has their camera off — sending reminder`);
      await sendChatMessage(
        name,
        `Hi ${name}, could you please turn your camera on? Thank you! 📷`
      );
      cameraMsgSent.add(name);
    }
  }

  // ---------------------------------------------------------------------------
  // Phase 3 — Chat moderation
  // ---------------------------------------------------------------------------

  /**
   * Determine whether a chat message text should trigger moderation.
   * Uses word-boundary matching (\b) around multi-word phrases to reduce
   * false positives from innocent sentences.
   *
   * @param {string} text   Raw message text
   * @returns {boolean}
   */
  function hasProhibitedContent(text) {
    if (CONFIG.linkPattern.test(text)) return true;
    const lower = text.toLowerCase();
    return CONFIG.spamWords.some((phrase) => {
      // Build a word-boundary regex; escape any regex special chars first
      const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`\\b${escaped}\\b`).test(lower);
    });
  }

  /**
   * Apply a graduated moderation action for the given participant.
   *
   * - 1st offence: send a public warning in chat
   * - 2nd offence: move to waiting room (via participant menu)
   * - 3rd+ offence: remove from meeting
   *
   * @param {string} senderName   Display name of the offending participant
   * @returns {Promise<void>}
   */
  async function moderateParticipant(senderName) {
    const state = chatOffenders.get(senderName) || { warnings: 0, escalated: false };
    state.warnings += 1;
    chatOffenders.set(senderName, state);

    if (state.warnings <= CONFIG.warnBeforeEscalate) {
      // Issue a warning in the chat
      log(`Phase 3: Warning ${state.warnings}/${CONFIG.warnBeforeEscalate} issued to "${senderName}"`);
      await sendChatMessage(
        senderName,
        `⚠️ ${senderName}, please refrain from posting links or promotional content. Further violations may result in removal.`
      );
    } else if (state.warnings === CONFIG.warnBeforeEscalate + 1) {
      // Move to waiting room
      log(`Phase 3: Moving "${senderName}" to waiting room`);
      const row = findParticipantRow(senderName);
      if (row) await clickParticipantMenuAction(row, 'waiting room');
    } else {
      // Remove from the meeting
      log(`Phase 3: Removing "${senderName}" from the meeting`);
      const row = findParticipantRow(senderName);
      if (row) await clickParticipantMenuAction(row, 'remove');
    }
  }

  /**
   * Locate the participant list row for a given display name.
   *
   * @param {string} name
   * @returns {Element|null}
   */
  function findParticipantRow(name) {
    const rows = $$(SELECTORS.participantRow);
    return rows.find((row) => getParticipantName(row) === name) || null;
  }

  /**
   * Phase 3 tick: scan newly added chat messages, detect links/spam, and
   * apply moderation.
   */
  async function phaseThreeChatMod() {
    const messages = $$(SELECTORS.chatMessage);
    for (const msgEl of messages) {
      if (seenChatMessages.has(msgEl)) continue;
      seenChatMessages.add(msgEl);

      const senderEl = $(SELECTORS.chatSender, msgEl);
      const textEl = $(SELECTORS.chatText, msgEl);
      if (!senderEl || !textEl) continue;

      const sender = senderEl.textContent.trim();
      const text = textEl.textContent.trim();

      if (hasProhibitedContent(text)) {
        log(`Phase 3: Potential spam/link from "${sender}": "${text.substring(0, CONFIG.logMessageMaxLength)}…"`);
        await moderateParticipant(sender);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Main loop — kick off each enabled phase on its own poll interval
  // ---------------------------------------------------------------------------

  /**
   * Guard wrapper: run an async phase function, swallowing any errors so a
   * crash in one phase doesn't kill the others.
   *
   * @param {string}    phaseName
   * @param {Function}  fn
   */
  async function runPhase(phaseName, fn) {
    try {
      await fn();
    } catch (err) {
      log(`Error in ${phaseName}:`, err);
    }
  }

  function startPolling() {
    // Use a recursive setTimeout pattern instead of setInterval so that the
    // next iteration only starts after the current one fully completes.  This
    // prevents overlapping executions when a phase takes longer than the interval.

    if (CONFIG.phases.raisedHand || CONFIG.phases.cameraCheck) {
      const scheduleParticipantCheck = async () => {
        if (CONFIG.phases.raisedHand) await runPhase('Phase 1 (raisedHand)', phaseOneRaisedHand);
        if (CONFIG.phases.cameraCheck) await runPhase('Phase 2 (cameraCheck)', phaseTwoCameraCheck);
        setTimeout(scheduleParticipantCheck, CONFIG.pollIntervalMs);
      };
      setTimeout(scheduleParticipantCheck, CONFIG.pollIntervalMs);
    }

    if (CONFIG.phases.chatMod) {
      const scheduleChatCheck = async () => {
        await runPhase('Phase 3 (chatMod)', phaseThreeChatMod);
        setTimeout(scheduleChatCheck, CONFIG.chatPollIntervalMs);
      };
      setTimeout(scheduleChatCheck, CONFIG.chatPollIntervalMs);
    }

    log('Zoom Host Automation started. Active phases:', CONFIG.phases);
  }

  // ---------------------------------------------------------------------------
  // Bootstrap — wait until the meeting UI is ready before starting
  // ---------------------------------------------------------------------------

  /**
   * Return true once the basic Zoom meeting UI elements are present in the DOM.
   *
   * @returns {boolean}
   */
  function isMeetingReady() {
    return !!($(SELECTORS.participantPanel) || $$(SELECTORS.participantRow).length > 0);
  }

  function bootstrap() {
    if (isMeetingReady()) {
      startPolling();
      return;
    }

    // Meeting UI not ready yet — observe the document until it appears.
    // A hard timeout (CONFIG.bootstrapTimeoutMs) prevents the observer from
    // running indefinitely if the meeting UI never loads.
    let started = false;

    const observer = new MutationObserver(() => {
      if (started || !isMeetingReady()) return;
      started = true;
      observer.disconnect();
      startPolling();
    });
    observer.observe(document.body, { childList: true, subtree: true });

    setTimeout(() => {
      if (started) return;
      started = true;
      observer.disconnect();
      log(`Bootstrap timed out after ${CONFIG.bootstrapTimeoutMs} ms — meeting UI not detected.`);
    }, CONFIG.bootstrapTimeoutMs);

    log('Waiting for meeting UI to load…');
  }

  bootstrap();
})();
