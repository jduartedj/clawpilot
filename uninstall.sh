#!/usr/bin/env bash
set -euo pipefail

COPILOT_EXT_DIR="${HOME}/.copilot/extensions"
PILOTCLAW_STATE="${HOME}/.pilotclaw"
LEGACY_STATE="${HOME}/.clawpilot"

EXTENSIONS=(spawn scheduler heartbeat channels daemon gateway orchestrator memory-db vault fallback)

echo "🦞 PilotClaw CLI — Uninstalling extensions"
echo ""

if command -v systemctl &>/dev/null; then
    for unit in pilotclaw-gateway.service pilotclaw-daemon.path pilotclaw-daemon.service clawpilot-gateway.service clawpilot-daemon.path clawpilot-daemon.service; do
        systemctl --user stop "$unit" 2>/dev/null || true
        systemctl --user disable "$unit" 2>/dev/null || true
        unit_file="${HOME}/.config/systemd/user/${unit}"
        if [ -f "$unit_file" ]; then
            rm "$unit_file"
            echo "🗑️  Removed systemd unit $unit"
        fi
    done
    systemctl --user daemon-reload 2>/dev/null || true
fi

removed=0
for ext in "${EXTENSIONS[@]}"; do
    for prefix in pilotclaw clawpilot; do
        dest_dir="${COPILOT_EXT_DIR}/${prefix}-${ext}"
        if [ -d "$dest_dir" ]; then
            rm -rf "$dest_dir"
            echo "🗑️  Removed ${prefix}-${ext}"
            removed=$((removed + 1))
        fi
    done
done

echo ""
echo "Removed ${removed} extensions."
echo ""

# Remove launcher
for launcher in pilotclaw clawpilot; do
    BIN_LINK="${HOME}/.local/bin/${launcher}"
    if [ -L "$BIN_LINK" ]; then
        rm "$BIN_LINK"
        echo "🗑️  Removed launcher: ${BIN_LINK}"
    fi
done

echo ""
echo "State directory preserved at: ${PILOTCLAW_STATE}"
if [ -d "$LEGACY_STATE" ]; then
    echo "Legacy state directory also preserved at: ${LEGACY_STATE}"
fi
echo "To remove state: rm -rf ${PILOTCLAW_STATE}"
echo ""
echo "Restart Copilot CLI or run /clear to unload extensions."
