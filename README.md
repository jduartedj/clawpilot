# Clawpilot CLI 🦞🤖

> Autonomous superpowers for GitHub Copilot CLI — background sessions, scheduled tasks, proactive heartbeats, messaging, encrypted secrets, and more.

Clawpilot is a set of **extensions** for [GitHub Copilot CLI](https://github.com/github/copilot-cli) that add always-on, autonomous capabilities. Copilot CLI stays untouched and updates independently — Clawpilot layers on top.

## Features

| Extension | What It Does | Status |
|-----------|-------------|--------|
| **spawn** | Launch parallel background sessions + auto-resume on exit | ✅ |
| **scheduler** | Schedule recurring tasks via systemd user timers + read OpenClaw crons | ✅ |
| **heartbeat** | Proactive checks with session-start notification injection | ✅ |
| **channels** | Native messaging (Telegram, Discord, Slack) | ✅ |
| **daemon** | Always-on systemd service dispatching from an inbox queue | ✅ |
| **orchestrator** | Self-driving task engine (reads ORCHESTRATION.md/ROADMAP.md) | ✅ |
| **memory-db** | SQLite memory store with FTS5 full-text search | ✅ |
| **vault** | age-encrypted local secrets with rotation tracking | ✅ |
| **fallback** | Automatic retry on model errors | ✅ |

**37 tools** total. Zero external dependencies — pure Node.js built-ins + system utilities.

## Quick Start

```bash
# Install (auto-installs Copilot CLI if needed)
git clone https://github.com/jduartedj/clawpilot.git ~/.clawpilot
cd ~/.clawpilot && ./install.sh

# Use (always resumes your "main" session)
clawpilot
```

Requires **Linux with systemd**. Optional: `sudo apt install sqlite3 age` for memory-db and vault.

## Usage

```bash
clawpilot              # Resume main session (autopilot + yolo mode)
clawpilot --no-yolo    # Resume without auto-approving tools
clawpilot --no-autopilot  # Resume in interactive mode
clawpilot --session work  # Use a different named session
clawpilot -p "do X"   # Non-interactive autonomous run
copilot                # Normal Copilot CLI (new session each time)
```

Once running, just ask naturally:

```
> Spawn a background session to refactor the auth module
> Schedule a daily code review at 8am
> Add a heartbeat to check my email every hour
> Send "deploy complete" to my Telegram chat
> Store my API key in the vault
> Search memory for "trading bot decisions"
```

📖 **[Full Usage Guide →](docs/USAGE.md)** — all 37 tools with parameters, examples, and setup guides.

## How It Works

```
┌─────────────────────────────────────────┐
│  GitHub Copilot CLI                     │ ← Untouched, updates independently
│  (proprietary, any version)             │
├─────────────────────────────────────────┤
│  Clawpilot Extensions (9)               │ ← ~/.copilot/extensions/
│  spawn · scheduler · heartbeat          │
│  channels · daemon · orchestrator       │
│  memory-db · vault · fallback           │
├─────────────────────────────────────────┤
│  Clawpilot State                        │ ← ~/.clawpilot/
│  spawned/ · heartbeat/ · vault/         │
│  scheduler/ · inbox/ · memory.db        │
└─────────────────────────────────────────┘
```

### Key design decisions

- **Copilot CLI is a prerequisite**, not bundled — `copilot update` works independently
- **State isolated** in `~/.clawpilot/` — zero coupling with `~/.copilot/` internals
- **Auto-resume** — quit mid-task and work continues in background; on return, results are handed back seamlessly
- **Persistent session** — `clawpilot` command always resumes your "main" session
- **Smart workspace** — auto-detects OpenClaw workspace dir, falls back to `~/clawd` or `~/`
- **OpenClaw-aware scheduler** — imports existing `~/.openclaw/cron` jobs as read-only `openclaw:<id>` entries
- **OpenClaw agent sync** — imports OpenClaw agent config + safe `agentDir`/workspace definition files into Copilot custom agents on startup
- **No npm dependencies** — all extensions use Node.js built-ins only
- **Security reviewed** — prompts stored in files (not systemd units), vault uses age encryption with `0700`/`0600` permissions, tokens validated on setup
- **Linux-first, cross-platform planned** — see the Linux refactor, Windows, and macOS plans below

## Update

```bash
cd ~/.clawpilot && git pull && ./install.sh
```

## Uninstall

```bash
cd ~/.clawpilot && ./uninstall.sh
```

## Docs

- **[Usage Guide](docs/USAGE.md)** — complete reference for all 37 tools
- **[Custom Instructions](docs/INSTRUCTIONS.md)** — add to `.github/copilot-instructions.md`
- **[Linux Refactor Plan](docs/PLAN-LINUX-REFACTOR.md)** — platform abstraction work before Windows/macOS
- **[Windows Implementation Plan](docs/PLAN-WINDOWS-IMPLEMENTATION.md)** — Task Scheduler and PowerShell support
- **[macOS Implementation Plan](docs/PLAN-MACOS-IMPLEMENTATION.md)** — launchd and LaunchAgent support

## License

MIT
