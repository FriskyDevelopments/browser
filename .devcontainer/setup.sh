#!/usr/bin/env bash
# Post-create setup script for the Zoom Host Automation Codespace.
# Installs the Doppler CLI so secrets can be injected into the userscript build.

set -euo pipefail

echo "==> Installing Doppler CLI"
# Official Doppler install script — https://docs.doppler.com/docs/install-cli
# Download, verify checksum, then execute

INSTALL_SCRIPT="/tmp/doppler-install-$$.sh"
EXPECTED_SHA256="c5c1dc687bf4b62e7c730444dd10bb7b90fbd41f3bf6a20fb79e3a67e2b51991"

# Download installer
if command -v curl >/dev/null 2>&1; then
    curl -Ls --tlsv1.2 --proto "=https" --retry 3 -o "$INSTALL_SCRIPT" https://cli.doppler.com/install.sh
elif command -v wget >/dev/null 2>&1; then
    wget -t 3 -qO "$INSTALL_SCRIPT" https://cli.doppler.com/install.sh
else
    echo "ERROR: Neither curl nor wget is available." >&2
    exit 1
fi

# Verify checksum
ACTUAL_SHA256=$(sha256sum "$INSTALL_SCRIPT" | awk '{print $1}')
if [ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]; then
    echo "ERROR: Doppler install script checksum verification failed!" >&2
    echo "  Expected: $EXPECTED_SHA256" >&2
    echo "  Got:      $ACTUAL_SHA256" >&2
    rm -f "$INSTALL_SCRIPT"
    exit 1
fi

# Execute verified installer
sh "$INSTALL_SCRIPT"
rm -f "$INSTALL_SCRIPT"

echo "==> Doppler version: $(doppler --version 2>&1 || echo 'not in PATH yet')"

echo ""
echo "Setup complete."
echo ""
echo "Next steps:"
echo "  1. Authenticate with Doppler:  doppler login"
echo "  2. Select the project:         doppler setup"
echo "  3. (Optional) Add GH_PAT to Doppler for signing builds:"
echo "       doppler secrets set GH_PAT"
echo "     Doppler will prompt for the token (keeps it out of shell history)."
echo "     Only required when SIGNING=1 is set during build."
echo "  4. Build the userscript:       npm run build"
echo "  5. Install the output:         TamperMonkey → install from dist/zoom-host-tools.user.js"