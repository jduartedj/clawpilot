#!/usr/bin/env bash
set -euo pipefail

PILOTCLAW_DIR="$(cd "$(dirname "$0")" && pwd)"
COPILOT_EXT_DIR="${HOME}/.copilot/extensions"
PILOTCLAW_STATE="${HOME}/.pilotclaw"
LEGACY_STATE="${HOME}/.clawpilot"

EXTENSIONS=(spawn scheduler heartbeat channels daemon gateway orchestrator memory-db vault fallback)

echo "🦞 PilotClaw CLI — Installing extensions"
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

# Migrate pre-rename installs without deleting user state. Old Linux docs used
# ~/.clawpilot as both source checkout and state dir, so never move it when it
# looks like the repo currently running this installer.
copy_legacy_state() {
    mkdir -p "$PILOTCLAW_STATE"
    for item in spawned heartbeat vault logs scheduler channels orchestrator inbox processing processed history scripts gateway memory.db; do
        if [ -e "${LEGACY_STATE}/${item}" ] && [ ! -e "${PILOTCLAW_STATE}/${item}" ]; then
            cp -a "${LEGACY_STATE}/${item}" "${PILOTCLAW_STATE}/${item}" 2>/dev/null || true
        fi
    done
}

if [ -d "$LEGACY_STATE" ]; then
    if [ -f "${LEGACY_STATE}/install.sh" ] && [ -d "${LEGACY_STATE}/extensions" ]; then
        copy_legacy_state
        echo "✅ Copied legacy state from source checkout: ${LEGACY_STATE} → ${PILOTCLAW_STATE}"
    elif [ ! -e "$PILOTCLAW_STATE" ]; then
        mv "$LEGACY_STATE" "$PILOTCLAW_STATE"
        echo "✅ Migrated state: ${LEGACY_STATE} → ${PILOTCLAW_STATE}"
    else
        copy_legacy_state
        echo "✅ Preserved existing PilotClaw state; copied missing legacy files from ${LEGACY_STATE}"
    fi
fi

# Stop and remove pre-rename daemon/gateway units before installing PilotClaw units.
if command -v systemctl &>/dev/null; then
    for unit in clawpilot-gateway.service clawpilot-daemon.path clawpilot-daemon.service; do
        systemctl --user stop "$unit" 2>/dev/null || true
        systemctl --user disable "$unit" 2>/dev/null || true
        unit_file="${HOME}/.config/systemd/user/${unit}"
        if [ -f "$unit_file" ]; then
            rm "$unit_file"
            echo "✅ Removed legacy systemd unit: $unit"
        fi
    done
    systemctl --user daemon-reload 2>/dev/null || true
fi

# Rewrite pre-rename scheduled task units so existing timers keep working after
# state moves from ~/.clawpilot to ~/.pilotclaw.
SYSTEMD_USER_DIR="${HOME}/.config/systemd/user"
if [ -d "$SYSTEMD_USER_DIR" ]; then
    for unit_file in "$SYSTEMD_USER_DIR"/clawpilot-*.service "$SYSTEMD_USER_DIR"/clawpilot-*.timer; do
        [ -e "$unit_file" ] || continue
        base="$(basename "$unit_file")"
        case "$base" in
            clawpilot-daemon.*|clawpilot-gateway.*) continue ;;
        esac
        new_base="pilotclaw-${base#clawpilot-}"
        new_file="${SYSTEMD_USER_DIR}/${new_base}"
        was_enabled=false
        if [[ "$base" == *.timer ]] && systemctl --user is-enabled "$base" >/dev/null 2>&1; then
            was_enabled=true
            systemctl --user stop "$base" 2>/dev/null || true
            systemctl --user disable "$base" 2>/dev/null || true
        fi
        sed \
            -e 's/Clawpilot/PilotClaw/g' \
            -e 's/clawpilot/pilotclaw/g' \
            -e 's#\.clawpilot#\.pilotclaw#g' \
            "$unit_file" > "$new_file"
        rm "$unit_file"
        if [ "$was_enabled" = true ]; then
            systemctl --user enable --now "$new_base" 2>/dev/null || true
        fi
        echo "✅ Migrated scheduled unit: ${base} → ${new_base}"
    done
    systemctl --user daemon-reload 2>/dev/null || true
fi

# Create state directories with restrictive permissions
mkdir -p "${PILOTCLAW_STATE}"/{spawned,heartbeat,vault,logs,scheduler,channels,orchestrator,inbox,processing,processed,history,scripts,gateway}
chmod 700 "${PILOTCLAW_STATE}" "${PILOTCLAW_STATE}"/{spawned,heartbeat,vault,logs,scheduler,channels,orchestrator,inbox,processing,processed,history,scripts,gateway}
echo "✅ State directory: ${PILOTCLAW_STATE} (0700)"

# Create copilot extensions directory if needed
mkdir -p "${COPILOT_EXT_DIR}"

