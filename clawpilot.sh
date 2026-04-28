#!/usr/bin/env bash
# Clawpilot CLI launcher
# Wraps Copilot CLI with sensible defaults for autonomous operation.
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

# Build copilot args
ARGS=()
ARGS+=(--resume="$SESSION_NAME" --name="$SESSION_NAME")
[[ "$AUTOPILOT" == true ]] && ARGS+=(--autopilot)
[[ "$YOLO" == true ]]      && ARGS+=(--allow-all)
ARGS+=("${COPILOT_EXTRA_ARGS[@]}")

exec copilot "${ARGS[@]}"
