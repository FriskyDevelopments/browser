#!/usr/bin/env node
/**
 * Build script for zoom-host-tools.user.js
 *
 * Reads the source userscript (scripts/zoom-host-tools.user.js), replaces the
 * configuration block delimited by @@DOPPLER_CONFIG_START / @@DOPPLER_CONFIG_END
 * with values injected from environment variables (populated by Doppler at build
 * time), and writes the distributable copy to dist/zoom-host-tools.user.js.
 *
 * Usage:
 *   doppler run -- npm run build      # inject secrets from Doppler
 *   npm run build                     # use environment variables already set
 *   node scripts/build-userscript.js  # same as above
 *
 * Environment variables consumed (all optional — defaults mirror the source):
 *   ZOOM_DEBUG_MODE            boolean  "true" / "false"   (default: false)
 *   ZOOM_SCAN_INTERVAL         number   ms                 (default: 2000)
 *   ZOOM_SPAM_COOLDOWN_MS      number   ms                 (default: 10000)
 *   ZOOM_LIST_RETRY_INTERVAL   number   ms                 (default: 2000)
 *   ZOOM_SPAM_PATTERNS         string   comma-separated    (default: built-in list)
 *
 * Credentials (injected by Doppler; not embedded in the built output):
 *   GH_PAT                     string   GitHub Personal Access Token with repo write
 *                                       access on the remote signatures repository
 *                                       (lightpanda-io/cla). Required for CLA signing.
 *                                       Validated at build time so CI fails fast if
 *                                       missing; not written into dist/.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// Paths
// ─────────────────────────────────────────────────────────────────────────────

const ROOT       = path.resolve(__dirname, '..');
const SRC        = path.join(ROOT, 'scripts', 'zoom-host-tools.user.js');
const DIST_DIR   = path.join(ROOT, 'dist');
const DIST_FILE  = path.join(DIST_DIR, 'zoom-host-tools.user.js');

// ─────────────────────────────────────────────────────────────────────────────
// Read configuration from environment (Doppler-injected or manually set)
// ─────────────────────────────────────────────────────────────────────────────

const DEBUG_MODE          = process.env.ZOOM_DEBUG_MODE          !== undefined
    ? process.env.ZOOM_DEBUG_MODE.trim().toLowerCase() === 'true'
    : false;

// Helper to parse and validate numeric env vars
function parseNumericEnv(name, defaultValue) {
    if (process.env[name] === undefined) {
        return defaultValue;
    }
    const raw = process.env[name].trim();
    // Validate strict integer format
    if (!/^\d+$/.test(raw)) {
        console.error(`build-userscript: invalid value for ${name}: "${raw}" (must be a positive integer)`);
        process.exit(1);
    }
    const value = parseInt(raw, 10);
    if (!Number.isFinite(value) || value <= 0) {
        console.error(`build-userscript: invalid value for ${name}: "${value}" (must be a positive integer)`);
        process.exit(1);
    }
    return value;
}

const SCAN_INTERVAL       = parseNumericEnv('ZOOM_SCAN_INTERVAL', 2000);
const SPAM_COOLDOWN_MS    = parseNumericEnv('ZOOM_SPAM_COOLDOWN_MS', 10000);
const LIST_RETRY_INTERVAL = parseNumericEnv('ZOOM_LIST_RETRY_INTERVAL', 2000);

const SPAM_PATTERNS = process.env.ZOOM_SPAM_PATTERNS !== undefined
    ? process.env.ZOOM_SPAM_PATTERNS.split(',').map(s => s.trim()).filter(Boolean)
    : ['http://', 'https://', 't.me', 'bit.ly', 'discord.gg'];

// ─────────────────────────────────────────────────────────────────────────────
// Validate credentials (GH_PAT)
//
// GH_PAT is only required when signing is explicitly enabled via the SIGNING
// environment variable. When SIGNING=1, the build will fail fast if GH_PAT is
// missing. GH_PAT is intentionally NOT embedded in the output script — it is
// only validated here at build time for signing workflows.
// ─────────────────────────────────────────────────────────────────────────────

const signingEnabled = process.env.SIGNING === '1' || process.env.SIGNING === 'true';

if (signingEnabled) {
    const GH_PAT = process.env.GH_PAT;
    if (!GH_PAT || GH_PAT.trim() === '') {
        console.error('build-userscript: SIGNING is enabled but GH_PAT environment variable is not set.');
        console.error('  Set it via Doppler (doppler secrets set GH_PAT) or export it manually.');
        console.error('  The token needs repo write access on the remote signatures repository (lightpanda-io/cla).');
        console.error('  To build without signing, omit the SIGNING environment variable.');
        process.exit(1);
    }
    console.log('build-userscript: signing mode enabled — GH_PAT validated');
}

// ─────────────────────────────────────────────────────────────────────────────
// Build the replacement config block
// ─────────────────────────────────────────────────────────────────────────────

const spamPatternsLiteral = SPAM_PATTERNS
    .map(p => `        '${p.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`)
    .join(',\n');

const configBlock = `\
    // @@DOPPLER_CONFIG_START
    const DEBUG_MODE = ${DEBUG_MODE};
    const SCAN_INTERVAL = ${SCAN_INTERVAL};       // milliseconds between participant poll scans
    const SPAM_COOLDOWN_MS = ${SPAM_COOLDOWN_MS};   // minimum ms between spam logs for the same sender
    const LIST_RETRY_INTERVAL = ${LIST_RETRY_INTERVAL}; // ms between retries waiting for participant list container

    // Spam patterns detected by the chat monitor
    const SPAM_PATTERNS = [
${spamPatternsLiteral},
    ];
    // @@DOPPLER_CONFIG_END`;

// ─────────────────────────────────────────────────────────────────────────────
// Replace the config block in the source
// ─────────────────────────────────────────────────────────────────────────────

const source = fs.readFileSync(SRC, 'utf8');

const START_MARKER = '    // @@DOPPLER_CONFIG_START';
const END_MARKER   = '    // @@DOPPLER_CONFIG_END';

const startIdx = source.indexOf(START_MARKER);
const endIdx   = source.indexOf(END_MARKER);

if (startIdx === -1 || endIdx === -1) {
    console.error('build-userscript: could not find @@DOPPLER_CONFIG_START / @@DOPPLER_CONFIG_END markers in source file.');
    console.error('  Source file:', SRC);
    process.exit(1);
}

if (startIdx >= endIdx) {
    console.error('build-userscript: @@DOPPLER_CONFIG_START appears after @@DOPPLER_CONFIG_END — check source file.');
    process.exit(1);
}

const output =
    source.slice(0, startIdx) +
    configBlock +
    source.slice(endIdx + END_MARKER.length);

// ─────────────────────────────────────────────────────────────────────────────
// Write output
// ─────────────────────────────────────────────────────────────────────────────

if (!fs.existsSync(DIST_DIR)) {
    fs.mkdirSync(DIST_DIR, { recursive: true });
}

fs.writeFileSync(DIST_FILE, output, 'utf8');

console.log(`build-userscript: built successfully`);
console.log(`  source : ${SRC}`);
console.log(`  output : ${DIST_FILE}`);
console.log(`  config :`);
console.log(`    DEBUG_MODE          = ${DEBUG_MODE}`);
console.log(`    SCAN_INTERVAL       = ${SCAN_INTERVAL} ms`);
console.log(`    SPAM_COOLDOWN_MS    = ${SPAM_COOLDOWN_MS} ms`);
console.log(`    LIST_RETRY_INTERVAL = ${LIST_RETRY_INTERVAL} ms`);
console.log(`    SPAM_PATTERNS       = [${SPAM_PATTERNS.join(', ')}]`);
if (signingEnabled) {
    console.log(`  credentials :`);
    console.log(`    GH_PAT              = ******** (validated for signing)`);
} else {
    console.log(`  signing             : disabled (set SIGNING=1 to enable)`);
}
console.log(`\nInstall dist/zoom-host-tools.user.js in TamperMonkey to use the built script.`);