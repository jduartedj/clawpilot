#!/usr/bin/env bash
# Clawpilot CLI launcher
# Wraps Copilot CLI with sensible defaults for autonomous operation.
#
# Defaults: autopilot + yolo + resume "main" session + OpenClaw workspace dir
#
# Usage:
#   clawpilot                     # Resume main session (autopilot + yolo)
#   clawpilot -p "task"           # Non-interactive autonomous run
#   clawpilot --no-yolo           # Resume without auto-approving tools
#   clawpilot --no-autopilot      # Resume in interactive mode
#   clawpilot --session work      # Use a different named session
#   clawpilot --model gpt-5.5    # Override model
#   clawpilot -- --any-flag       # Pass arbitrary flags to copilot

SESSION_NAME="main"
AUTOPILOT=true
YOLO=true

# Detect workspace directory
# 1. Try OpenClaw config (default agent's workspace)
# 2. Fall back to ~/clawd if it exists
# 3. Fall back to home directory
detect_workspace() {
    local oc_config="${HOME}/.openclaw/openclaw.json"
    if [[ -f "$oc_config" ]] && command -v python3 &>/dev/null; then
        local ws
        ws=$(python3 -c "
import json, sys
try:
    with open('$oc_config') as f:
        d = json.load(f)
    agents = d.get('agents', {}).get('list', [])
    for a in agents:
        if a.get('default'):
            print(a.get('workspace', ''))
            sys.exit(0)
    if agents:
        print(agents[0].get('workspace', ''))
except:
    pass
" 2>/dev/null)
        if [[ -n "$ws" && -d "$ws" ]]; then
            echo "$ws"
            return
        fi
    fi
    # Fallback: common workspace dirs
    [[ -d "${HOME}/clawd" ]] && { echo "${HOME}/clawd"; return; }
    [[ -d "${HOME}/openclaw" ]] && { echo "${HOME}/openclaw"; return; }
    echo "${HOME}"
}

# Parse clawpilot-specific flags (before --)
COPILOT_EXTRA_ARGS=()
while [[ $# -gt 0 ]]; do
    case "$1" in
        --no-yolo)        YOLO=false; shift ;;
        --no-autopilot)   AUTOPILOT=false; shift ;;
        --session)        SESSION_NAME="$2"; shift 2 ;;
        --session=*)      SESSION_NAME="${1#--session=}"; shift ;;
        --)               shift; COPILOT_EXTRA_ARGS+=("$@"); break ;;
        *)                COPILOT_EXTRA_ARGS+=("$1"); shift ;;
    esac
done

WORKSPACE=$(detect_workspace)

# Build copilot args — try resume, fall back to new named session
ARGS=()
[[ "$AUTOPILOT" == true ]] && ARGS+=(--autopilot)
[[ "$YOLO" == true ]]      && ARGS+=(--allow-all)
ARGS+=("${COPILOT_EXTRA_ARGS[@]}")

cd "$WORKSPACE"

# Try to resume the named session; if it doesn't exist, start a new one with that name
copilot --resume="$SESSION_NAME" "${ARGS[@]}" 2>/dev/null \
  || exec copilot --name="$SESSION_NAME" "${ARGS[@]}"
