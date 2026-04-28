#!/usr/bin/env bash
set -euo pipefail

COPILOT_EXT_DIR="${HOME}/.copilot/extensions"
CLAWPILOT_STATE="${HOME}/.clawpilot"

EXTENSIONS=(spawn scheduler heartbeat channels daemon orchestrator memory-db vault fallback)

echo "🦞 Clawpilot CLI — Uninstalling extensions"
echo ""

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
