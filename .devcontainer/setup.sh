#!/usr/bin/env bash
# Post-create setup script for the Zoom Host Automation Codespace.
# Installs the Doppler CLI so secrets can be injected into the userscript build.

set -euo pipefail

echo "==> Installing Doppler CLI"
# Official Doppler install script — https://docs.doppler.com/docs/install-cli
(curl -Ls --tlsv1.2 --proto "=https" --retry 3 https://cli.doppler.com/install.sh \
    || wget -t 3 -qO- https://cli.doppler.com/install.sh) | sh

echo "==> Doppler version: $(doppler --version 2>&1 || echo 'not in PATH yet')"

echo ""
echo "Setup complete."
echo ""
echo "Next steps:"
echo "  1. Authenticate with Doppler:  doppler login"
echo "  2. Select the project:         doppler setup"
echo "  3. Add GH_PAT to Doppler:      doppler secrets set GH_PAT <your-github-pat>"
echo "     (Required to write CLA signatures to the remote org repo — needs repo write access)"
echo "  4. Build the userscript:       doppler run -- npm run build"
echo "  5. Install the output:         TamperMonkey → install from dist/zoom-host-tools.user.js"
