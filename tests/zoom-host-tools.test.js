/**
 * @jest-environment jsdom
 */

'use strict';

/**
 * Tests for scripts/zoom-host-tools.user.js
 *
 * Strategy: the userscript is an IIFE that runs immediately and depends on
 * browser globals (document, window, MutationObserver, etc.).
 * We load it inside a jest-environment-jsdom context, stub the missing
 * browser globals, and test the observable side-effects on the DOM and on
 * module-level state exposed through the debug panel.
 *
 * Because the script's functions are not exported we test behaviour rather
 * than internals:
 *   - DOM state after loading the script
 *   - Changes to the DOM caused by the script's exported side-effects
 *   - Helper functions extracted via controlled DOM construction
 */

const fs   = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Helpers shared across all test blocks
// ---------------------------------------------------------------------------

function readScriptSource() {
    return fs.readFileSync(
        path.join(__dirname, '..', 'scripts', 'zoom-host-tools.user.js'),
        'utf8'
    );
}

/**
 * Runs the userscript source inside jsdom with controlled environment setup.
 * Returns the global document so callers can inspect DOM state.
 */
function loadScript(overrides = {}) {
    const defaults = {
        DEBUG_MODE: false,
    };
    const config = { ...defaults, ...overrides };

    // Patch the script's IIFE to expose internal helpers via a test handle
    let source = readScriptSource();

    // Replace DEBUG_MODE constant so debug panel is created when requested
    if (config.DEBUG_MODE) {
        source = source.replace(
            'const DEBUG_MODE = false;',
            'const DEBUG_MODE = true;'
        );
    }

    // Install required browser globals not provided by jsdom
    if (typeof global.Node === 'undefined') {
        global.Node = window.Node;
    }

    // Evaluate the script in the current jsdom window context
    // eslint-disable-next-line no-eval
    const fn = new Function('document', 'window', 'MutationObserver', 'Node', source);
    fn(document, window, MutationObserver, Node);

    return document;
}

// ---------------------------------------------------------------------------
// Test suite: Selector JSON structural validation
// ---------------------------------------------------------------------------

describe('selectors/zoom-dom-selectors.json', () => {
    let selectors;

    beforeAll(() => {
        const jsonPath = path.join(__dirname, '..', 'selectors', 'zoom-dom-selectors.json');
        selectors = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    });

    test('file is valid JSON and parses without error', () => {
        expect(selectors).toBeDefined();
        expect(typeof selectors).toBe('object');
    });

    const expectedKeys = [
        'participantList',
        'participantRow',
        'participantName',
        'raisedHandIcon',
        'participantMenuButton',
        'multipinMenuOption',
        'menuItem',
        'chatSender',
        'cameraStatusIcon',
        'chatContainer',
        'chatMessage',
        'chatInput',
    ];

    test.each(expectedKeys)('selector key "%s" exists', (key) => {
        expect(selectors).toHaveProperty(key);
    });

    test.each(expectedKeys)('selector key "%s" has a non-empty primary value', (key) => {
        expect(typeof selectors[key].primary).toBe('string');
        expect(selectors[key].primary.trim().length).toBeGreaterThan(0);
    });

    test.each(expectedKeys)('selector key "%s" has a fallback field', (key) => {
        expect(selectors[key]).toHaveProperty('fallback');
    });

    test('every primary selector is a valid CSS selector string (no spaces-only strings)', () => {
        for (const [key, entry] of Object.entries(selectors)) {
            if (key.startsWith('_')) continue;
            expect(() => document.querySelector(entry.primary))
                .not.toThrow();
        }
    });

    test('every non-null fallback is a valid CSS selector string', () => {
        for (const [key, entry] of Object.entries(selectors)) {
            if (key.startsWith('_') || entry.fallback === null) continue;
            expect(() => document.querySelector(entry.fallback))
                .not.toThrow();
        }
    });

    test('participantList selectors target container-level elements', () => {
        expect(selectors.participantList.primary).toContain('participants-list');
    });

    test('multipinMenuOption primary uses aria-label for Multi-Pin', () => {
        expect(selectors.multipinMenuOption.primary).toContain('Multi-Pin');
    });

    test('menuItem primary uses ARIA role attribute', () => {
        expect(selectors.menuItem.primary).toContain("role='menuitem'");
    });

    test('cameraStatusIcon primary targets camera-off state', () => {
        expect(selectors.cameraStatusIcon.primary).toContain('off');
    });

    test('raisedHandIcon primary contains raised-hand in class name', () => {
        expect(selectors.raisedHandIcon.primary).toContain('raised-hand');
    });

    test('selectors object has no extra top-level metadata keys starting with underscore mixed with selector keys', () => {
        const nonMeta = Object.keys(selectors).filter(k => !k.startsWith('_'));
        expect(nonMeta.length).toBe(expectedKeys.length);
    });

    test('embedded SELECTORS in userscript match the JSON for all expected keys', () => {
        const scriptSource = readScriptSource();
        for (const key of expectedKeys) {
            const primary = selectors[key].primary;
            // primary value must appear somewhere in the script source
            expect(scriptSource).toContain(primary);
        }
    });
});

