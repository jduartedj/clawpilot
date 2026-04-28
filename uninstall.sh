#!/usr/bin/env bash
set -euo pipefail

COPILOT_EXT_DIR="${HOME}/.copilot/extensions"
CLAWPILOT_STATE="${HOME}/.clawpilot"

EXTENSIONS=(spawn scheduler heartbeat channels daemon gateway orchestrator memory-db vault fallback)

echo "🦞 Clawpilot CLI — Uninstalling extensions"
echo ""

if command -v systemctl &>/dev/null; then
    for unit in clawpilot-gateway.service clawpilot-daemon.path clawpilot-daemon.service; do
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
    dest_dir="${COPILOT_EXT_DIR}/clawpilot-${ext}"
    if [ -d "$dest_dir" ]; then
        rm -rf "$dest_dir"
        echo "🗑️  Removed clawpilot-${ext}"
        removed=$((removed + 1))
    fi
done

echo ""
echo "Removed ${removed} extensions."
echo ""

# Remove launcher
BIN_LINK="${HOME}/.local/bin/clawpilot"
if [ -L "$BIN_LINK" ]; then
    rm "$BIN_LINK"
    echo "🗑️  Removed launcher: ${BIN_LINK}"
fi

echo ""
echo "State directory preserved at: ${CLAWPILOT_STATE}"
echo "To remove state: rm -rf ${CLAWPILOT_STATE}"
echo ""
echo "Restart Copilot CLI or run /clear to unload extensions."
