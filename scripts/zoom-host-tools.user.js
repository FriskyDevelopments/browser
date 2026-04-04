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
    //
    // Values in this block are replaced at build time by scripts/build-userscript.js
    // using secrets fetched from Doppler (see doppler.yaml).
    // To build a distributable copy with your own settings, run:
    //   doppler run -- npm run build
    // or set the environment variables manually and run: npm run build
    // ─────────────────────────────────────────────────────────────────────────

    // @@DOPPLER_CONFIG_START
    const DEBUG_MODE = false;
    const SCAN_INTERVAL = 2000;       // milliseconds between participant poll scans
    const SPAM_COOLDOWN_MS = 10000;   // minimum ms between spam logs for the same sender
    const LIST_RETRY_INTERVAL = 2000; // ms between retries waiting for participant list container

    // Spam patterns detected by the chat monitor
    const SPAM_PATTERNS = [
        'http://',
        'https://',
        't.me',
        'bit.ly',
        'discord.gg',
    ];
    // @@DOPPLER_CONFIG_END

    // ─────────────────────────────────────────────────────────────────────────
    // EMBEDDED SELECTOR CONFIGURATION
    //
    // These selectors mirror selectors/zoom-dom-selectors.json.
    // If Zoom updates its DOM, change the values in that file and update
    // the corresponding entries here to keep both in sync.
    // ─────────────────────────────────────────────────────────────────────────

    const SELECTORS = {
        participantList:           { primary: ".participants-list__list", fallback: "[aria-label='Participants panel'] ul" },
        participantRow:            { primary: ".participants-item", fallback: ".participants-list__item" },
        participantName:           { primary: ".participants-item__name", fallback: ".participants-list__item-name" },
        raisedHandIcon:            { primary: ".participants-item__raised-hand-icon", fallback: "[aria-label='Raise Hand'][class*='active']" },
        participantMenuButton:     { primary: ".participants-item__more-btn", fallback: "[aria-label='More options for participant']" },
        multipinMenuOption:        { primary: "[aria-label='Allow to Multi-Pin']", fallback: "[role='menuitem']" },
        menuItem:                  { primary: "[role='menuitem']", fallback: ".menu-item" },
        chatSender:                { primary: ".chat-message__sender", fallback: ".chat-list__item-sender" },
        cameraStatusIcon:          { primary: ".participants-item__camera-icon--off", fallback: "[aria-label='Video off']" },
        chatContainer:             { primary: ".chat-list__chat-virtualized", fallback: ".chat-message-list" },
        chatMessage:               { primary: ".chat-message__text", fallback: ".chat-list__item-content" },
        chatInput:                 { primary: ".chat-box__chat-input", fallback: "[aria-label='Type message here']" }
    };

    // ─────────────────────────────────────────────────────────────────────────
    // INTERNAL STATE
    // ─────────────────────────────────────────────────────────────────────────

    // Tracks participants that have already been processed.
    // Keyed by a stable participant key (derived from DOM data-* attributes when
    // available, otherwise the display name). Note that if two participants share
    // an identical display name AND no stable DOM attribute is present, only the
    // first will be processed. Zoom's DOM does not reliably expose a unique ID in
    // all views, so this is the best available key.
    const processedParticipants = new Set();

    // Guards against overlapping scanParticipants() runs triggered by both the
    // polling setTimeout and the MutationObserver.
    let isScanning = false;

    const stats = {
        scanned:          0,
        hands:            0,
        grants:           0,
        selectorFallbacks:0,
        lastParticipant:  'None',
        lastGrantResult:  'None',
        lastAction:       'None',
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
            const fallbackEl = root.querySelector(config.fallback) || null;
            if (fallbackEl) {
                stats.selectorFallbacks++;
                updateDebugPanel('selectorFallbacks', stats.selectorFallbacks);
            }
            return fallbackEl;
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
            if (nodes.length > 0) {
                stats.selectorFallbacks++;
                updateDebugPanel('selectorFallbacks', stats.selectorFallbacks);
            }
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
    // MODULE 1b — PARTICIPANT IDENTITY
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Derives a stable key for a participant row. Checks common Zoom data-*
     * attributes first so that participants who share a display name are still
     * tracked independently. Falls back to the visible display name when no
     * attribute is available.
     *
     * @param {Element} row      - Participant row element.
     * @param {string}  nameText - Visible display name (used as last-resort key).
     * @returns {string}
     */
    function getParticipantKey(row, nameText) {
        const stableId =
            row.dataset.uid ||
            row.dataset.userid ||
            row.dataset.participantId ||
            row.dataset.id;
        return stableId ? stableId : nameText;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // MODULE 2 — MULTI-PIN GRANT
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Possible outcomes of a Multi-Pin status check.
     * @enum {string}
     */
    const MULTIPIN = {
        NEEDS_GRANT:     'needs_grant',     // "Allow to Multi-Pin" visible → grant it
        ALREADY_GRANTED: 'already_granted', // confirmed granted indicator present
        UNKNOWN:         'unknown',         // menu opened but status unclear → retry
        ERROR:           'error',           // could not open/inspect menu → skip this cycle
    };

    /**
     * Opens a participant's context menu and checks for the "Allow to Multi-Pin"
     * option, then dismisses the menu. Returns a MULTIPIN enum value describing
     * the outcome so the caller can distinguish a genuine "already granted" state
     * from a transient menu failure.
     *
     * @param {Element} row - Participant row element.
     * @returns {Promise<string>} One of the MULTIPIN enum values.
     */
    async function checkMultipinStatus(row) {
        const menuButton = resolve('participantMenuButton', row);
        if (!menuButton) {
            log(`checkMultipinStatus: no menu button found — participant row may have been removed`);
            return MULTIPIN.ERROR;
        }

        menuButton.click();
        await sleep(300);

        // Find the opened menu container by looking for visible menu items
        // Zoom typically renders menus as siblings or in a portal near the body
        const allMenuItems = resolveAll('menuItem');
        const visibleMenuItems = allMenuItems.filter(isVisible);
        if (visibleMenuItems.length === 0) {
            log(`checkMultipinStatus: menu did not open (no visible menu items)`);
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            await sleep(200);
            return MULTIPIN.ERROR;
        }

        // Find the common menu container (parent of visible menu items)
        // Use the closest common ancestor or the first visible item's parent menu container
        let menuRoot = visibleMenuItems[0].closest('[role="menu"]') ||
                       visibleMenuItems[0].closest('.participant-context-menu') ||
                       visibleMenuItems[0].parentElement;

        // Scope all subsequent queries to this menu container
        const option = resolveMultipinOption(menuRoot);

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await sleep(200);

        if (option) {
            return MULTIPIN.NEEDS_GRANT;
        }

        // Check if there's a "Disable Multi-Pin" option which indicates it's already granted
        const disableOption = findMenuItemByText('Disable Multi-Pin', menuRoot);
        if (disableOption) {
            return MULTIPIN.ALREADY_GRANTED;
        }

        // Menu opened but we can't determine status - could be still populating
        return MULTIPIN.UNKNOWN;
    }

    /**
     * Checks if an element is visible in the DOM.
     * @param {Element} el
     * @returns {boolean}
     */
    function isVisible(el) {
        return el.offsetParent !== null || el.getClientRects().length > 0;
    }

    /**
     * Resolves the "Allow to Multi-Pin" menu option from the currently open
     * participant context menu. Tries the primary aria-label selector first; if the
     * result does not contain the expected text (i.e. a generic fallback matched)
     * it falls back to a full text-content search across all visible menu items.
     *
     * @param {Element} [root=document] - Menu container to scope search
     * @returns {Element|null}
     */
    function resolveMultipinOption(root = document) {
        const option = resolve('multipinMenuOption', root);
        if (option && isVisible(option) && option.textContent && option.textContent.toLowerCase().includes('multi-pin')) {
            return option;
        }
        return findMenuItemByText('Allow to Multi-Pin', root);
    }

    /**
     * Searches currently open menu items for one whose visible text matches
     * the given string. Uses the configured 'menuItem' selector so the search
     * scope can be updated centrally alongside other selectors.
     *
     * @param {string} text
     * @param {Element} [root=document] - Menu container to scope search
     * @returns {Element|null}
     */
    function findMenuItemByText(text, root = document) {
        const items = resolveAll('menuItem', root);
        for (const item of items) {
            if (isVisible(item) && item.textContent && item.textContent.trim().toLowerCase().includes(text.toLowerCase())) {
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
     * @param {Element} row         - Participant row element.
     * @param {string}  name        - Display name (for logging only).
     * @param {string}  key         - Stable participant key used for dedup tracking.
     */
    async function grantMultipin(row, name, key) {
        for (let attempt = 1; attempt <= 2; attempt++) {
            const menuButton = resolve('participantMenuButton', row);
            if (!menuButton) {
                const reason = 'menu button not found — participant row may have been removed from DOM';
                log(`grantMultipin attempt ${attempt}: ${reason} for "${name}"`);
                stats.lastGrantResult = `FAIL (${reason})`;
                updateDebugPanel('lastGrantResult', stats.lastGrantResult);
                break;
            }

            menuButton.click();
            await sleep(400);

            const allMenuItems = resolveAll('menuItem');
            const visibleMenuItems = allMenuItems.filter(isVisible);
            if (visibleMenuItems.length === 0) {
                const reason = 'menu did not open (no visible menu items after click)';
                log(`grantMultipin attempt ${attempt}: ${reason} for "${name}"`);
                stats.lastGrantResult = `FAIL (${reason})`;
                updateDebugPanel('lastGrantResult', stats.lastGrantResult);
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                await sleep(300);
                continue;
            }

            // Find the menu container to scope queries
            let menuRoot = visibleMenuItems[0].closest('[role="menu"]') ||
                           visibleMenuItems[0].closest('.participant-context-menu') ||
                           visibleMenuItems[0].parentElement;

            const option = resolveMultipinOption(menuRoot);
            if (option) {
                option.click();
                await sleep(300);

                // Verify the grant succeeded by re-checking status
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                await sleep(200);

                const verifyStatus = await checkMultipinStatus(row);
                if (verifyStatus === MULTIPIN.ALREADY_GRANTED || verifyStatus === MULTIPIN.UNKNOWN) {
                    // Success: option toggled or menu shows granted state
                    processedParticipants.add(key);
                    stats.grants++;
                    stats.lastParticipant = name;
                    stats.lastGrantResult = 'SUCCESS';
                    stats.lastAction = `Granted Multi-Pin to ${name}`;
                    log(`✅ Granted Multi-Pin to "${name}" (key: ${key})`);
                    updateDebugPanel('grants', stats.grants);
                    updateDebugPanel('lastParticipant', stats.lastParticipant);
                    updateDebugPanel('lastGrantResult', stats.lastGrantResult);
                    updateDebugPanel('lastAction', stats.lastAction);
                    return;
                } else {
                    log(`grantMultipin: click succeeded but verification failed for "${name}" — will retry`);
                    continue;
                }
            }

            const reason = `"Allow to Multi-Pin" option not found in open menu`;
            log(`grantMultipin attempt ${attempt}: ${reason} for "${name}"`);
            stats.lastGrantResult = `FAIL (${reason})`;
            updateDebugPanel('lastGrantResult', stats.lastGrantResult);
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            await sleep(300);
        }

        log(`grantMultipin: all attempts exhausted for "${name}" — will retry on next scan`);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // MODULE 3 — CAMERA CHECK SCAFFOLD
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Inspects the camera status icon for a participant row.
     *
     * Planned trigger conditions (TODO — not yet wired to chat):
     *   1. Participant has raised their hand.
     *   2. Multi-Pin has just been granted (or was already active).
     *   3. Camera is detected as off.
     *   → Send reminder: "Please turn your camera on to use Multi-Pin."
     *
     * The reminder should only be sent once per participant per session
     * (track in a separate Set, similar to processedParticipants).
     *
     * @param {Element} row  - Participant row element.
     * @param {string}  name - Participant display name.
     */
    function checkCameraStatus(row, name) {
        const cameraOff = resolve('cameraStatusIcon', row);
        if (cameraOff) {
            log(`📷 Camera is OFF for "${name}"`);
            // TODO: implement sendChatMessage(text) using the 'chatInput' selector,
            // then call: sendChatMessage(`${name}, please turn your camera on to use Multi-Pin.`)
            // Wrap in a cameraReminderSent Set guard to avoid repeated messages.
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // MODULE 4 — PARTICIPANT SCANNER
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Main scanning function. Called both by the self-scheduling poll and by
     * the MutationObserver when the participant list changes.
     *
     * For each participant row:
     *   1. Reads the participant's display name.
     *   2. Derives a stable participant key (data attribute or name).
     *   3. Skips participants that have already been processed.
     *   4. Detects a raised-hand icon.
     *   5. Checks Multi-Pin status (tri-state: needs_grant / already_granted / error).
     *   6. Grants Multi-Pin if needed; marks processed only on confirmed outcomes.
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

                const key = getParticipantKey(row, name);
                if (processedParticipants.has(key)) continue;

                const raisedHand = resolve('raisedHandIcon', row);
                if (!raisedHand) continue;

                stats.hands++;
                log(`✋ Raised hand detected: "${name}" (key: ${key})`);
                updateDebugPanel('hands', stats.hands);
                updateDebugPanel('lastParticipant', name);

                // Camera check (scaffold — does not block the Multi-Pin flow)
                checkCameraStatus(row, name);

                const status = await checkMultipinStatus(row);
                if (status === MULTIPIN.NEEDS_GRANT) {
                    await grantMultipin(row, name, key);
                } else if (status === MULTIPIN.ALREADY_GRANTED) {
                    // Confirmed Multi-Pin is active; mark processed so we stop scanning
                    processedParticipants.add(key);
                    stats.lastParticipant = name;
                    stats.lastGrantResult = 'already granted';
                    log(`ℹ️  Multi-Pin already granted for "${name}" (key: ${key}); skipping`);
                    updateDebugPanel('lastParticipant', name);
                    updateDebugPanel('lastGrantResult', stats.lastGrantResult);
                } else if (status === MULTIPIN.UNKNOWN) {
                    // Menu opened but status unclear (may still be populating)
                    // Do NOT mark as processed — will retry on next scan
                    log(`⚠️  Multi-Pin status unclear for "${name}"; will retry on next scan`);
                } else {
                    // status === MULTIPIN.ERROR: could not inspect menu this cycle
                    // Do NOT mark as processed — will retry on next scan
                    log(`⚠️  Could not confirm Multi-Pin status for "${name}"; will retry on next scan`);
                }
            } catch (err) {
                log(`scanParticipants error: ${err.message}`);
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // MODULE 5 — CHAT MONITOR SCAFFOLD
    // ─────────────────────────────────────────────────────────────────────────

    // Rate-limit spam log messages: track last log timestamp per sender.
    // A sender can trigger at most one spam log every SPAM_COOLDOWN_MS (see CONFIGURATION).
    const spamCooldown = new Map(); // sender string → timestamp

    /**
     * Observes chat messages for potential spam content.
     * Currently only logs detections; hook for moderation actions is prepared.
     *
     * Reconnects automatically if the container element is removed from the DOM
     * and re-added (e.g., when Zoom re-renders the chat panel).
     */
    function monitorChat() {
        let container = resolve('chatContainer');
        if (!container) {
            log('monitorChat: chat container not found; will retry on next interval');
            return;
        }

        let chatObserver = null;

        function attachObserver(target) {
            if (chatObserver) {
                chatObserver.disconnect();
            }
            chatObserver = new MutationObserver((mutations) => {
                for (const mutation of mutations) {
                    for (const node of mutation.addedNodes) {
                        if (node.nodeType !== Node.ELEMENT_NODE) continue;

                        const msgEl = resolve('chatMessage', node) || (
                            node.matches &&
                            (node.matches(SELECTORS.chatMessage.primary) ||
                             node.matches(SELECTORS.chatMessage.fallback))
                                ? node
                                : null
                        );

                        if (!msgEl) continue;

                        const text = msgEl.textContent || '';
                        const lowerText = text.toLowerCase();
                        const spamDetected = SPAM_PATTERNS.some(p => lowerText.includes(p));

                        if (spamDetected) {
                            const messageRoot =
                                (msgEl.parentElement) ||
                                (node.parentElement) ||
                                msgEl;
                            const senderEl = resolve('chatSender', messageRoot);
                            const sender = senderEl ? senderEl.textContent.trim() : 'unknown';

                            // Rate-limit: skip if this sender was logged recently
                            const lastLog = spamCooldown.get(sender) || 0;
                            if (Date.now() - lastLog < SPAM_COOLDOWN_MS) continue;
                            spamCooldown.set(sender, Date.now());

                            log(`⚠️  Possible spam detected | user: "${sender}" | message: "${text.trim()}"`);

                            // TODO: hook for moderation actions, e.g.:
                            //   - mute the participant
                            //   - remove the message
                            //   - flag to host dashboard
                        }
                    }
                }
            });
            chatObserver.observe(target, { childList: true, subtree: true });
            log('monitorChat: observer attached to chat container');
        }

        attachObserver(container);

        // Watch for the container being removed and re-added (Zoom SPA re-renders).
        const reconnectObserver = new MutationObserver(() => {
            const current = resolve('chatContainer');
            if (current && current !== container) {
                log('monitorChat: chat container replaced — reconnecting observer');
                container = current;
                attachObserver(container);
            }
        });
        reconnectObserver.observe(document.body, { childList: true, subtree: true });
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
            'min-width:240px',
            'pointer-events:none',
        ].join(';');

        panel.innerHTML = `
            <div style="font-weight:bold;margin-bottom:6px">🤖 Zoom Host Automation</div>
            <div>Scanned: <span data-key="scanned">0</span></div>
            <div>Raised hands: <span data-key="hands">0</span></div>
            <div>Multi-Pin grants: <span data-key="grants">0</span></div>
            <div>Selector fallbacks: <span data-key="selectorFallbacks">0</span></div>
            <div>Last participant: <span data-key="lastParticipant">None</span></div>
            <div>Last grant result: <span data-key="lastGrantResult">None</span></div>
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
    // MODULE 7 — PARTICIPANT LIST OBSERVER (polling + observer hybrid)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Attaches a MutationObserver to the participant list container. When rows
     * are added (someone joins or raises hand), an immediate scan is triggered
     * instead of waiting for the next poll interval. This makes hand-raise
     * detection faster without replacing the reliable polling fallback.
     *
     * Uses the shared `isScanning` flag to prevent overlap with the poll loop.
     *
     * Also watches for the participant list node being replaced and automatically
     * re-attaches the observer to the new container.
     */
    function watchParticipantList() {
        let container = resolve('participantList');
        if (!container) return;

        let listObserver = null;

        function attachListObserver(target) {
            if (listObserver) {
                listObserver.disconnect();
            }
            listObserver = new MutationObserver(() => {
                if (isScanning) return;
                isScanning = true;
                scanParticipants()
                    .catch(err => log(`watchParticipantList scan error: ${err.message}`))
                    .finally(() => { isScanning = false; });
            });
            listObserver.observe(target, { childList: true, subtree: true });
            log('Participant list observer attached');
        }

        attachListObserver(container);

        // Watch for container replacement (Zoom SPA re-renders)
        const reconnectObserver = new MutationObserver(() => {
            const current = resolve('participantList');
            if (current && current !== container) {
                log('watchParticipantList: participant list container replaced — reconnecting observer');
                container = current;
                attachListObserver(container);
            }
        });
        reconnectObserver.observe(document.body, { childList: true, subtree: true });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ENTRY POINT
    // ─────────────────────────────────────────────────────────────────────────

    function init() {
        log('Zoom Host Automation initializing…');

        if (DEBUG_MODE) {
            createDebugPanel();
        }

        // Self-scheduling poll — never overlaps with itself.
        // Also guarded by isScanning so it doesn't overlap with observer-triggered scans.
        const pollParticipants = async () => {
            if (!isScanning) {
                isScanning = true;
                try {
                    await scanParticipants();
                } catch (err) {
                    log(`Polling error: ${err.message}`);
                } finally {
                    isScanning = false;
                }
            }
            setTimeout(pollParticipants, SCAN_INTERVAL);
        };
        setTimeout(pollParticipants, SCAN_INTERVAL);

        // Attach MutationObserver on participant list for faster detection.
        // Keep retrying until the list container is found (meeting may still be loading).
        let listRetryCount = 0;
        const LIST_RETRY_MAX = 15;
        const listRetry = setInterval(() => {
            listRetryCount++;
            const container = resolve('participantList');
            if (container) {
                watchParticipantList();
                clearInterval(listRetry);
            } else if (listRetryCount >= LIST_RETRY_MAX) {
                log('watchParticipantList: participant list not found after max retries; relying on polling only');
                clearInterval(listRetry);
            }
        }, LIST_RETRY_INTERVAL);

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

        log(`Zoom Host Automation active (poll interval: ${SCAN_INTERVAL}ms)`);
    }

    // Wait for the Zoom meeting UI to finish loading before starting
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();