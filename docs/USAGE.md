# Clawpilot CLI — Usage Guide

## Quick Start

```bash
# Install
git clone https://github.com/jduartedj/clawpilot.git ~/.clawpilot
cd ~/.clawpilot && ./install.sh

# Restart Copilot CLI or run /clear
# All clawpilot_* tools are now available
```

---

## 🚀 spawn — Background Sessions

Launch parallel Copilot CLI sessions that run autonomously.

```
> Spawn a background session to refactor the auth module
> Spawn "fix-tests" to run all tests and fix failures
```

### Tools

| Tool | Description |
|------|-------------|
| `clawpilot_spawn` | Launch a background session with a name and prompt |
| `clawpilot_spawn_list` | List all spawned sessions with status |
| `clawpilot_spawn_read` | Read output from a spawned session |
| `clawpilot_spawn_kill` | Kill a running session |
| `clawpilot_spawn_clean` | Remove completed sessions |

### How it works
- Runs `copilot -p "prompt" --allow-all --autopilot` via `setsid`
- Output captured to `~/.clawpilot/spawned/{name}/output.log`
- PID and metadata tracked in `meta.json`
- On session start, completed sessions are reported automatically

---

## ⏰ scheduler — Systemd Timers

Schedule recurring Copilot CLI tasks using systemd user timers.

```
> Schedule a daily code review at 8am
> Schedule "backup" to run every 4 hours: back up important configs
```

### Tools

| Tool | Description |
|------|-------------|
| `clawpilot_schedule` | Create a scheduled task (name, schedule, prompt) |
| `clawpilot_schedule_list` | List all timers with next run time |
| `clawpilot_schedule_cancel` | Remove a scheduled task |
| `clawpilot_schedule_run_now` | Trigger a task immediately |
| `clawpilot_schedule_logs` | View logs from recent runs |

### Schedule syntax (systemd OnCalendar)
- `hourly`, `daily`, `weekly`, `monthly`
- `*-*-* 08:00:00` — every day at 8am
- `*-*-* */4:00:00` — every 4 hours
- `Mon *-*-* 09:00:00` — every Monday at 9am
- `*-*-01 00:00:00` — first of every month

---

## 💓 heartbeat — Proactive Checks

Schedule background checks that report findings when you start a new session.

```
> Add a heartbeat check for urgent emails, run hourly
> What happened while I was away?
```

### Tools

| Tool | Description |
|------|-------------|
| `clawpilot_heartbeat_add` | Add a recurring check |
| `clawpilot_heartbeat_remove` | Remove a check |
| `clawpilot_heartbeat_status` | Show checks and pending results |
| `clawpilot_heartbeat_ack` | Clear pending results |

### How it works
1. Heartbeat checks run as scheduled Copilot sessions via systemd timers
2. Each check writes results to `~/.clawpilot/heartbeat/results/`
3. On session start, pending results are injected as context
4. Urgent items are highlighted with 🔴

---

## 🤖 daemon — Always-On Service

A systemd path watcher that processes messages dropped into an inbox.

```
> Set up the daemon
> Queue a task to analyze yesterday's logs
```

### Tools

| Tool | Description |
|------|-------------|
| `clawpilot_daemon_setup` | Install the systemd path watcher |
| `clawpilot_daemon_status` | Check daemon status and inbox |
| `clawpilot_daemon_inbox` | Queue a task for processing |
| `clawpilot_daemon_stop` | Stop the daemon |

### How it works
1. A systemd `.path` unit watches `~/.clawpilot/inbox/`
2. Drop a JSON file with `{prompt, model?, cwd?}` 
3. The handler script spawns `copilot -p` for each message
4. Processed messages move to `inbox/processed/`

---

## 🏗️ orchestrator — Self-Driving Tasks

Reads ORCHESTRATION.md and ROADMAP.md to pick and execute tasks autonomously.

