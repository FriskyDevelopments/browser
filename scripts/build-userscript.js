#!/usr/bin/env node
/**
 * scripts/build-userscript.js
 *
 * Reads runtime configuration from environment variables (populated by Doppler
 * via `doppler run -- node scripts/build-userscript.js`, or from a local .env
 * file for development) and produces compiled userscripts under dist/.
 *
 * The compiled scripts are identical to their source counterparts except that
 * the CONFIG block is replaced with values drawn from the environment so that
 * sensitive or deployment-specific settings are never hard-coded in source.
 *
 * Usage:
 *   # With Doppler (recommended):
 *   doppler run -- node scripts/build-userscript.js
 *
 *   # With a local .env file (development only):
 *   cp config/secrets.env.example .env
 *   # fill in values, then:
 *   node scripts/build-userscript.js
 *
 *   # Via npm scripts:
 *   npm run build            # uses .env if present
 *   npm run build:doppler    # wraps with doppler run
 *   npm run build:prod       # NODE_ENV=production
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Load .env only when Doppler has NOT already injected the variables we need.
// Doppler sets DOPPLER_PROJECT / DOPPLER_CONFIG when running via `doppler run`.
// When those are absent we fall back to dotenv so local development still works.
// ---------------------------------------------------------------------------
if (!process.env.DOPPLER_PROJECT) {
  const envPath = path.resolve(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    try {
      // Use dotenv if installed; otherwise parse manually so the script works
      // in a freshly cloned repo before `npm install` has been run.
      require('dotenv').config({ path: envPath });
    } catch {
      parseDotenvFallback(envPath);
    }
  }
}

// ---------------------------------------------------------------------------
// Helper — minimal .env parser used when dotenv is unavailable
// ---------------------------------------------------------------------------
function parseDotenvFallback(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key   = trimmed.slice(0, eqIdx).trim();
    let value   = trimmed.slice(eqIdx + 1).trim();
    // Strip matching surrounding quotes ("value" or 'value')
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && !(key in process.env)) {
      process.env[key] = value;
    }
  }
}

// ---------------------------------------------------------------------------
// Configuration — read from environment variables with safe defaults
// ---------------------------------------------------------------------------

/**
 * Read an env variable and return its value, or `defaultValue` if unset/empty.
 * @param {string} name
 * @param {string} defaultValue
 * @returns {string}
 */
function env(name, defaultValue) {
  const val = process.env[name];
  return val !== undefined && val !== '' ? val : defaultValue;
}

/**
 * Parse a boolean env variable.
 * Accepts "true"/"1"/"yes" as truthy (case-insensitive); everything else falsy.
 * @param {string} name
 * @param {boolean} defaultValue
 * @returns {boolean}
 */
function envBool(name, defaultValue) {
  const val = process.env[name];
  if (val === undefined || val === '') return defaultValue;
  return /^(true|1|yes)$/i.test(val.trim());
}

/**
 * Parse a numeric env variable.
 * @param {string} name
 * @param {number} defaultValue
 * @returns {number}
 */
function envInt(name, defaultValue) {
  const val = process.env[name];
  if (val === undefined || val === '') return defaultValue;
  const n = parseInt(val, 10);
  return Number.isFinite(n) ? n : defaultValue;
}

/**
 * Parse a comma-separated env variable into a JSON array literal.
 * @param {string} name
 * @param {string[]} defaultValue
 * @returns {string}  JSON representation of the array
 */
function envArray(name, defaultValue) {
  const val = process.env[name];
  if (val === undefined || val === '') return JSON.stringify(defaultValue);
  const items = val.split(',').map((s) => s.trim()).filter(Boolean);
  return JSON.stringify(items);
}

// ---------------------------------------------------------------------------
// Resolved configuration values
// ---------------------------------------------------------------------------

const cfg = {
  debugMode:          envBool('ZOOM_HOST_DEBUG_MODE',              false),
  pollIntervalMs:     envInt ('ZOOM_HOST_POLL_INTERVAL_MS',         2000),
  chatPollIntervalMs: envInt ('ZOOM_HOST_CHAT_POLL_INTERVAL_MS',    3000),
  actionDelayMs:      envInt ('ZOOM_HOST_ACTION_DELAY_MS',           500),
  maxMenuRetries:     envInt ('ZOOM_HOST_MAX_MENU_RETRIES',            3),
  bootstrapTimeoutMs: envInt ('ZOOM_HOST_BOOTSTRAP_TIMEOUT_MS',    60000),
  logMessageMaxLength:envInt ('ZOOM_HOST_LOG_MESSAGE_MAX_LENGTH',      80),
  warnBeforeEscalate: envInt ('ZOOM_HOST_WARN_BEFORE_ESCALATE',        2),
  spamWords:          envArray('ZOOM_HOST_SPAM_WORDS',
                               ['buy now','click here','free money','earn cash','discount code']),
  phases: {
    raisedHand:  envBool('ZOOM_HOST_PHASE_RAISED_HAND',  true),
    cameraCheck: envBool('ZOOM_HOST_PHASE_CAMERA_CHECK', true),
    chatMod:     envBool('ZOOM_HOST_PHASE_CHAT_MOD',     true),
  },
};

