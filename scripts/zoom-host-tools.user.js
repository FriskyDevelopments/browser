// ==UserScript==
// @name         Zoom Host Automation
// @namespace    https://github.com/FriskyDevelopments/browser
// @version      1.0.0
// @description  Automatically grants Multi-Pin permission to participants who raise their hand in Zoom Web meetings. Requires host or co-host privileges.
// @author       FriskyDevelopments
// @match        https://*.zoom.us/wc/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // ─────────────────────────────────────────────────────────────────────────
    // CONFIGURATION
    // ─────────────────────────────────────────────────────────────────────────

    const DEBUG_MODE = true;
    const SCAN_INTERVAL = 2000; // milliseconds between participant scans

    // Spam patterns detected by the chat monitor
    const SPAM_PATTERNS = [
        'http://',
        'https://',
        't.me',
        'bit.ly',
        'discord.gg',
    ];

    // ─────────────────────────────────────────────────────────────────────────
    // EMBEDDED SELECTOR CONFIGURATION
    //
    // These selectors mirror selectors/zoom-dom-selectors.json.
    // If Zoom updates its DOM, change the values in that file and update
    // the corresponding entries here to keep both in sync.
    // ─────────────────────────────────────────────────────────────────────────

    const SELECTORS = {
        participantList:      { primary: '.participants-list__list',              fallback: "[aria-label='Participants panel'] ul" },
        participantRow:       { primary: '.participants-item',                    fallback: '.participants-list__item' },
        participantName:      { primary: '.participants-item__name',              fallback: '.participants-list__item-name' },
        raisedHandIcon:       { primary: '.participants-item__raised-hand-icon',  fallback: "[aria-label='Raise Hand'][class*='active']" },
        participantMenuButton:{ primary: '.participants-item__more-btn',          fallback: "[aria-label='More options for participant']" },
        multipinMenuOption:   { primary: "[aria-label='Allow to Multi-Pin']",     fallback: '[role="menuitem"]' },
        chatSender:           { primary: '.chat-message__sender',                  fallback: '.chat-list__item-sender' },
        cameraStatusIcon:     { primary: '.participants-item__camera-icon--off',  fallback: "[aria-label='Video off']" },
        chatContainer:        { primary: '.chat-list__chat-virtualized',          fallback: '.chat-message-list' },
        chatMessage:          { primary: '.chat-message__text',                   fallback: '.chat-list__item-content' },
        chatInput:            { primary: '.chat-box__chat-input',                 fallback: "[aria-label='Type message here']" },
    };

    // ─────────────────────────────────────────────────────────────────────────
    // INTERNAL STATE
    // ─────────────────────────────────────────────────────────────────────────

    // Tracks participants that have already been processed.
    // Keyed by display name; note that if two participants share an identical
    // display name only the first will be processed. Zoom's DOM does not expose
    // a stable unique ID in all views, so name is used as the best available key.
    const processedParticipants = new Set();

    const stats = {
        scanned:  0,
        hands:    0,
        grants:   0,
        lastAction: 'None',
    };

    // ─────────────────────────────────────────────────────────────────────────
    // MODULE 1 — SELECTOR RESOLVER
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Returns the first DOM element matching the primary selector for the given
     * key. Falls back to the secondary selector when the primary returns nothing.
     * Optionally scoped to a given root element.
     *
     * @param {string} key    - Key from the SELECTORS configuration object.
     * @param {Element} [root=document] - Element to search within.
     * @returns {Element|null}
     */
    function resolve(key, root = document) {
        const config = SELECTORS[key];
        if (!config) {
            log(`warn: unknown selector key "${key}"`);
            return null;
        }
        const el = root.querySelector(config.primary);
        if (el) return el;
        if (config.fallback) {
            return root.querySelector(config.fallback) || null;
        }
        return null;
    }

    /**
     * Same as resolve() but returns ALL matching elements as a NodeList /
     * Array, trying the primary selector first and falling back if needed.
     *
     * @param {string} key
     * @param {Element} [root=document]
     * @returns {Element[]}
     */
    function resolveAll(key, root = document) {
        const config = SELECTORS[key];
        if (!config) {
            log(`warn: unknown selector key "${key}"`);
            return [];
        }
        let nodes = Array.from(root.querySelectorAll(config.primary));
        if (nodes.length === 0 && config.fallback) {
            nodes = Array.from(root.querySelectorAll(config.fallback));
        }
        return nodes;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // UTILITY — DEBUG LOGGING
    // ─────────────────────────────────────────────────────────────────────────

    function log(message) {
        if (DEBUG_MODE) {
            console.log(`[ZoomHostAuto] ${message}`);
        }
    }

    function updateDebugPanel(key, value) {
        const panel = document.getElementById('zha-debug-panel');
        if (!panel) return;
        const el = panel.querySelector(`[data-key="${key}"]`);
        if (el) el.textContent = value;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // MODULE 2 — MULTI-PIN GRANT
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Checks whether a participant already has Multi-Pin by inspecting their
     * context menu. Opens the menu, looks for the "Allow to Multi-Pin" option,
     * and closes the menu immediately after checking.
     *
     * @param {Element} row - Participant row element.
     * @returns {Promise<boolean>} true if the option is present (i.e. not yet granted).
     */
    async function needsMultipin(row) {
        const menuButton = resolve('participantMenuButton', row);
        if (!menuButton) return false;

        menuButton.click();

        // Allow a short moment for the menu to render
        await sleep(300);

        const option = resolveMultipinOption();
        const found = !!option;

        // Dismiss the menu
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await sleep(200);

        return found;
    }

    /**
     * Resolves the "Allow to Multi-Pin" menu option from the currently open
     * participant context menu.  Tries the primary aria-label selector; if the
     * result does not contain the expected text (i.e. a generic fallback matched)
     * it falls back to a full text-content search.
     *
     * @returns {Element|null}
     */
    function resolveMultipinOption() {
        const option = resolve('multipinMenuOption');
        if (option && option.textContent && option.textContent.toLowerCase().includes('multi-pin')) {
            return option;
        }
        return findMenuItemByText('Allow to Multi-Pin');
    }

    /**
     * Searches open menu items for one whose visible text matches a given string.
     *
     * @param {string} text
     * @returns {Element|null}
     */
    function findMenuItemByText(text) {
        const items = resolveAll('.menu-item, [role="menuitem"]') || [];
        for (const item of items) {
            if (item.textContent && item.textContent.trim().toLowerCase().includes(text.toLowerCase())) {
                return item;
            }
        }
        return null;
    }

    /**
     * Opens the participant's context menu and clicks "Allow to Multi-Pin".
     * Marks the participant as processed on success.
     * Retries once if the menu fails to open on the first attempt.
     *
     * @param {Element} row  - Participant row element.
     * @param {string}  name - Participant display name (for logging).
     */
    async function grantMultipin(row, name) {
        for (let attempt = 1; attempt <= 2; attempt++) {
            const menuButton = resolve('participantMenuButton', row);
            if (!menuButton) {
                log(`grantMultipin: no menu button found for "${name}" (attempt ${attempt})`);
                break;
            }

            menuButton.click();
            await sleep(400);

            const option = resolveMultipinOption();

            if (option) {
                option.click();
                processedParticipants.add(name);
                stats.grants++;
                stats.lastAction = `Granted Multi-Pin to ${name}`;
                log(`✅ Granted Multi-Pin to "${name}"`);
                updateDebugPanel('grants', stats.grants);
                updateDebugPanel('lastAction', stats.lastAction);
                return;
            }

            // Menu opened but option not found — dismiss and retry
            log(`grantMultipin: option not found for "${name}", attempt ${attempt}`);
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            await sleep(300);
        }

        log(`grantMultipin: failed to grant Multi-Pin to "${name}" after retries`);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // MODULE 3 — CAMERA CHECK SCAFFOLD
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Inspects the camera status icon for a participant row.
     * If the camera is off, a reminder message should be sent via chat.
     *
     * @param {Element} row  - Participant row element.
     * @param {string}  name - Participant display name.
     */
    function checkCameraStatus(row, name) {
        const cameraOff = resolve('cameraStatusIcon', row);
        if (cameraOff) {
            log(`📷 Camera is OFF for "${name}"`);
            // TODO: Send chat message:
            //   "Please turn your camera on to use Multi-Pin."
            // Use sendChatMessage() once implemented.
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // MODULE 4 — PARTICIPANT SCANNER
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Main scanning loop. Called on every interval tick.
     *
     * For each participant row:
     *   1. Reads the participant's display name.
     *   2. Skips participants that have already been processed.
     *   3. Detects a raised-hand icon.
     *   4. Checks whether Multi-Pin is already granted.
     *   5. Grants Multi-Pin if needed.
     */
    async function scanParticipants() {
        const rows = resolveAll('participantRow');
        if (rows.length === 0) return;

        stats.scanned = rows.length;
        updateDebugPanel('scanned', stats.scanned);

        for (const row of rows) {
            try {
                const nameEl = resolve('participantName', row);
                const name = nameEl ? nameEl.textContent.trim() : null;

                if (!name) continue;
                if (processedParticipants.has(name)) continue;

                const raisedHand = resolve('raisedHandIcon', row);
                if (!raisedHand) continue;

                stats.hands++;
                log(`✋ Raised hand detected: "${name}"`);
                updateDebugPanel('hands', stats.hands);

                // Camera check (scaffold — does not block the flow)
                checkCameraStatus(row, name);

                // Only grant if the option still exists in the menu
                const shouldGrant = await needsMultipin(row);
                if (shouldGrant) {
                    await grantMultipin(row, name);
                } else {
                    // Multi-Pin already granted; mark as processed to avoid re-scanning
                    processedParticipants.add(name);
                    log(`ℹ️  Multi-Pin already granted for "${name}"; skipping`);
                }
            } catch (err) {
                log(`scanParticipants error: ${err.message}`);
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // MODULE 5 — CHAT MONITOR SCAFFOLD
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Observes chat messages for potential spam content.
     * Currently only logs detections; hook for moderation actions is prepared.
     */
    function monitorChat() {
        const container = resolve('chatContainer');
        if (!container) {
            log('monitorChat: chat container not found; will retry on next interval');
            return;
        }

        const observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType !== Node.ELEMENT_NODE) continue;

                    // Use the selector resolver for consistency
                    const msgEl = resolve('chatMessage', node) || (
                        node.matches && (
                            node.matches(SELECTORS.chatMessage.primary) ||
                            node.matches(SELECTORS.chatMessage.fallback)
                        ) ? node : null
                    );

                    if (!msgEl) continue;

                    const text = msgEl.textContent || '';
                    const lowerText = text.toLowerCase();
                    const spamDetected = SPAM_PATTERNS.some(p => lowerText.includes(p));

                    if (spamDetected) {
                        // Extract sender name using the configured selector.
                        // Resolve from a shared parent container so we can find the sender
                        // even when the mutation node is only the message text element.
                        const messageRoot =
                            (msgEl && msgEl.parentElement) ||
                            (node && node.parentElement) ||
                            msgEl;
                        const senderEl = resolve('chatSender', messageRoot);
                        const sender = senderEl ? senderEl.textContent.trim() : 'unknown';

                        log(`⚠️  Possible spam detected | user: "${sender}" | message: "${text.trim()}"`);

                        // TODO: hook for moderation actions, e.g.:
                        //   - mute the participant
                        //   - remove the message
                        //   - flag to host dashboard
                    }
                }
            }
        });

        observer.observe(container, { childList: true, subtree: true });
        log('monitorChat: observer attached to chat container');
    }

    // ─────────────────────────────────────────────────────────────────────────
    // MODULE 6 — DEBUG PANEL
    // ─────────────────────────────────────────────────────────────────────────

    function createDebugPanel() {
        const panel = document.createElement('div');
        panel.id = 'zha-debug-panel';
        panel.style.cssText = [
            'position:fixed',
            'bottom:16px',
            'right:16px',
            'z-index:99999',
            'background:rgba(0,0,0,0.75)',
            'color:#fff',
            'font:12px/1.5 monospace',
            'padding:10px 14px',
            'border-radius:6px',
            'min-width:220px',
            'pointer-events:none',
        ].join(';');

        panel.innerHTML = `
            <div style="font-weight:bold;margin-bottom:6px">🤖 Zoom Host Automation</div>
            <div>Scanned: <span data-key="scanned">0</span></div>
            <div>Raised hands: <span data-key="hands">0</span></div>
            <div>Multi-Pin grants: <span data-key="grants">0</span></div>
            <div>Last action: <span data-key="lastAction">None</span></div>
        `;

        document.body.appendChild(panel);
        log('Debug panel created');
    }

    // ─────────────────────────────────────────────────────────────────────────
    // UTILITY
    // ─────────────────────────────────────────────────────────────────────────

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ENTRY POINT
    // ─────────────────────────────────────────────────────────────────────────

    function init() {
        log('Zoom Host Automation initializing…');

        if (DEBUG_MODE) {
            createDebugPanel();
        }

        // Start the polling loop without overlapping runs
        const pollParticipants = async () => {
            try {
                await scanParticipants();
            } catch (err) {
                log(`Polling error: ${err.message}`);
            } finally {
                setTimeout(pollParticipants, SCAN_INTERVAL);
            }
        };
        // Schedule the first scan
        setTimeout(pollParticipants, SCAN_INTERVAL);

        // Start chat monitoring; Zoom may render the chat panel lazily,
        // so keep retrying until the container is found (up to ~60 seconds).
        let chatRetryCount = 0;
        const CHAT_RETRY_MAX = 20;
        const chatRetry = setInterval(() => {
            chatRetryCount++;
            const container = resolve('chatContainer');
            if (container) {
                monitorChat();
                clearInterval(chatRetry);
            } else if (chatRetryCount >= CHAT_RETRY_MAX) {
                log('monitorChat: chat panel not found after maximum retries; giving up');
                clearInterval(chatRetry);
            }
        }, 3000);

        log(`Zoom Host Automation active (interval: ${SCAN_INTERVAL}ms)`);
    }

    // Wait for the Zoom meeting UI to finish loading before starting
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