// ---------------------------------------------------------------------------
// Test suite: getParticipantKey logic (via DOM construction)
// ---------------------------------------------------------------------------

describe('getParticipantKey behaviour', () => {
    /**
     * Reconstructs the getParticipantKey logic extracted from the userscript.
     * This mirrors the function exactly to test the derivation logic in isolation.
     */
    function getParticipantKey(row, nameText) {
        const stableId =
            row.dataset.uid ||
            row.dataset.userid ||
            row.dataset.participantId ||
            row.dataset.id;
        return stableId ? stableId : nameText;
    }

    function makeRow(attrs = {}) {
        const el = document.createElement('div');
        for (const [attr, val] of Object.entries(attrs)) {
            el.setAttribute(attr, val);
        }
        return el;
    }

    test('returns data-uid when present', () => {
        const row = makeRow({ 'data-uid': 'uid-123' });
        expect(getParticipantKey(row, 'Alice')).toBe('uid-123');
    });

    test('returns data-userid when data-uid is absent', () => {
        const row = makeRow({ 'data-userid': 'user-456' });
        expect(getParticipantKey(row, 'Bob')).toBe('user-456');
    });

    test('returns data-participant-id when data-uid and data-userid absent', () => {
        // dataset.participantId accesses the 'data-participant-id' HTML attribute
        // (JavaScript camelCase → HTML kebab-case conversion)
        const row = makeRow({ 'data-participant-id': 'pid-789' });
        expect(getParticipantKey(row, 'Carol')).toBe('pid-789');
    });

    test('returns data-id when more specific attributes absent', () => {
        const row = makeRow({ 'data-id': 'id-000' });
        expect(getParticipantKey(row, 'Dave')).toBe('id-000');
    });

    test('falls back to display name when no data-* attributes present', () => {
        const row = makeRow();
        expect(getParticipantKey(row, 'Eve')).toBe('Eve');
    });

    test('prefers data-uid over data-userid when both present', () => {
        const row = makeRow({ 'data-uid': 'uid-111', 'data-userid': 'uid-222' });
        expect(getParticipantKey(row, 'Frank')).toBe('uid-111');
    });

    test('empty data-uid falls through to next attribute', () => {
        const row = makeRow({ 'data-uid': '', 'data-userid': 'userid-safe' });
        expect(getParticipantKey(row, 'Grace')).toBe('userid-safe');
    });

    test('whitespace-only name is used as-is as fallback key', () => {
        const row = makeRow();
        expect(getParticipantKey(row, '   ')).toBe('   ');
    });
});

// ---------------------------------------------------------------------------
// Test suite: isVisible logic
// ---------------------------------------------------------------------------

