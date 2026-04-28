#!/usr/bin/env bash
set -euo pipefail

CLAWPILOT_DIR="$(cd "$(dirname "$0")" && pwd)"
COPILOT_EXT_DIR="${HOME}/.copilot/extensions"
CLAWPILOT_STATE="${HOME}/.clawpilot"

EXTENSIONS=(spawn scheduler heartbeat channels daemon orchestrator memory-db vault fallback)

echo "🦞 Clawpilot CLI — Installing extensions"
echo ""

# Check copilot is installed
if ! command -v copilot &>/dev/null; then
    echo "❌ Copilot CLI not found. Install it first:"
    echo "   curl -fsSL https://gh.io/copilot-install | bash"
    exit 1
fi

echo "✅ Copilot CLI found: $(copilot --version 2>/dev/null || echo 'unknown version')"

# Create state directories
mkdir -p "${CLAWPILOT_STATE}"/{spawned,heartbeat,vault,logs}
echo "✅ State directory: ${CLAWPILOT_STATE}"

# Create copilot extensions directory if needed
mkdir -p "${COPILOT_EXT_DIR}"

# Install each extension
installed=0
skipped=0
for ext in "${EXTENSIONS[@]}"; do
    src="${CLAWPILOT_DIR}/extensions/${ext}/extension.mjs"
    dest_dir="${COPILOT_EXT_DIR}/clawpilot-${ext}"

    if [ ! -f "$src" ]; then
        echo "⏭️  ${ext} — not yet built, skipping"
        skipped=$((skipped + 1))
        continue
    fi

    # Copy the extension file directly
    # Updates require re-running install.sh
    mkdir -p "$dest_dir"
    cp "$src" "${dest_dir}/extension.mjs"

    echo "✅ ${ext} → ${dest_dir}"
    installed=$((installed + 1))
done

echo ""
echo "🦞 Installed ${installed} extensions (${skipped} skipped)"
echo ""
echo "Restart Copilot CLI or run /clear to load extensions."
echo "State directory: ${CLAWPILOT_STATE}"
