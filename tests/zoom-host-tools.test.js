'use strict';

/**
 * Unit tests for the pure-logic helpers in zoom-host-tools.user.js.
 *
 * Jest is configured with testEnvironment:'jsdom' so browser globals
 * (document, Node, MutationObserver, MouseEvent, KeyboardEvent …) are
 * available.  The userscript detects `typeof module !== 'undefined'` and
 * exports its helper functions instead of calling waitForZoomReady(), so no
 * polling timers are started during tests.
 */

const helpers = require('../scripts/zoom-host-tools.user.js');

const {
  CONFIG,
  STATE,
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
} = helpers;

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/** Creates a <div> appended to document.body and returns it. */
function fixture(html = '') {
  const el = document.createElement('div');
  el.innerHTML = html;
  document.body.appendChild(el);
  return el;
}

/** Removes all children added to document.body during a test. */
afterEach(() => {
  document.body.innerHTML = '';
  STATE.processedParticipants.clear();
  STATE.grantQueue.length = 0;
  STATE.grantQueueRunning = false;
  STATE.stats.scans = 0;
  STATE.stats.raisedHandsFound = 0;
  STATE.stats.multipinGrantsAttempted = 0;
  STATE.stats.lastAction = 'idle';
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveElement
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveElement', () => {
  test('returns null for an empty candidates array', () => {
    expect(resolveElement([], document)).toBeNull();
  });

  test('returns null when no candidate matches', () => {
    expect(resolveElement(['[data-testid="nonexistent"]'], document)).toBeNull();
  });

  test('returns the first matching element', () => {
    const el = fixture('<span data-testid="target">hi</span>');
    const result = resolveElement(['[data-testid="target"]'], document);
    expect(result).not.toBeNull();
    expect(result.textContent).toBe('hi');
  });

  test('skips non-matching candidates and returns the first hit', () => {
    fixture('<span data-testid="second">second</span>');
    const result = resolveElement(
      ['[data-testid="first"]', '[data-testid="second"]'],
      document
    );
    expect(result).not.toBeNull();
    expect(result.dataset.testid).toBe('second');
  });

  test('continues past invalid selectors without throwing', () => {
    fixture('<div class="ok"></div>');
    expect(() =>
      resolveElement([':::invalid:::', '.ok'], document)
    ).not.toThrow();
    const result = resolveElement([':::invalid:::', '.ok'], document);
    expect(result).not.toBeNull();
  });

  test('uses a custom root element instead of document', () => {
    const root = fixture('<div><span class="inner">x</span></div>');
    expect(resolveElement(['.inner'], root)).not.toBeNull();
    // Should not find the element if we query outside root
    const other = document.createElement('div');
    expect(resolveElement(['.inner'], other)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveAllElements
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveAllElements', () => {
  test('returns an empty array when nothing matches', () => {
    expect(resolveAllElements(['[data-testid="ghost"]'], document)).toEqual([]);
  });

  test('returns all matching elements for the first valid selector', () => {
    fixture(`
      <li class="row">A</li>
      <li class="row">B</li>
      <li class="row">C</li>
    `);
    const results = resolveAllElements(['.row'], document);
    expect(results).toHaveLength(3);
  });

  test('uses the first selector that has any match', () => {
    fixture('<div class="second">x</div>');
    const results = resolveAllElements(['.first', '.second'], document);
    expect(results).toHaveLength(1);
    expect(results[0].className).toBe('second');
  });

  test('handles invalid selectors gracefully', () => {
    fixture('<div class="safe"></div>');
    expect(() =>
      resolveAllElements([':::bad:::', '.safe'], document)
    ).not.toThrow();
    const results = resolveAllElements([':::bad:::', '.safe'], document);
    expect(results).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getParticipantId
// ─────────────────────────────────────────────────────────────────────────────

describe('getParticipantId', () => {
  test('prefers data-participant-id attribute', () => {
    const wrapper = fixture('<div data-participant-id="abc123"></div>');
    expect(getParticipantId(wrapper.firstElementChild)).toBe('id:abc123');
  });

  test('falls back to data-id when data-participant-id is absent', () => {
    const wrapper = fixture('<div data-id="xyz789"></div>');
    expect(getParticipantId(wrapper.firstElementChild)).toBe('id:xyz789');
  });

  test('builds composite name+fingerprint when no explicit id attribute', () => {
    const row = fixture(
      '<div><span data-testid="participant-name">Alice</span></div>'
    );
    const id = getParticipantId(row.firstElementChild);
    expect(id).toContain('name:Alice');
    expect(id).toContain('fp:');
  });

  test('different sibling indices produce different fingerprints', () => {
    const parent = document.createElement('ul');
    parent.innerHTML =
      '<li><span data-testid="participant-name">Bob</span></li>' +
      '<li><span data-testid="participant-name">Bob</span></li>';
    document.body.appendChild(parent);

    const id0 = getParticipantId(parent.children[0]);
    const id1 = getParticipantId(parent.children[1]);
    expect(id0).not.toBe(id1);
  });

  test('falls back to fingerprint-only when there is no name element', () => {
    const row = document.createElement('div');
    document.body.appendChild(row);
    const id = getParticipantId(row);
    expect(id).toMatch(/^fp:/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// hasRaisedHand
// ─────────────────────────────────────────────────────────────────────────────

describe('hasRaisedHand', () => {
  test('returns false for an empty participant row', () => {
    const row = document.createElement('li');
    expect(hasRaisedHand(row)).toBe(false);
  });

  test('detects raise-hand via aria-label="Raise Hand" (strategy 1 selector)', () => {
    const row = fixture(
      '<li><span aria-label="Raise Hand"></span></li>'
    );
    expect(hasRaisedHand(row)).toBe(true);
  });

  test('detects raise-hand via aria-label="Hand raised" (strategy 1 selector)', () => {
    const row = fixture(
      '<li><span aria-label="Hand raised"></span></li>'
    );
    expect(hasRaisedHand(row)).toBe(true);
  });

  test('detects raise-hand via raised-hand class name (strategy 1 selector)', () => {
    const row = fixture(
      '<li><svg class="raise-hand-icon"></svg></li>'
    );
    expect(hasRaisedHand(row)).toBe(true);
  });

  test('detects raise-hand via ✋ emoji in text content (strategy 2 fallback)', () => {
    const row = fixture('<li><span>✋</span></li>');
    expect(hasRaisedHand(row)).toBe(true);
  });

  test('detects raise-hand via aria-label containing "hand" on a descendant (strategy 2 fallback)', () => {
    const row = fixture(
      '<li><div aria-label="hand icon custom"></div></li>'
    );
    expect(hasRaisedHand(row)).toBe(true);
  });

  test('detects raise-hand via aria-label containing "raise" on a descendant (strategy 2 fallback)', () => {
    const row = fixture(
      '<li><div aria-label="raise indicator"></div></li>'
    );
    expect(hasRaisedHand(row)).toBe(true);
  });

  test('returns false when row contains unrelated elements', () => {
    const row = fixture(
      '<li><span>John Doe</span><button>Mute</button></li>'
    );
    expect(hasRaisedHand(row)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// alreadyProcessed
// ─────────────────────────────────────────────────────────────────────────────

describe('alreadyProcessed', () => {
  test('returns false for a participant that has not been processed', () => {
    expect(alreadyProcessed('id:abc')).toBe(false);
  });

  test('returns true after the participant id is added to the processed set', () => {
    STATE.processedParticipants.add('id:abc');
    expect(alreadyProcessed('id:abc')).toBe(true);
  });

  test('is case-sensitive', () => {
    STATE.processedParticipants.add('id:ABC');
    expect(alreadyProcessed('id:abc')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// checkMessageForSpam
// ─────────────────────────────────────────────────────────────────────────────

describe('checkMessageForSpam', () => {
  let warnSpy;
  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warnSpy.mockRestore());

  test('does not warn for plain text messages', () => {
    checkMessageForSpam('Hello everyone!', 'Alice');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test('warns for an http:// URL', () => {
    checkMessageForSpam('Check this out: http://example.com', 'Bob');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0].join(' ')).toMatch(/spam/i);
  });

  test('warns for an https:// URL', () => {
    checkMessageForSpam('See https://example.com/page', 'Carol');
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  test('warns for a t.me/ link', () => {
    checkMessageForSpam('Join us at t.me/coolgroup', 'Dave');
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  test('warns for a bit.ly/ link', () => {
    checkMessageForSpam('Click bit.ly/shortlink', 'Eve');
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  test('warns for a discord.gg/ link', () => {
    checkMessageForSpam('discord.gg/myserver', 'Frank');
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  test('only warns once even when the message matches multiple patterns', () => {
    // http:// matches first; function returns after the first match
    checkMessageForSpam('http://bit.ly/something', 'Grace');
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  test('includes the sender name in the warning', () => {
    checkMessageForSpam('http://spam.com', 'Mallory');
    expect(warnSpy.mock.calls[0].join(' ')).toContain('Mallory');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// menuShowsMultiPinAlreadyGranted
// ─────────────────────────────────────────────────────────────────────────────

describe('menuShowsMultiPinAlreadyGranted', () => {
  test('returns false when there are no menu items in the DOM', () => {
    expect(menuShowsMultiPinAlreadyGranted()).toBe(false);
  });

  test('returns false when only "Allow to Multi-Pin" is present', () => {
    fixture('<ul><li role="menuitem">Allow to Multi-Pin</li></ul>');
    expect(menuShowsMultiPinAlreadyGranted()).toBe(false);
  });

  test('returns true when "Remove Multi-Pin" is present', () => {
    fixture('<ul><li role="menuitem">Remove Multi-Pin</li></ul>');
    expect(menuShowsMultiPinAlreadyGranted()).toBe(true);
  });

  test('returns true when "Revoke Multi-Pin" is present', () => {
    fixture('<ul><li role="menuitem">Revoke Multi-Pin</li></ul>');
    expect(menuShowsMultiPinAlreadyGranted()).toBe(true);
  });

  test('returns true when "Disallow Multi-Pin" is present', () => {
    fixture('<ul><li role="menuitem">Disallow Multi-Pin</li></ul>');
    expect(menuShowsMultiPinAlreadyGranted()).toBe(true);
  });

  test('is case-insensitive for keyword matching', () => {
    fixture('<ul><li role="menuitem">remove multi-pin</li></ul>');
    expect(menuShowsMultiPinAlreadyGranted()).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// findMultiPinMenuItem
// ─────────────────────────────────────────────────────────────────────────────

describe('findMultiPinMenuItem', () => {
  test('returns null when there are no menu items', () => {
    expect(findMultiPinMenuItem()).toBeNull();
  });

  test('finds item by aria-label="Allow to Multi-Pin"', () => {
    const item = fixture(
      '<ul><li role="menuitem" aria-label="Allow to Multi-Pin">Allow to Multi-Pin</li></ul>'
    ).querySelector('[aria-label="Allow to Multi-Pin"]');
    expect(findMultiPinMenuItem()).toBe(item);
  });

  test('finds item by data-testid="allow-multipin"', () => {
    fixture(
      '<ul><li role="menuitem" data-testid="allow-multipin">Multi-Pin</li></ul>'
    );
    const result = findMultiPinMenuItem();
    expect(result).not.toBeNull();
    expect(result.dataset.testid).toBe('allow-multipin');
  });

  test('finds item by text content containing "Multi-Pin" keyword', () => {
    fixture(
      '<ul><li role="menuitem">Allow to Multi-Pin</li></ul>'
    );
    const result = findMultiPinMenuItem();
    expect(result).not.toBeNull();
    expect(result.textContent).toContain('Multi-Pin');
  });

  test('returns null when menu only has unrelated items', () => {
    fixture(
      '<ul>' +
        '<li role="menuitem">Mute</li>' +
        '<li role="menuitem">Remove</li>' +
      '</ul>'
    );
    expect(findMultiPinMenuItem()).toBeNull();
  });

  test('is case-insensitive for text matching', () => {
    fixture('<ul><li role="menuitem">allow to multi-pin</li></ul>');
    expect(findMultiPinMenuItem()).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// sleep
// ─────────────────────────────────────────────────────────────────────────────

describe('sleep', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('returns a Promise', () => {
    const p = sleep(100);
    expect(p).toBeInstanceOf(Promise);
    jest.runAllTimers();
  });

  test('resolves after the specified delay', async () => {
    let resolved = false;
    sleep(500).then(() => { resolved = true; });
    expect(resolved).toBe(false);
    jest.advanceTimersByTime(500);
    await Promise.resolve(); // flush microtask queue
    expect(resolved).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// hoverRow
// ─────────────────────────────────────────────────────────────────────────────

describe('hoverRow', () => {
  test('dispatches mouseover, mouseenter and mousemove events on the row', () => {
    const row = document.createElement('div');
    const received = [];
    ['mouseover', 'mouseenter', 'mousemove'].forEach(type => {
      row.addEventListener(type, () => received.push(type));
    });
    hoverRow(row);
    expect(received).toContain('mouseover');
    expect(received).toContain('mouseenter');
    expect(received).toContain('mousemove');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// closeOpenMenu
// ─────────────────────────────────────────────────────────────────────────────

describe('closeOpenMenu', () => {
  test('dispatches an Escape keydown event on document', () => {
    let capturedKey = null;
    const handler = (e) => { capturedKey = e.key; };
    document.addEventListener('keydown', handler);
    closeOpenMenu();
    document.removeEventListener('keydown', handler);
    expect(capturedKey).toBe('Escape');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Grant queue: enqueueGrant / drainGrantQueue
// ─────────────────────────────────────────────────────────────────────────────

describe('grant queue', () => {
  test('enqueueGrant adds an entry to STATE.grantQueue', () => {
    const row = document.createElement('li');
    enqueueGrant(row, 'id:test-participant');
    // drainGrantQueue() is called synchronously inside enqueueGrant and sets
    // grantQueueRunning = true before the first await, so this flag is the
    // reliable signal that the queue was triggered.
    expect(STATE.grantQueueRunning).toBe(true);
  });

  test('drainGrantQueue sets grantQueueRunning false on an empty queue', async () => {
    STATE.grantQueue.length = 0;
    STATE.grantQueueRunning = false;
    await drainGrantQueue();
    expect(STATE.grantQueueRunning).toBe(false);
  });

  test('drainGrantQueue is a no-op when already running', async () => {
    STATE.grantQueueRunning = true;
    // If it is already running, a second call should return immediately
    // without throwing or corrupting state.
    await drainGrantQueue();
    expect(STATE.grantQueueRunning).toBe(true); // still true — first run owns it
    STATE.grantQueueRunning = false; // clean up
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG sanity checks
// ─────────────────────────────────────────────────────────────────────────────

describe('CONFIG', () => {
  test('SCAN_INTERVAL_MS is a positive number', () => {
    expect(CONFIG.SCAN_INTERVAL_MS).toBeGreaterThan(0);
  });

  test('SPAM_PATTERNS is a non-empty array of RegExp', () => {
    expect(Array.isArray(CONFIG.SPAM_PATTERNS)).toBe(true);
    expect(CONFIG.SPAM_PATTERNS.length).toBeGreaterThan(0);
    CONFIG.SPAM_PATTERNS.forEach(p => expect(p).toBeInstanceOf(RegExp));
  });

  test('MENU_CLICK_RETRIES is a positive integer', () => {
    expect(Number.isInteger(CONFIG.MENU_CLICK_RETRIES)).toBe(true);
    expect(CONFIG.MENU_CLICK_RETRIES).toBeGreaterThan(0);
  });

  test('ZOOM_READY_TIMEOUT_S is a positive number', () => {
    expect(CONFIG.ZOOM_READY_TIMEOUT_S).toBeGreaterThan(0);
  });
});