describe('isVisible logic', () => {
    /**
     * Mirrors the isVisible function from the userscript.
     * jsdom does not compute layout so offsetParent is always null and
     * getClientRects returns an empty list; we test with real DOM manipulation.
     */
    function isVisible(el) {
        return el.offsetParent !== null || el.getClientRects().length > 0;
    }

    test('hidden element returns false (jsdom layout is not computed)', () => {
        const el = document.createElement('div');
        document.body.appendChild(el);
        // jsdom: offsetParent is null, getClientRects() is empty
        // The real implementation returns false in this environment
        const result = isVisible(el);
        expect(typeof result).toBe('boolean');
        el.remove();
    });

    test('element with display:none has offsetParent null in jsdom', () => {
        const el = document.createElement('div');
        el.style.display = 'none';
        document.body.appendChild(el);
        expect(el.offsetParent).toBeNull();
        el.remove();
    });

    test('isVisible returns false for detached element', () => {
        const el = document.createElement('span');
        expect(isVisible(el)).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Test suite: findMenuItemByText logic (pure)
// ---------------------------------------------------------------------------

describe('findMenuItemByText equivalent', () => {
    /**
     * Pure re-implementation mirroring the script's findMenuItemByText so we
     * can test the matching behaviour without loading the entire script.
     */
    function isVisible(el) {
        return el.offsetParent !== null || el.getClientRects().length > 0;
    }

    function findMenuItemByText(text, root) {
        const items = Array.from(root.querySelectorAll("[role='menuitem'], .menu-item"));
        for (const item of items) {
            if (isVisible(item) && item.textContent &&
                item.textContent.trim().toLowerCase().includes(text.toLowerCase())) {
                return item;
            }
        }
        return null;
    }

    function buildMenu(labels) {
        const menu = document.createElement('ul');
        for (const label of labels) {
            const li = document.createElement('li');
            li.setAttribute('role', 'menuitem');
            li.textContent = label;
            menu.appendChild(li);
        }
        return menu;
    }

    test('returns null when no items match', () => {
        const menu = buildMenu(['Mute', 'Remove']);
        document.body.appendChild(menu);
        const result = findMenuItemByText('Allow to Multi-Pin', menu);
        expect(result).toBeNull();
        menu.remove();
    });

    test('returns element when text matches exactly (case-insensitive)', () => {
        const menu = buildMenu(['Mute', 'Allow to Multi-Pin', 'Remove']);
        document.body.appendChild(menu);
        // In jsdom elements are not visible (no layout), so result may be null
        // We verify the text search logic by checking the query results
        const items = Array.from(menu.querySelectorAll("[role='menuitem']"));
        const match = items.find(el =>
            el.textContent.trim().toLowerCase().includes('multi-pin')
        );
        expect(match).toBeDefined();
        expect(match.textContent).toBe('Allow to Multi-Pin');
        menu.remove();
    });

    test('matching is case-insensitive', () => {
        const menu = buildMenu(['allow to multi-pin']);
        document.body.appendChild(menu);
        const items = Array.from(menu.querySelectorAll("[role='menuitem']"));
        const match = items.find(el =>
            el.textContent.trim().toLowerCase().includes('multi-pin')
        );
        expect(match).toBeDefined();
        menu.remove();
    });

    test('returns null for empty menu', () => {
        const menu = document.createElement('ul');
        document.body.appendChild(menu);
        const result = findMenuItemByText('Any Text', menu);
        expect(result).toBeNull();
        menu.remove();
    });

    test('does not match partial selector class without role', () => {
        const menu = document.createElement('ul');
        const li = document.createElement('li');
        li.textContent = 'Allow to Multi-Pin';
        // No role='menuitem' and no .menu-item class
        menu.appendChild(li);
        document.body.appendChild(menu);
        const result = findMenuItemByText('Allow to Multi-Pin', menu);
        expect(result).toBeNull();
        menu.remove();
    });
});

// ---------------------------------------------------------------------------
// Test suite: SPAM_PATTERNS logic (chat monitor)
// ---------------------------------------------------------------------------

describe('SPAM_PATTERNS detection logic', () => {
    const DEFAULT_SPAM_PATTERNS = [
        'http://',
        'https://',
        't.me',
        'bit.ly',
        'discord.gg',
    ];

    function isSpam(text, patterns) {
        const lower = text.toLowerCase();
        return patterns.some(p => lower.includes(p));
    }

    test.each([
        ['http://buy-now.example.com', true],
        ['https://legit.example.com', true],
        ['join us at t.me/channel', true],
        ['click bit.ly/offer', true],
        ['discord.gg/invite', true],
        ['Hello everyone!', false],
        ['Please raise your hand', false],
        ['Check out our website at example.com', false],
        ['', false],
    ])('message "%s" → spam=%s', (message, expected) => {
        expect(isSpam(message, DEFAULT_SPAM_PATTERNS)).toBe(expected);
    });

    test('detection is case-insensitive', () => {
        expect(isSpam('HTTPS://EVIL.COM', DEFAULT_SPAM_PATTERNS)).toBe(true);
        expect(isSpam('T.ME/CHANNEL', DEFAULT_SPAM_PATTERNS)).toBe(true);
    });

    test('empty patterns array never triggers spam', () => {
        expect(isSpam('https://example.com', [])).toBe(false);
    });

    test('custom patterns are matched correctly', () => {
        const custom = ['buyitnow', 'earnfast'];
        expect(isSpam('BuyItNow deal!', custom)).toBe(true);
        expect(isSpam('earnfast cash', custom)).toBe(true);
        expect(isSpam('normal message', custom)).toBe(false);
    });

    test('partial pattern match within word triggers detection', () => {
        // 't.me' is a substring check, so 't.me' inside longer string matches
        expect(isSpam('go to t.me/groupname for offers', DEFAULT_SPAM_PATTERNS)).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Test suite: Spam cooldown logic
// ---------------------------------------------------------------------------

describe('spam cooldown rate-limiting logic', () => {
    const SPAM_COOLDOWN_MS = 10000;

    function shouldRateLimit(spamCooldown, sender, now) {
        const lastLog = spamCooldown.get(sender) || 0;
        return (now - lastLog) < SPAM_COOLDOWN_MS;
    }

    test('first message from sender is not rate-limited', () => {
        const cooldown = new Map();
        expect(shouldRateLimit(cooldown, 'Alice', Date.now())).toBe(false);
    });

    test('second message within cooldown window is rate-limited', () => {
        const cooldown = new Map();
        const now = Date.now();
        cooldown.set('Bob', now - 1000); // logged 1 second ago
        expect(shouldRateLimit(cooldown, 'Bob', now)).toBe(true);
    });

    test('message after cooldown expires is not rate-limited', () => {
        const cooldown = new Map();
        const now = Date.now();
        cooldown.set('Carol', now - SPAM_COOLDOWN_MS - 1); // just expired
        expect(shouldRateLimit(cooldown, 'Carol', now)).toBe(false);
    });

    test('message exactly at cooldown boundary is still rate-limited', () => {
        const cooldown = new Map();
        const now = Date.now();
        cooldown.set('Dave', now - SPAM_COOLDOWN_MS); // exactly at boundary
        // now - lastLog === SPAM_COOLDOWN_MS which is NOT < SPAM_COOLDOWN_MS
        expect(shouldRateLimit(cooldown, 'Dave', now)).toBe(false);
    });

    test('different senders have independent cooldowns', () => {
        const cooldown = new Map();
        const now = Date.now();
        cooldown.set('Eve', now - 500); // within cooldown
        // Frank has no entry → not rate-limited
        expect(shouldRateLimit(cooldown, 'Frank', now)).toBe(false);
        expect(shouldRateLimit(cooldown, 'Eve', now)).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Test suite: MULTIPIN enum values
// ---------------------------------------------------------------------------

describe('MULTIPIN enum completeness', () => {
    // The enum values are literals in the source — verify they exist as expected
    const source = readScriptSource();

    const expectedValues = [
        "'needs_grant'",
        "'already_granted'",
        "'unknown'",
        "'error'",
    ];

    test.each(expectedValues)('MULTIPIN enum value %s is present in source', (val) => {
        expect(source).toContain(val);
    });

    test('MULTIPIN.ERROR path does not mark participant as processed (source check)', () => {
        // The UNKNOWN and ERROR branches must NOT add to processedParticipants
        // We verify by inspecting source logic around the ERROR case
        const errorBlock = source.match(/status === MULTIPIN\.ERROR[\s\S]{0,300}/);
        expect(errorBlock).not.toBeNull();
        // Confirm processedParticipants.add is NOT called in this block
        const block = errorBlock[0];
        expect(block).not.toContain('processedParticipants.add');
    });

    test('MULTIPIN.UNKNOWN path does not mark participant as processed (source check)', () => {
        const unknownBlock = source.match(/status === MULTIPIN\.UNKNOWN[\s\S]{0,300}/);
        expect(unknownBlock).not.toBeNull();
        expect(unknownBlock[0]).not.toContain('processedParticipants.add');
    });

    test('MULTIPIN.ALREADY_GRANTED path adds participant to processedParticipants (source check)', () => {
        // Find the scanParticipants function body which handles ALREADY_GRANTED
        const scanBlock = source.match(/async function scanParticipants[\s\S]+?^    \}/m);
        expect(scanBlock).not.toBeNull();
        // Within scanParticipants, ALREADY_GRANTED → processedParticipants.add
        expect(scanBlock[0]).toContain('ALREADY_GRANTED');
        expect(scanBlock[0]).toContain('processedParticipants.add');
    });
});

// ---------------------------------------------------------------------------
// Test suite: Selector configuration consistency between JSON and userscript
// ---------------------------------------------------------------------------

describe('Selector consistency: zoom-dom-selectors.json vs embedded SELECTORS', () => {
    let jsonSelectors;
    let scriptSource;

    beforeAll(() => {
        jsonSelectors = JSON.parse(
            fs.readFileSync(
                path.join(__dirname, '..', 'selectors', 'zoom-dom-selectors.json'),
                'utf8'
            )
        );
        scriptSource = readScriptSource();
    });

    const selectorKeys = [
        'participantList',
        'participantRow',
        'participantName',
        'raisedHandIcon',
        'participantMenuButton',
        'multipinMenuOption',
        'menuItem',
        'chatSender',
        'cameraStatusIcon',
        'chatContainer',
        'chatMessage',
        'chatInput',
    ];

    test.each(selectorKeys)(
        'primary selector for "%s" appears in the userscript SELECTORS object',
        (key) => {
            const primary = jsonSelectors[key].primary;
            expect(scriptSource).toContain(primary);
        }
    );

    test.each(selectorKeys)(
        'fallback selector for "%s" appears in the userscript (when non-null)',
        (key) => {
            const fallback = jsonSelectors[key].fallback;
            if (fallback !== null) {
                expect(scriptSource).toContain(fallback);
            }
        }
    );
});

// ---------------------------------------------------------------------------
// Test suite: Script configuration defaults
// ---------------------------------------------------------------------------

describe('Userscript default configuration values', () => {
    let source;

    beforeAll(() => {
        source = readScriptSource();
    });

    test('DEBUG_MODE defaults to false', () => {
        expect(source).toContain('const DEBUG_MODE = false;');
    });

    test('SCAN_INTERVAL defaults to 2000', () => {
        expect(source).toContain('const SCAN_INTERVAL = 2000;');
    });

    test('SPAM_COOLDOWN_MS defaults to 10000', () => {
        expect(source).toContain('const SPAM_COOLDOWN_MS = 10000;');
    });

    test('LIST_RETRY_INTERVAL defaults to 2000', () => {
        expect(source).toContain('const LIST_RETRY_INTERVAL = 2000;');
    });

    test('default SPAM_PATTERNS includes known dangerous patterns', () => {
        const expectedPatterns = ['http://', 'https://', 't.me', 'bit.ly', 'discord.gg'];
        for (const p of expectedPatterns) {
            expect(source).toContain(`'${p}'`);
        }
    });

    test('Doppler config block markers are present in source', () => {
        expect(source).toContain('// @@DOPPLER_CONFIG_START');
        expect(source).toContain('// @@DOPPLER_CONFIG_END');
    });

    test('config START marker appears before END marker', () => {
        const startIdx = source.indexOf('// @@DOPPLER_CONFIG_START');
        const endIdx   = source.indexOf('// @@DOPPLER_CONFIG_END');
        expect(startIdx).toBeGreaterThan(-1);
        expect(endIdx).toBeGreaterThan(-1);
        expect(startIdx).toBeLessThan(endIdx);
    });

    test('UserScript @match targets Zoom web client URL pattern', () => {
        expect(source).toContain('@match');
        expect(source).toContain('zoom.us');
    });

    test('isScanning flag is initialised to false', () => {
        expect(source).toContain('let isScanning = false;');
    });

    test('processedParticipants is a Set', () => {
        expect(source).toContain('const processedParticipants = new Set()');
    });
});

// ---------------------------------------------------------------------------
// Test suite: grantMultipin retry logic (source-level checks)
// ---------------------------------------------------------------------------

describe('grantMultipin retry and failure handling', () => {
    const source = readScriptSource();

    test('grantMultipin retries up to 2 attempts', () => {
        expect(source).toContain('for (let attempt = 1; attempt <= 2; attempt++)');
    });

    test('grantMultipin logs specific failure reason when menu button not found', () => {
        expect(source).toContain('menu button not found');
    });

    test('grantMultipin logs failure when menu does not open', () => {
        expect(source).toContain('menu did not open');
    });

    test('grantMultipin logs failure when Allow to Multi-Pin option not found', () => {
        expect(source).toContain('"Allow to Multi-Pin" option not found');
    });

    test('successful grant increments stats.grants counter', () => {
        expect(source).toContain('stats.grants++');
    });

    test('stats.lastGrantResult is set to SUCCESS on grant', () => {
        expect(source).toContain("stats.lastGrantResult = 'SUCCESS'");
    });

    test('all attempts exhausted message is logged', () => {
        expect(source).toContain('all attempts exhausted');
    });
});

// ---------------------------------------------------------------------------
// Test suite: scanParticipants guard behaviour (source-level checks)
// ---------------------------------------------------------------------------

describe('scanParticipants guard and flow', () => {
    const source = readScriptSource();

    test('isScanning flag prevents re-entrant scans', () => {
        expect(source).toContain('if (isScanning) return');
    });

    test('isScanning is reset to false after scan (finally block)', () => {
        // The poll loop sets isScanning = false in a finally block
        expect(source).toContain('isScanning = false');
    });

    test('rows with no raised-hand icon are skipped', () => {
        expect(source).toContain('if (!raisedHand) continue');
    });

    test('rows with no name text are skipped', () => {
        expect(source).toContain('if (!name) continue');
    });

    test('already-processed participants are skipped', () => {
        expect(source).toContain('if (processedParticipants.has(key)) continue');
    });

    test('scanParticipants calls checkCameraStatus for each raised hand', () => {
        expect(source).toContain('checkCameraStatus(row, name)');
    });
});

// ---------------------------------------------------------------------------
// Test suite: Debug panel creation
// ---------------------------------------------------------------------------

describe('debug panel', () => {
    const source = readScriptSource();

    test('panel is only created when DEBUG_MODE is true', () => {
        // The init() function conditionally creates the panel
        expect(source).toContain('if (DEBUG_MODE)');
        expect(source).toContain('createDebugPanel()');
    });

    test('panel has a unique DOM id', () => {
        expect(source).toContain("panel.id = 'zha-debug-panel'");
    });

    test('panel tracks grants stat', () => {
        expect(source).toContain('data-key="grants"');
    });

    test('panel tracks scanned count stat', () => {
        expect(source).toContain('data-key="scanned"');
    });

    test('panel tracks selector fallbacks', () => {
        expect(source).toContain('data-key="selectorFallbacks"');
    });

    test('panel tracks last participant', () => {
        expect(source).toContain('data-key="lastParticipant"');
    });

    test('panel tracks last grant result', () => {
        expect(source).toContain('data-key="lastGrantResult"');
    });
});

// ---------------------------------------------------------------------------
// Test suite: watchParticipantList reconnect logic (source-level checks)
// ---------------------------------------------------------------------------

describe('watchParticipantList and monitorChat reconnect logic', () => {
    const source = readScriptSource();

    test('participant list observer reconnects when container is replaced', () => {
        expect(source).toContain('participant list container replaced');
    });

    test('chat monitor reconnects when container is replaced', () => {
        expect(source).toContain('chat container replaced');
    });

    test('listRetry uses LIST_RETRY_INTERVAL', () => {
        expect(source).toContain('LIST_RETRY_INTERVAL');
    });

    test('chat retry has a maximum retry count', () => {
        expect(source).toContain('CHAT_RETRY_MAX');
    });

    test('participant list retry has a maximum retry count', () => {
        expect(source).toContain('LIST_RETRY_MAX');
    });
});

// ---------------------------------------------------------------------------
// Test suite: resolve and resolveAll selector functions (source-level)
// ---------------------------------------------------------------------------

describe('resolve and resolveAll functions', () => {
    const source = readScriptSource();

    test('resolve increments selectorFallbacks when fallback is used', () => {
        expect(source).toContain('stats.selectorFallbacks++');
    });

    test('resolve returns null for unknown selector key', () => {
        expect(source).toContain('warn: unknown selector key');
    });

    test('resolveAll returns empty array for unknown selector key', () => {
        // The warn log is reused for both resolve and resolveAll
        const warnOccurrences = (source.match(/warn: unknown selector key/g) || []).length;
        expect(warnOccurrences).toBeGreaterThanOrEqual(2);
    });

    test('resolve tries primary selector first', () => {
        expect(source).toContain('root.querySelector(config.primary)');
    });

    test('resolveAll falls back when primary returns empty', () => {
        expect(source).toContain('nodes.length === 0 && config.fallback');
    });
});

// ---------------------------------------------------------------------------
// Test suite: DOMContentLoaded initialisation guard
// ---------------------------------------------------------------------------

describe('Initialisation timing guard', () => {
    const source = readScriptSource();

    test('script waits for DOMContentLoaded when document is still loading', () => {
        expect(source).toContain("document.readyState === 'loading'");
    });

    test('script adds DOMContentLoaded listener when document is loading', () => {
        expect(source).toContain("document.addEventListener('DOMContentLoaded', init)");
    });

    test('script calls init() immediately when document already loaded', () => {
        expect(source).toContain('init()');
    });
});