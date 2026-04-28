#!/usr/bin/env bash
# Clawpilot CLI launcher — always resumes the "main" session.
#
# First run: creates a session named "main"
# Subsequent runs: resumes the "main" session (picks up where you left off)
#
# Usage:
#   clawpilot                     # Resume/start main session
#   clawpilot --autopilot         # Resume in autopilot mode
#   clawpilot --model gpt-5.5    # Resume with model override
#   clawpilot -p "do something"  # Non-interactive with main session context
#
# Install as alias:
#   echo 'alias clawpilot="~/.clawpilot/clawpilot.sh"' >> ~/.bashrc

SESSION_NAME="main"

# Check if a session named "main" exists by looking at session state
# copilot --resume="name" will resume if found, or show picker if not
# We suppress the picker by trying resume first, falling back to new named session
exec copilot --resume="$SESSION_NAME" "$@" 2>/dev/null \
  || exec copilot --name="$SESSION_NAME" "$@"
