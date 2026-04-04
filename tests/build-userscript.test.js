'use strict';

/**
 * Tests for scripts/build-userscript.js
 *
 * Because build-userscript.js is a script that runs immediately when required
 * (side-effects: reads files, writes files, calls process.exit on error) we
 * test it by spawning it as a child process with specific environment variable
 * combinations and checking the exit code and filesystem output.
 *
 * We also test the parseNumericEnv logic and config block substitution by
 * inspecting the generated dist/ file content.
 */

const { execSync, spawnSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const ROOT        = path.join(__dirname, '..');
const SCRIPT      = path.join(ROOT, 'scripts', 'build-userscript.js');
const SRC_FILE    = path.join(ROOT, 'scripts', 'zoom-host-tools.user.js');
const DIST_DIR    = path.join(ROOT, 'dist');
const DIST_FILE   = path.join(DIST_DIR, 'zoom-host-tools.user.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Runs the build script as a child process with the given env overrides.
 * Returns { status, stdout, stderr }.
 */
function runBuild(env = {}) {
    const result = spawnSync(process.execPath, [SCRIPT], {
        env: { ...process.env, ...env },
        cwd: ROOT,
        encoding: 'utf8',
    });
    return {
        status: result.status,
        stdout: result.stdout || '',
        stderr: result.stderr || '',
    };
}

/**
 * Reads the dist file content after a successful build.
 */
function readDist() {
    return fs.readFileSync(DIST_FILE, 'utf8');
}

// ---------------------------------------------------------------------------
// Test suite: build success cases
// ---------------------------------------------------------------------------

describe('build-userscript.js — default build (no env overrides)', () => {
    let result;
    let distContent;

    beforeAll(() => {
        // Remove dist before building to ensure a clean run
        if (fs.existsSync(DIST_FILE)) fs.unlinkSync(DIST_FILE);
        result = runBuild({
            ZOOM_DEBUG_MODE: undefined,
            ZOOM_SCAN_INTERVAL: undefined,
            ZOOM_SPAM_COOLDOWN_MS: undefined,
            ZOOM_LIST_RETRY_INTERVAL: undefined,
            ZOOM_SPAM_PATTERNS: undefined,
            SIGNING: undefined,
        });
        if (result.status === 0) {
            distContent = readDist();
        }
    });

    test('exits with code 0', () => {
        expect(result.status).toBe(0);
    });

    test('creates dist/ directory', () => {
        expect(fs.existsSync(DIST_DIR)).toBe(true);
    });

    test('creates dist/zoom-host-tools.user.js', () => {
        expect(fs.existsSync(DIST_FILE)).toBe(true);
    });

    test('output contains @@DOPPLER_CONFIG_START marker', () => {
        expect(distContent).toContain('// @@DOPPLER_CONFIG_START');
    });

    test('output contains @@DOPPLER_CONFIG_END marker', () => {
        expect(distContent).toContain('// @@DOPPLER_CONFIG_END');
    });

    test('output keeps UserScript header intact', () => {
        expect(distContent).toContain('// ==UserScript==');
        expect(distContent).toContain('// ==/UserScript==');
    });

    test('default DEBUG_MODE is false in built output', () => {
        expect(distContent).toContain('const DEBUG_MODE = false;');
    });

    test('default SCAN_INTERVAL is 2000 in built output', () => {
        expect(distContent).toContain('const SCAN_INTERVAL = 2000;');
    });

    test('default SPAM_COOLDOWN_MS is 10000 in built output', () => {
        expect(distContent).toContain('const SPAM_COOLDOWN_MS = 10000;');
    });

    test('default LIST_RETRY_INTERVAL is 2000 in built output', () => {
        expect(distContent).toContain('const LIST_RETRY_INTERVAL = 2000;');
    });

    test('default SPAM_PATTERNS contains http://', () => {
        expect(distContent).toContain("'http://'");
    });

    test('default SPAM_PATTERNS contains https://', () => {
        expect(distContent).toContain("'https://'");
    });

    test('default SPAM_PATTERNS contains t.me', () => {
        expect(distContent).toContain("'t.me'");
    });

    test('default SPAM_PATTERNS contains bit.ly', () => {
        expect(distContent).toContain("'bit.ly'");
    });

    test('default SPAM_PATTERNS contains discord.gg', () => {
        expect(distContent).toContain("'discord.gg'");
    });

    test('stdout reports successful build', () => {
        expect(result.stdout).toContain('built successfully');
    });

    test('stdout reports correct source file path', () => {
        expect(result.stdout).toContain('zoom-host-tools.user.js');
    });

    test('stdout reports signing is disabled by default', () => {
        expect(result.stdout).toContain('signing');
        expect(result.stdout).toContain('disabled');
    });
});

// ---------------------------------------------------------------------------
// Test suite: DEBUG_MODE override
// ---------------------------------------------------------------------------

describe('build-userscript.js — ZOOM_DEBUG_MODE=true', () => {
    let distContent;

    beforeAll(() => {
        const result = runBuild({ ZOOM_DEBUG_MODE: 'true', SIGNING: undefined });
        if (result.status === 0) distContent = readDist();
    });

    test('built output has DEBUG_MODE = true', () => {
        expect(distContent).toContain('const DEBUG_MODE = true;');
    });
});

describe('build-userscript.js — ZOOM_DEBUG_MODE=false explicit', () => {
    let distContent;

    beforeAll(() => {
        const result = runBuild({ ZOOM_DEBUG_MODE: 'false', SIGNING: undefined });
        if (result.status === 0) distContent = readDist();
    });

    test('built output has DEBUG_MODE = false', () => {
        expect(distContent).toContain('const DEBUG_MODE = false;');
    });
});

// ---------------------------------------------------------------------------
// Test suite: numeric env overrides
// ---------------------------------------------------------------------------

describe('build-userscript.js — numeric environment overrides', () => {
    test('ZOOM_SCAN_INTERVAL=3000 is injected into built output', () => {
        const result = runBuild({ ZOOM_SCAN_INTERVAL: '3000', SIGNING: undefined });
        expect(result.status).toBe(0);
        const dist = readDist();
        expect(dist).toContain('const SCAN_INTERVAL = 3000;');
    });

    test('ZOOM_SPAM_COOLDOWN_MS=5000 is injected into built output', () => {
        const result = runBuild({ ZOOM_SPAM_COOLDOWN_MS: '5000', SIGNING: undefined });
        expect(result.status).toBe(0);
        const dist = readDist();
        expect(dist).toContain('const SPAM_COOLDOWN_MS = 5000;');
    });

    test('ZOOM_LIST_RETRY_INTERVAL=1000 is injected into built output', () => {
        const result = runBuild({ ZOOM_LIST_RETRY_INTERVAL: '1000', SIGNING: undefined });
        expect(result.status).toBe(0);
        const dist = readDist();
        expect(dist).toContain('const LIST_RETRY_INTERVAL = 1000;');
    });
});

// ---------------------------------------------------------------------------
// Test suite: parseNumericEnv validation — invalid inputs
// ---------------------------------------------------------------------------

describe('build-userscript.js — parseNumericEnv rejects invalid values', () => {
    test('non-numeric string causes exit code 1', () => {
        const result = runBuild({ ZOOM_SCAN_INTERVAL: 'abc', SIGNING: undefined });
        expect(result.status).toBe(1);
    });

    test('negative number causes exit code 1', () => {
        const result = runBuild({ ZOOM_SCAN_INTERVAL: '-500', SIGNING: undefined });
        expect(result.status).toBe(1);
    });

    test('float value causes exit code 1 (strict integer required)', () => {
        const result = runBuild({ ZOOM_SCAN_INTERVAL: '1.5', SIGNING: undefined });
        expect(result.status).toBe(1);
    });

    test('zero causes exit code 1 (must be positive)', () => {
        const result = runBuild({ ZOOM_SCAN_INTERVAL: '0', SIGNING: undefined });
        expect(result.status).toBe(1);
    });

    test('error message mentions the variable name when it fails', () => {
        const result = runBuild({ ZOOM_SCAN_INTERVAL: 'bad', SIGNING: undefined });
        expect(result.stderr).toContain('ZOOM_SCAN_INTERVAL');
    });

    test('empty string causes exit code 1', () => {
        const result = runBuild({ ZOOM_SPAM_COOLDOWN_MS: '', SIGNING: undefined });
        expect(result.status).toBe(1);
    });

    test('whitespace-only value causes exit code 1', () => {
        const result = runBuild({ ZOOM_LIST_RETRY_INTERVAL: '   ', SIGNING: undefined });
        expect(result.status).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// Test suite: ZOOM_SPAM_PATTERNS override
// ---------------------------------------------------------------------------

describe('build-userscript.js — ZOOM_SPAM_PATTERNS override', () => {
    test('custom comma-separated patterns are injected into built output', () => {
        const result = runBuild({
            ZOOM_SPAM_PATTERNS: 'buyitnow,earnfastcash',
            SIGNING: undefined,
        });
        expect(result.status).toBe(0);
        const dist = readDist();
        expect(dist).toContain("'buyitnow'");
        expect(dist).toContain("'earnfastcash'");
    });

    test('custom patterns replace the defaults entirely', () => {
        const result = runBuild({
            ZOOM_SPAM_PATTERNS: 'onlythisone',
            SIGNING: undefined,
        });
        expect(result.status).toBe(0);
        const dist = readDist();
        expect(dist).toContain("'onlythisone'");
        // Default patterns should NOT appear since they were replaced
        expect(dist).not.toContain("'discord.gg'");
    });

    test('empty ZOOM_SPAM_PATTERNS produces an empty array in built output', () => {
        const result = runBuild({
            ZOOM_SPAM_PATTERNS: '',
            SIGNING: undefined,
        });
        expect(result.status).toBe(0);
        const dist = readDist();
        // Patterns block should exist but be empty
        expect(dist).toContain('const SPAM_PATTERNS = [');
    });

    test('patterns with whitespace around commas are trimmed', () => {
        const result = runBuild({
            ZOOM_SPAM_PATTERNS: ' spamword1 , spamword2 ',
            SIGNING: undefined,
        });
        expect(result.status).toBe(0);
        const dist = readDist();
        expect(dist).toContain("'spamword1'");
        expect(dist).toContain("'spamword2'");
    });
});

// ---------------------------------------------------------------------------
// Test suite: GH_PAT / signing validation
// ---------------------------------------------------------------------------

describe('build-userscript.js — signing validation', () => {
    test('SIGNING=1 without GH_PAT exits with code 1', () => {
        const result = runBuild({ SIGNING: '1', GH_PAT: undefined });
        expect(result.status).toBe(1);
    });

    test('SIGNING=1 without GH_PAT prints descriptive error', () => {
        const result = runBuild({ SIGNING: '1', GH_PAT: undefined });
        expect(result.stderr).toContain('GH_PAT');
        expect(result.stderr).toContain('SIGNING');
    });

    test('SIGNING=1 with empty GH_PAT exits with code 1', () => {
        const result = runBuild({ SIGNING: '1', GH_PAT: '' });
        expect(result.status).toBe(1);
    });

    test('SIGNING=1 with whitespace-only GH_PAT exits with code 1', () => {
        const result = runBuild({ SIGNING: '1', GH_PAT: '   ' });
        expect(result.status).toBe(1);
    });

    test('SIGNING=1 with valid GH_PAT succeeds', () => {
        const result = runBuild({ SIGNING: '1', GH_PAT: 'ghp_faketoken12345' });
        expect(result.status).toBe(0);
    });

    test('SIGNING=1 with valid GH_PAT logs validated message to stdout', () => {
        const result = runBuild({ SIGNING: '1', GH_PAT: 'ghp_faketoken12345' });
        expect(result.stdout).toContain('validated');
    });

    test('SIGNING=true with valid GH_PAT succeeds', () => {
        const result = runBuild({ SIGNING: 'true', GH_PAT: 'ghp_faketoken12345' });
        expect(result.status).toBe(0);
    });

    test('GH_PAT is not embedded in the built output', () => {
        const pat = 'ghp_secrettoken_shouldnotappear';
        const result = runBuild({ SIGNING: '1', GH_PAT: pat });
        expect(result.status).toBe(0);
        const dist = readDist();
        expect(dist).not.toContain(pat);
    });

    test('without SIGNING env var build succeeds without GH_PAT', () => {
        const result = runBuild({ SIGNING: undefined, GH_PAT: undefined });
        expect(result.status).toBe(0);
    });

    test('SIGNING=0 does not require GH_PAT', () => {
        const result = runBuild({ SIGNING: '0', GH_PAT: undefined });
        expect(result.status).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// Test suite: Doppler marker presence in built output
// ---------------------------------------------------------------------------

describe('build-userscript.js — Doppler config block preservation', () => {
    beforeAll(() => {
        runBuild({ SIGNING: undefined });
    });

    test('dist file retains @@DOPPLER_CONFIG_START sentinel', () => {
        const dist = readDist();
        expect(dist).toContain('// @@DOPPLER_CONFIG_START');
    });

    test('dist file retains @@DOPPLER_CONFIG_END sentinel', () => {
        const dist = readDist();
        expect(dist).toContain('// @@DOPPLER_CONFIG_END');
    });

    test('START marker appears before END marker in built output', () => {
        const dist = readDist();
        const start = dist.indexOf('// @@DOPPLER_CONFIG_START');
        const end   = dist.indexOf('// @@DOPPLER_CONFIG_END');
        expect(start).toBeLessThan(end);
    });

    test('code outside the config block is unchanged', () => {
        const src  = fs.readFileSync(SRC_FILE, 'utf8');
        const dist = readDist();
        // The UserScript header should appear verbatim in the dist file
        expect(dist).toContain('// ==UserScript==');
        // The IIFE wrapper should be present
        expect(dist).toContain('(function ()');
        expect(dist).toContain('})();');
    });
});

// ---------------------------------------------------------------------------
// Test suite: output readability and validity
// ---------------------------------------------------------------------------

describe('build-userscript.js — output file validity', () => {
    beforeAll(() => {
        runBuild({ SIGNING: undefined });
    });

    test('built file is non-empty', () => {
        const dist = readDist();
        expect(dist.length).toBeGreaterThan(1000);
    });

    test('built file is valid UTF-8 text (no binary content)', () => {
        const dist = readDist();
        expect(Buffer.from(dist, 'utf8').toString('utf8')).toBe(dist);
    });

    test('built file contains the Tampermonkey @name metadata', () => {
        const dist = readDist();
        expect(dist).toContain('@name');
        expect(dist).toContain('Zoom');
    });

    test('built file contains the SELECTORS object', () => {
        const dist = readDist();
        expect(dist).toContain('const SELECTORS =');
    });

    test('built file contains all major function definitions', () => {
        const dist = readDist();
        expect(dist).toContain('function resolve(');
        expect(dist).toContain('function resolveAll(');
        expect(dist).toContain('function getParticipantKey(');
        expect(dist).toContain('async function checkMultipinStatus(');
        expect(dist).toContain('async function grantMultipin(');
        expect(dist).toContain('function scanParticipants');
        expect(dist).toContain('function monitorChat(');
        expect(dist).toContain('function createDebugPanel(');
        expect(dist).toContain('function watchParticipantList(');
    });
});