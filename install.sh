#!/usr/bin/env bash
set -euo pipefail

CLAWPILOT_DIR="$(cd "$(dirname "$0")" && pwd)"
COPILOT_EXT_DIR="${HOME}/.copilot/extensions"
CLAWPILOT_STATE="${HOME}/.clawpilot"

EXTENSIONS=(spawn scheduler heartbeat channels daemon orchestrator memory-db vault fallback)

echo "🦞 Clawpilot CLI — Installing extensions"
echo ""

# Check copilot is installed — auto-install if missing
if ! command -v copilot &>/dev/null; then
    echo "📦 Copilot CLI not found — installing..."
    if command -v curl &>/dev/null; then
        curl -fsSL https://gh.io/copilot-install | bash
    elif command -v wget &>/dev/null; then
        wget -qO- https://gh.io/copilot-install | bash
    else
        echo "❌ Neither curl nor wget found. Install Copilot CLI manually:"
        echo "   curl -fsSL https://gh.io/copilot-install | bash"
        exit 1
    fi

    # Verify installation succeeded
    if ! command -v copilot &>/dev/null; then
        # Check common install locations
        for p in "${HOME}/.local/bin/copilot" "/usr/local/bin/copilot"; do
            if [ -x "$p" ]; then
                export PATH="$(dirname "$p"):$PATH"
                break
            fi
        done
    fi

    if ! command -v copilot &>/dev/null; then
        echo "❌ Copilot CLI installation failed. Install manually:"
        echo "   curl -fsSL https://gh.io/copilot-install | bash"
        exit 1
    fi
    echo "✅ Copilot CLI installed: $(copilot --version 2>/dev/null || echo 'unknown')"
else
    echo "✅ Copilot CLI found: $(copilot --version 2>/dev/null || echo 'unknown version')"
fi

# Check optional dependencies
MISSING_OPTIONAL=()
command -v sqlite3 &>/dev/null || MISSING_OPTIONAL+=("sqlite3 (for memory-db)")
command -v age &>/dev/null     || MISSING_OPTIONAL+=("age (for vault)")
command -v jq &>/dev/null      || MISSING_OPTIONAL+=("jq (for daemon)")

if [ ${#MISSING_OPTIONAL[@]} -gt 0 ]; then
    echo ""
    echo "ℹ️  Optional dependencies not found:"
    for dep in "${MISSING_OPTIONAL[@]}"; do
        echo "   • $dep"
    done
    echo "   Install with: sudo apt install sqlite3 age jq"
fi

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

# Install clawpilot launcher
LAUNCHER="${CLAWPILOT_DIR}/clawpilot.sh"
BIN_DIR="${HOME}/.local/bin"
if [ -f "$LAUNCHER" ]; then
    mkdir -p "$BIN_DIR"
    ln -sf "$LAUNCHER" "${BIN_DIR}/clawpilot"
    echo "✅ Launcher: ${BIN_DIR}/clawpilot"
    if ! echo "$PATH" | grep -q "${BIN_DIR}"; then
        echo "   ℹ️  Add to PATH: export PATH=\"${BIN_DIR}:\$PATH\""
    fi
fi

echo ""
echo "Restart Copilot CLI or run /clear to load extensions."
echo "State directory: ${CLAWPILOT_STATE}"
echo ""
echo "Usage:"
echo "  copilot          # Normal Copilot CLI (new session each time)"
echo "  clawpilot        # Always resumes 'main' session (persistent)"
