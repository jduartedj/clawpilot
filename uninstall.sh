#!/usr/bin/env bash
set -euo pipefail

COPILOT_EXT_DIR="${HOME}/.copilot/extensions"
CLAWPILOT_STATE="${HOME}/.clawpilot"

EXTENSIONS=(spawn scheduler heartbeat daemon orchestrator memory-db vault fallback)

echo "🦞 Clawpilot CLI — Uninstalling extensions"
echo ""

removed=0
for ext in "${EXTENSIONS[@]}"; do
    dest_dir="${COPILOT_EXT_DIR}/clawpilot-${ext}"
    if [ -d "$dest_dir" ]; then
        rm -rf "$dest_dir"
        echo "🗑️  Removed clawpilot-${ext}"
        ((removed++))
    fi
done

echo ""
echo "Removed ${removed} extensions."
echo ""
echo "State directory preserved at: ${CLAWPILOT_STATE}"
echo "To remove state: rm -rf ${CLAWPILOT_STATE}"
echo ""
echo "Restart Copilot CLI or run /clear to unload extensions."
