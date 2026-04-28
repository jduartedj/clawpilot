#!/usr/bin/env bash
set -euo pipefail

CLAWPILOT_DIR="$(cd "$(dirname "$0")" && pwd)"
COPILOT_EXT_DIR="${HOME}/.copilot/extensions"
CLAWPILOT_STATE="${HOME}/.clawpilot"

EXTENSIONS=(spawn scheduler heartbeat channels daemon gateway orchestrator memory-db vault fallback)

echo "🦞 Clawpilot CLI — Installing extensions"
echo ""

# Non-interactive shells may not have the user's local bin directory on PATH.
for p in "${HOME}/.local/bin/copilot" "/usr/local/bin/copilot"; do
    if ! command -v copilot &>/dev/null && [ -x "$p" ]; then
        export PATH="$(dirname "$p"):$PATH"
    fi
done

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

if [ ${#MISSING_OPTIONAL[@]} -gt 0 ]; then
    echo ""
    echo "ℹ️  Optional dependencies not found:"
    for dep in "${MISSING_OPTIONAL[@]}"; do
        echo "   • $dep"
    done
    echo "   Install with: sudo apt install sqlite3 age"
fi

# Create state directories with restrictive permissions
mkdir -p "${CLAWPILOT_STATE}"/{spawned,heartbeat,vault,logs,scheduler,channels,orchestrator,inbox,processed,history,scripts,gateway}
chmod 700 "${CLAWPILOT_STATE}" "${CLAWPILOT_STATE}"/{spawned,heartbeat,vault,logs,scheduler,channels,orchestrator,inbox,processed,history,scripts,gateway}
echo "✅ State directory: ${CLAWPILOT_STATE} (0700)"

# Create copilot extensions directory if needed
mkdir -p "${COPILOT_EXT_DIR}"

# Install shared extension libraries used by multiple Clawpilot extensions.
if [ -d "${CLAWPILOT_DIR}/extensions/_lib" ]; then
    rm -rf "${COPILOT_EXT_DIR}/_lib"
    mkdir -p "${COPILOT_EXT_DIR}/_lib"
    cp -R "${CLAWPILOT_DIR}/extensions/_lib/." "${COPILOT_EXT_DIR}/_lib/"
    echo "✅ shared libs → ${COPILOT_EXT_DIR}/_lib"
fi

# Migrate existing daemon installs from the legacy bash/jq handler to the
# shared Node handler. The daemon extension remains the source of truth for
# unit contents, so a temporary Copilot session is not needed for upgrades.
DAEMON_SERVICE="${HOME}/.config/systemd/user/clawpilot-daemon.service"
DAEMON_PATH="${HOME}/.config/systemd/user/clawpilot-daemon.path"
DAEMON_HANDLER="${COPILOT_EXT_DIR}/_lib/daemon-handler.mjs"
if [ -f "$DAEMON_SERVICE" ] && [ -f "$DAEMON_HANDLER" ]; then
    mkdir -p "$(dirname "$DAEMON_SERVICE")"
    cat > "$DAEMON_SERVICE" <<EOF
[Unit]
Description=Clawpilot inbox handler

[Service]
Type=oneshot
KillMode=process
ExecStart=/usr/bin/env node ${DAEMON_HANDLER}
Environment=HOME=${HOME}
Environment=PATH=${PATH}
StandardOutput=journal
StandardError=journal
EOF
    cat > "$DAEMON_PATH" <<EOF
[Unit]
Description=Clawpilot inbox watcher

[Path]
PathExistsGlob=${CLAWPILOT_STATE}/inbox/*.json
MakeDirectory=yes

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload 2>/dev/null || true
    if systemctl --user is-enabled clawpilot-daemon.path >/dev/null 2>&1; then
        systemctl --user restart clawpilot-daemon.path 2>/dev/null || true
    fi
    echo "✅ daemon unit migrated to Node handler"
fi

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
    if [ "$ext" = "gateway" ] && [ -f "${CLAWPILOT_DIR}/extensions/gateway/server-entry.mjs" ]; then
        cp "${CLAWPILOT_DIR}/extensions/gateway/server-entry.mjs" "${dest_dir}/server-entry.mjs"
    fi

    echo "✅ ${ext} → ${dest_dir}"
    installed=$((installed + 1))
done

if [ -f "${CLAWPILOT_DIR}/scripts/import-openclaw-agents.mjs" ]; then
    src_agent_sync="${CLAWPILOT_DIR}/scripts/import-openclaw-agents.mjs"
    dest_agent_sync="${CLAWPILOT_STATE}/scripts/import-openclaw-agents.mjs"
    if [ "$(readlink -f "$src_agent_sync")" != "$(readlink -f "$dest_agent_sync" 2>/dev/null || printf '%s' "$dest_agent_sync")" ]; then
        cp "$src_agent_sync" "$dest_agent_sync"
    fi
    chmod 700 "${CLAWPILOT_STATE}/scripts/import-openclaw-agents.mjs"
    if command -v node &>/dev/null; then
        node "${CLAWPILOT_STATE}/scripts/import-openclaw-agents.mjs" || true
    fi
fi

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
