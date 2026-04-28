# Clawpilot CLI

> OpenClaw-grade superpowers for GitHub Copilot CLI — background sessions, scheduled tasks, proactive heartbeats, multi-channel messaging, and more.

Clawpilot is a set of **extensions** for [GitHub Copilot CLI](https://github.com/github/copilot-cli) that add autonomous, always-on capabilities. Copilot CLI stays untouched and updates independently — Clawpilot layers on top.

## Features

| Extension | What It Does | Status |
|-----------|-------------|--------|
| **spawn** | Launch parallel background Copilot sessions | ✅ Ready |
| **scheduler** | Schedule tasks via systemd user timers | ✅ Ready |
| **heartbeat** | Proactive checks with session-start injection | ✅ Ready |
| **channels** | Native messaging (Telegram, Discord, Slack) | ✅ Ready |
| **daemon** | Always-on service dispatching from a message queue | ✅ Ready |
| **orchestrator** | Self-driving task engine | ✅ Ready |
| **memory-db** | SQLite-backed memory with FTS5 search | ✅ Ready |
| **vault** | age-encrypted local secrets | ✅ Ready |
| **fallback** | Multi-model fallback on errors | ✅ Ready |

## Prerequisites

- [GitHub Copilot CLI](https://github.com/github/copilot-cli) (any version)
- Linux with systemd (for scheduler/heartbeat)
- Node.js 18+ (Copilot CLI includes this)

## Install

```bash
git clone https://github.com/jduartedj/clawpilot.git ~/.clawpilot
cd ~/.clawpilot
./install.sh
```

Then restart Copilot CLI (or run `/clear`). Extensions load automatically.

### Vault Setup (optional)

```bash
# Install age for encrypted secrets
sudo apt install age
```

## Update

```bash
cd ~/.clawpilot && git pull && ./install.sh
```

Re-run `install.sh` after pulling to copy updated extension files. Restart Copilot CLI to reload.

## Uninstall

```bash
cd ~/.clawpilot
./uninstall.sh
```

## Architecture

```
┌─────────────────────────────────┐
│  GitHub Copilot CLI             │  ← Untouched, updates independently
│  (proprietary, any version)     │
├─────────────────────────────────┤
│  Clawpilot Extensions           │  ← User-level extensions in ~/.copilot/extensions/
│  ┌──────┐ ┌─────────┐ ┌──────┐ │
│  │spawn │ │scheduler│ │heart-│ │
│  │      │ │         │ │beat  │ │
│  └──────┘ └─────────┘ └──────┘ │
│  ┌──────┐ ┌──────┐ ┌────────┐  │
│  │chan- │ │vault │ │memory- │  │
│  │nels  │ │      │ │db      │  │
│  └──────┘ └──────┘ └────────┘  │
├─────────────────────────────────┤
│  Clawpilot State                │
│  ~/.clawpilot/                  │
│  ├── spawned/     (bg sessions) │
│  ├── heartbeat/   (check results│)
│  ├── vault/       (encrypted)   │
│  └── memory.db    (SQLite)      │
└─────────────────────────────────┘
```

**Key design decisions:**
- Copilot CLI is a prerequisite, not bundled — install/update separately
- State lives in `~/.clawpilot/`, not `~/.copilot/` (no coupling)
- All tool names prefixed with `clawpilot_` to avoid collisions
- Extensions use Node.js built-ins only (no npm dependencies)
- **Auto-resume:** quit mid-task and the interrupted work continues in the background — on return, results are handed back seamlessly
- Linux-first (systemd for scheduling), macOS support planned

## Usage

Once installed, Copilot CLI gains new tools. Just ask naturally:

```
> Spawn a background session to refactor the auth module
> Schedule a daily code review at 8am
> Check what happened while I was away (heartbeat results)
> Send "build complete" to my Telegram chat
> Store my API key in the vault
> Search memory for "trading bot decisions"
```

See [docs/USAGE.md](docs/USAGE.md) for the complete guide with all tools, parameters, and examples.

See [docs/INSTRUCTIONS.md](docs/INSTRUCTIONS.md) for custom instructions to add to your project.

## License

MIT
