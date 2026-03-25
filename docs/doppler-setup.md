# Doppler Secret Management — Setup Guide

Nebulosa uses [Doppler](https://doppler.com) as its single source of truth for
all secrets and environment-specific configuration.  This guide explains:

- What secrets exist and why they are needed
- How to set up Doppler locally for development
- How the CI/CD pipeline integrates with Doppler
- How compiled userscripts are produced with injected config

---

## Table of Contents

1. [Why Doppler?](#1-why-doppler)
2. [Secret Inventory](#2-secret-inventory)
3. [Local Development Setup](#3-local-development-setup)
4. [Building Compiled Userscripts](#4-building-compiled-userscripts)
5. [CI/CD Integration](#5-cicd-integration)
6. [Adding or Rotating a Secret](#6-adding-or-rotating-a-secret)
7. [Fallback Without Doppler](#7-fallback-without-doppler)

---

## 1. Why Doppler?

Previously, secrets were scattered across:

- Hard-coded values in userscript `CONFIG` blocks
- GitHub Actions workflow environment variables pointing to repository secrets
- Undocumented `.env` files on individual developer machines

Doppler centralises all secrets in one dashboard, provides per-environment
configs (`dev`, `staging`, `production`), and injects values at runtime via
`doppler run -- <command>` — meaning secrets are never written to disk.

---

## 2. Secret Inventory

All secrets are documented in [`config/secrets.env.example`](../config/secrets.env.example).

| Variable | Consumed by | Notes |
|---|---|---|
| `ZOOM_HOST_DEBUG_MODE` | userscripts | `false` in production |
| `ZOOM_HOST_POLL_INTERVAL_MS` | userscripts | Default 2000 ms |
| `ZOOM_HOST_CHAT_POLL_INTERVAL_MS` | userscripts | Default 3000 ms |
| `ZOOM_HOST_ACTION_DELAY_MS` | userscripts | Default 500 ms |
| `ZOOM_HOST_MAX_MENU_RETRIES` | userscripts | Default 3 |
| `ZOOM_HOST_BOOTSTRAP_TIMEOUT_MS` | userscripts | Default 60000 ms |
| `ZOOM_HOST_LOG_MESSAGE_MAX_LENGTH` | userscripts | Default 80 chars |
| `ZOOM_HOST_WARN_BEFORE_ESCALATE` | userscripts | Moderation escalation threshold |
| `ZOOM_HOST_SPAM_WORDS` | userscripts | Comma-separated phrase list |
| `ZOOM_HOST_PHASE_RAISED_HAND` | userscripts | Feature flag for Phase 1 |
| `ZOOM_HOST_PHASE_CAMERA_CHECK` | userscripts | Feature flag for Phase 2 |
| `ZOOM_HOST_PHASE_CHAT_MOD` | userscripts | Feature flag for Phase 3 |
| `WBA_PRIVATE_KEY_PEM` | browser engine, CI | RSA private key (PEM) |
| `WBA_KEY_ID` | browser engine, CI | Key identifier string |
| `WBA_DOMAIN` | browser engine, CI | WBA domain |
| `AWS_ACCESS_KEY_ID` | CI | Nightly build artefact uploads |
| `AWS_SECRET_ACCESS_KEY` | CI | Nightly build artefact uploads |
| `AWS_BUCKET` | CI | S3 bucket name |
| `AWS_REGION` | CI | S3 region |
| `LIGHTPANDA_DISABLE_TELEMETRY` | browser engine | `true` in CI |
| `DOPPLER_SERVICE_TOKEN` | CI (GitHub secret) | Scoped Doppler token for `doppler run` |

---

## 3. Local Development Setup

### Step 1 — Install the Doppler CLI

```bash
# macOS
brew install dopplerhq/cli/doppler

# Debian / Ubuntu
apt-get install -y apt-transport-https
curl -sLf --retry 3 --tlsv1.2 --proto "=https" \
  'https://packages.doppler.com/public/cli/gpg.DE2A7741A397C129.key' \
  | gpg --dearmor -o /usr/share/keyrings/doppler-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/doppler-archive-keyring.gpg] \
  https://packages.doppler.com/public/cli/deb/debian any-version main" \
  | tee /etc/apt/sources.list.d/doppler-cli.list
apt-get update && apt-get install doppler
```

### Step 2 — Authenticate

```bash
doppler login
```

This opens a browser window where you sign in to your Doppler account.

### Step 3 — Link to the project

From the repository root:

```bash
doppler setup
# Select project:  nebulosa
# Select config:   dev
```

Doppler writes a `.doppler.yaml` file in your home directory (`~/.doppler/`) —
**not** the project-level `doppler.yaml` — so no credentials are ever committed.

### Step 4 — Verify

```bash
doppler secrets
```

You should see a table of all secrets for the selected config.

---

## 4. Building Compiled Userscripts

The source userscripts in `scripts/` contain sentinel comments that mark the
CONFIG block:

```javascript
// @@DOPPLER_CONFIG_START — values below are overwritten by scripts/build-userscript.js
const CONFIG = { ... };
// @@DOPPLER_CONFIG_END
```

Running the build script replaces the block with values drawn from environment
variables:

```bash
# Recommended: let Doppler inject secrets
doppler run -- npm run build
# or
npm run build:doppler

# Development shortcut (reads .env if present):
npm run build

# Explicit environment target:
npm run build:prod
```

Compiled scripts are written to `dist/`:

```
dist/
  zoom-host-tools.user.js
  zoom-host-automation.user.js
```

> **Install from `dist/`, not `scripts/`.**
> The files in `scripts/` are the development source; `dist/` files have the
> correct values for your deployment environment.

---

## 5. CI/CD Integration

The workflow [`.github/workflows/doppler-build.yml`](../.github/workflows/doppler-build.yml)
automatically builds compiled userscripts on every push to `main` and on pull
requests that touch `scripts/`, `selectors/`, `config/`, `doppler.yaml`, or `package.json`.

### Required repository secret

| Secret name | Description |
|---|---|
| `DOPPLER_SERVICE_TOKEN` | A Doppler [service token](https://docs.doppler.com/docs/service-tokens) scoped to the desired config (e.g. `production`). |

Create the token in the Doppler dashboard:
**Workplace → Projects → nebulosa → Configs → production → Access → Generate Service Token**

Then add it to the GitHub repository:
**Settings → Secrets and variables → Actions → New repository secret**

### What the workflow does

1. Checks out the repository
2. Installs Node.js dependencies
3. Installs the Doppler CLI
4. Runs `doppler run -- npm run build` using the service token
5. Uploads `dist/*.user.js` as a workflow artefact (retained for 30 days)

---

## 6. Adding or Rotating a Secret

### Add a new secret

1. Open the Doppler dashboard for the `nebulosa` project.
2. Add the secret to **all** relevant configs (`dev`, `staging`, `production`).
3. Update `config/secrets.env.example` with the new variable, its description,
   and a safe placeholder value.
4. Update `scripts/build-userscript.js` to read the new variable and inject it
   into the appropriate output.
5. Add the variable to the table in this document.
6. Open a pull request; the `doppler-build` workflow will validate the change.

### Rotate an existing secret

1. Generate the new value in the relevant service (AWS, Zoom, etc.).
2. Update the value in the Doppler dashboard for all configs.
3. If it is also stored as a GitHub Actions secret (e.g. `DOPPLER_SERVICE_TOKEN`),
   update that as well.
4. Verify that the `doppler-build` workflow passes after the rotation.

---

## 7. Fallback Without Doppler

If you do not have Doppler access (e.g. external contributors running tests
locally), you can still build the userscripts using a plain `.env` file:

```bash
cp config/secrets.env.example .env
# Open .env and fill in the values relevant to your setup
npm run build
```

> ⚠️  Never commit your `.env` file.  It is listed in `.gitignore`.

The build script automatically detects whether Doppler is active (by checking
`DOPPLER_PROJECT`) and falls back to `.env` / the existing process environment
when it is not.