// ---------------------------------------------------------------------------
// Source → output mappings
// Each entry has:
//   src    – path to the source userscript (relative to repo root)
//   out    – path for the compiled output  (relative to repo root)
//   inject – function that takes source text and returns transformed text
// ---------------------------------------------------------------------------

const ROOT = path.resolve(__dirname, '..');

/**
 * Replace the CONFIG block inside zoom-host-tools.user.js.
 * The block is delimited by the sentinel comments:
 *   // @@DOPPLER_CONFIG_START
 *   // @@DOPPLER_CONFIG_END
 *
 * @param {string} source
 * @returns {string}
 */
function injectHostToolsConfig(source) {
  const injected = `\
  // @@DOPPLER_CONFIG_START — generated by scripts/build-userscript.js, do not edit
  const DEBUG_MODE         = ${cfg.debugMode};
  const POLL_INTERVAL_MS   = ${cfg.pollIntervalMs};
  const ACTION_DELAY_MS    = ${cfg.actionDelayMs};
  const MAX_MENU_RETRIES   = ${cfg.maxMenuRetries};
  // @@DOPPLER_CONFIG_END`;

  return replaceBetweenSentinels(source, '@@DOPPLER_CONFIG_START', '@@DOPPLER_CONFIG_END', injected);
}

/**
 * Replace the CONFIG block inside zoom-host-automation.user.js.
 *
 * @param {string} source
 * @returns {string}
 */
function injectAutomationConfig(source) {
  const injected = `\
  // @@DOPPLER_CONFIG_START — generated by scripts/build-userscript.js, do not edit
  const CONFIG = {
    pollIntervalMs:      ${cfg.pollIntervalMs},
    chatPollIntervalMs:  ${cfg.chatPollIntervalMs},
    spamWords:           ${cfg.spamWords},
    linkPattern:         /https?:\\/\\/\\S+/i,
    warnBeforeEscalate:  ${cfg.warnBeforeEscalate},
    logMessageMaxLength: ${cfg.logMessageMaxLength},
    bootstrapTimeoutMs:  ${cfg.bootstrapTimeoutMs},
    phases: {
      raisedHand:  ${cfg.phases.raisedHand},
      cameraCheck: ${cfg.phases.cameraCheck},
      chatMod:     ${cfg.phases.chatMod},
    },
  };
  // @@DOPPLER_CONFIG_END`;

  return replaceBetweenSentinels(source, '@@DOPPLER_CONFIG_START', '@@DOPPLER_CONFIG_END', injected);
}

// ---------------------------------------------------------------------------
// Core replacement utility
// ---------------------------------------------------------------------------

/**
 * Replace all text between two sentinel-comment lines (inclusive) with
 * `replacement`.  Throws if either sentinel is missing.
 *
 * @param {string} source
 * @param {string} startTag   Text contained in the opening sentinel comment
 * @param {string} endTag     Text contained in the closing sentinel comment
 * @param {string} replacement
 * @returns {string}
 */
function replaceBetweenSentinels(source, startTag, endTag, replacement) {
  // Match from the first line containing startTag to the first line containing
  // endTag (inclusive), across multiple lines.
  const pattern = new RegExp(
    `[^\\n]*${escapeRegex(startTag)}[^\\n]*\\n[\\s\\S]*?[^\\n]*${escapeRegex(endTag)}[^\\n]*`,
    'm',
  );

  if (!pattern.test(source)) {
    throw new Error(
      `Sentinel comments not found in source.\n` +
      `Expected lines containing "${startTag}" and "${endTag}".\n` +
      `Add them to the CONFIG section of the userscript before running this build script.`,
    );
  }

  return source.replace(pattern, replacement);
}

/**
 * Escape a string for use inside a RegExp literal.
 * @param {string} s
 * @returns {string}
 */
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Build pipeline
// ---------------------------------------------------------------------------

const TARGETS = [
  {
    src:    'scripts/zoom-host-tools.user.js',
    out:    'dist/zoom-host-tools.user.js',
    inject: injectHostToolsConfig,
  },
  {
    src:    'scripts/zoom-host-automation.user.js',
    out:    'dist/zoom-host-automation.user.js',
    inject: injectAutomationConfig,
  },
];

function build() {
  const source = process.env.DOPPLER_PROJECT
    ? `Doppler (project=${process.env.DOPPLER_PROJECT}, config=${process.env.DOPPLER_CONFIG})`
    : '.env file / process environment';

  console.log(`\n🔑  Config source : ${source}`);
  console.log(`🌍  NODE_ENV      : ${process.env.NODE_ENV || '(not set)'}\n`);

  const distDir = path.join(ROOT, 'dist');
  if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
  }

  let hasError = false;

  for (const target of TARGETS) {
    const srcPath = path.join(ROOT, target.src);
    const outPath = path.join(ROOT, target.out);

    try {
      const source = fs.readFileSync(srcPath, 'utf8');
      const output = target.inject(source);
      fs.writeFileSync(outPath, output, 'utf8');
      console.log(`✅  ${target.src} → ${target.out}`);
    } catch (err) {
      console.error(`❌  ${target.src}: ${err.message}`);
      hasError = true;
    }
  }

  if (hasError) {
    console.error('\n⚠️  Build completed with errors.');
    process.exitCode = 1;
  } else {
    console.log('\n🎉  Build complete.  Install the scripts from the dist/ directory.');
  }
}

build();