# Remove pre-rename extension directories so Copilot does not load duplicate tools.
for ext in "${EXTENSIONS[@]}"; do
    legacy_dest="${COPILOT_EXT_DIR}/clawpilot-${ext}"
    if [ -d "$legacy_dest" ]; then
        rm -rf "$legacy_dest"
        echo "✅ Removed legacy extension: clawpilot-${ext}"
    fi
done

# Install shared extension libraries used by multiple PilotClaw extensions.
if [ -d "${PILOTCLAW_DIR}/extensions/_lib" ]; then
    rm -rf "${COPILOT_EXT_DIR}/_lib"
    mkdir -p "${COPILOT_EXT_DIR}/_lib"
    cp -R "${PILOTCLAW_DIR}/extensions/_lib/." "${COPILOT_EXT_DIR}/_lib/"
    echo "✅ shared libs → ${COPILOT_EXT_DIR}/_lib"
fi

# Migrate existing daemon installs from the legacy bash/jq handler to the
# shared Node handler. The daemon extension remains the source of truth for
# unit contents, so a temporary Copilot session is not needed for upgrades.
DAEMON_SERVICE="${HOME}/.config/systemd/user/pilotclaw-daemon.service"
DAEMON_PATH="${HOME}/.config/systemd/user/pilotclaw-daemon.path"
DAEMON_HANDLER="${COPILOT_EXT_DIR}/_lib/daemon-handler.mjs"
if [ -f "$DAEMON_SERVICE" ] && [ -f "$DAEMON_HANDLER" ]; then
    mkdir -p "$(dirname "$DAEMON_SERVICE")"
    cat > "$DAEMON_SERVICE" <<EOF
[Unit]
Description=PilotClaw inbox handler

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
Description=PilotClaw inbox watcher

[Path]
PathExistsGlob=${PILOTCLAW_STATE}/inbox/*.json
MakeDirectory=yes

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload 2>/dev/null || true
    if systemctl --user is-enabled pilotclaw-daemon.path >/dev/null 2>&1; then
        systemctl --user restart pilotclaw-daemon.path 2>/dev/null || true
    fi
    echo "✅ daemon unit migrated to Node handler"
fi

# Install each extension
installed=0
skipped=0
for ext in "${EXTENSIONS[@]}"; do
    src="${PILOTCLAW_DIR}/extensions/${ext}/extension.mjs"
    dest_dir="${COPILOT_EXT_DIR}/pilotclaw-${ext}"

    if [ ! -f "$src" ]; then
        echo "⏭️  ${ext} — not yet built, skipping"
        skipped=$((skipped + 1))
        continue
    fi

    # Copy the extension file directly
    # Updates require re-running install.sh
    mkdir -p "$dest_dir"
    cp "$src" "${dest_dir}/extension.mjs"
    if [ "$ext" = "gateway" ] && [ -f "${PILOTCLAW_DIR}/extensions/gateway/server-entry.mjs" ]; then
        cp "${PILOTCLAW_DIR}/extensions/gateway/server-entry.mjs" "${dest_dir}/server-entry.mjs"
    fi

    echo "✅ ${ext} → ${dest_dir}"
    installed=$((installed + 1))
done

if [ -f "${PILOTCLAW_DIR}/scripts/import-openclaw-agents.mjs" ]; then
    src_agent_sync="${PILOTCLAW_DIR}/scripts/import-openclaw-agents.mjs"
    dest_agent_sync="${PILOTCLAW_STATE}/scripts/import-openclaw-agents.mjs"
    if [ "$(readlink -f "$src_agent_sync")" != "$(readlink -f "$dest_agent_sync" 2>/dev/null || printf '%s' "$dest_agent_sync")" ]; then
        cp "$src_agent_sync" "$dest_agent_sync"
    fi
    chmod 700 "${PILOTCLAW_STATE}/scripts/import-openclaw-agents.mjs"
    if command -v node &>/dev/null; then
        node "${PILOTCLAW_STATE}/scripts/import-openclaw-agents.mjs" || true
    fi
fi

echo ""
echo "🦞 Installed ${installed} extensions (${skipped} skipped)"
echo ""

# Install pilotclaw launcher
LAUNCHER="${PILOTCLAW_DIR}/pilotclaw.sh"
BIN_DIR="${HOME}/.local/bin"
if [ -f "$LAUNCHER" ]; then
    mkdir -p "$BIN_DIR"
    ln -sf "$LAUNCHER" "${BIN_DIR}/pilotclaw"
    echo "✅ Launcher: ${BIN_DIR}/pilotclaw"
    ln -sf "$LAUNCHER" "${BIN_DIR}/clawpilot"
    echo "✅ Compatibility launcher: ${BIN_DIR}/clawpilot → pilotclaw"
    if ! echo "$PATH" | grep -q "${BIN_DIR}"; then
        echo "   ℹ️  Add to PATH: export PATH=\"${BIN_DIR}:\$PATH\""
    fi
fi

echo ""
echo "Restart Copilot CLI or run /clear to load extensions."
echo "State directory: ${PILOTCLAW_STATE}"
echo ""
echo "Usage:"
echo "  copilot          # Normal Copilot CLI (new session each time)"
echo "  pilotclaw        # Always resumes 'main' session (persistent)"