```
> Show orchestrator status
> Steer the orchestrator to focus on the trading bot
> Run an orchestration cycle
```

### Tools

| Tool | Description |
|------|-------------|
| `clawpilot_orchestrator_run` | Trigger an orchestration cycle |
| `clawpilot_orchestrator_status` | Show current state |
| `clawpilot_orchestrator_steer` | Add a priority directive |
| `clawpilot_orchestrator_pause` | Pause orchestration |
| `clawpilot_orchestrator_resume` | Resume orchestration |

---

## 🧠 memory-db — SQLite Memory Store

Searchable memory database with FTS5 full-text search. Active memory stays in files; old memory rotates into the DB.

```
> Search memory for "trading bot decisions"
> Store this decision: we chose PostgreSQL over MongoDB
> Rotate old memory files into the database
```

### Tools

| Tool | Description |
|------|-------------|
| `clawpilot_memory_search` | FTS5 search across all stored memories |
| `clawpilot_memory_store` | Store a memory/decision |
| `clawpilot_memory_recent` | Retrieve recent memories |
| `clawpilot_memory_rotate` | Rotate old daily files → DB |

### FTS5 search syntax
- Simple: `clawpilot_memory_search("trading")`
- AND: `"trading AND bot"`
- OR: `"bug OR error OR crash"`
- Phrase: `'"code review"'`
- NOT: `"trading NOT crypto"`

---

## 🔐 vault — Encrypted Secrets

age-encrypted local secret store with rotation tracking.

```
> Store my OpenAI API key in the vault
> Get the database password from the vault
> List all vault secrets
```

### Tools

| Tool | Description |
|------|-------------|
| `clawpilot_vault_set` | Encrypt and store a secret |
| `clawpilot_vault_get` | Decrypt and retrieve a secret |
| `clawpilot_vault_list` | List stored secrets (names only) |
| `clawpilot_vault_delete` | Remove a secret |

### How it works
- Secrets encrypted with `age` (install: `apt install age`)
- Stored in `~/.clawpilot/vault/{key}.age`
- Key auto-generated on first use (`~/.clawpilot/vault/.age-key`)
- Rotation history tracked in `.rotation.json`

---

## 🔄 fallback — Model Retry

Automatic retry with alternate models when the primary model fails.

### How it works
- `onErrorOccurred` hook catches model call failures
- Retries up to 2 times (configurable)
- Configure chains in `~/.clawpilot/fallback.json`:

```json
{
  "enabled": true,
  "chains": {
    "default": ["claude-sonnet-4", "gpt-5.4", "claude-haiku-4.5"]
  },
  "maxRetries": 2
}
```

---

## State & Files

All Clawpilot state lives in `~/.clawpilot/`:

```
~/.clawpilot/
├── spawned/          # Background session logs + metadata
├── heartbeat/
│   ├── config.json   # Heartbeat check definitions
│   └── results/      # Pending check results
├── scheduler/        # Scheduler task metadata
├── orchestrator/     # Orchestrator state
├── vault/            # age-encrypted secrets
│   ├── .age-key      # Encryption key (auto-generated)
│   └── *.age         # Encrypted secret files
├── inbox/            # Daemon message queue
├── logs/             # Daemon session logs
├── memory.db         # SQLite memory database
└── fallback.json     # Fallback chain config
```

## Updating

```bash
cd ~/.clawpilot && git pull
# Extensions auto-update via import wrappers
# Restart Copilot CLI or /clear to reload
```

## Troubleshooting

**Extensions not loading?**
```bash
# Re-run install
cd ~/.clawpilot && ./install.sh
# Then /clear in Copilot CLI
```

**Scheduler/heartbeat not running?**
```bash
# Check systemd timers
systemctl --user list-timers 'clawpilot-*'
# Check logs
journalctl --user -u clawpilot-hb-EMAIL --no-pager -n 50
```

**Vault errors?**
```bash
# Install age
sudo apt install age
```
