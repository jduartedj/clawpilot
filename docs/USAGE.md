# Clawpilot CLI — Complete Usage Guide

> 9 extensions that add background sessions, scheduling, heartbeats, messaging, memory, secrets, orchestration, and error resilience to GitHub Copilot CLI.

---

## Table of Contents

1. [Installation](#installation)
2. [spawn — Background Sessions](#-spawn--background-sessions)
3. [scheduler — Systemd Timers](#-scheduler--systemd-timers)
4. [heartbeat — Proactive Checks](#-heartbeat--proactive-checks)
5. [channels — Native Messaging](#-channels--native-messaging)
6. [daemon — Always-On Service](#-daemon--always-on-service)
7. [orchestrator — Self-Driving Tasks](#-orchestrator--self-driving-tasks)
8. [memory-db — SQLite Memory Store](#-memory-db--sqlite-memory-store)
9. [vault — Encrypted Secrets](#-vault--encrypted-secrets)
10. [fallback — Error Retry](#-fallback--error-retry)
11. [State & Files](#state--files)
12. [Troubleshooting](#troubleshooting)

---

## Installation

### Prerequisites

| Requirement | Required By | Install |
|-------------|-------------|---------|
| GitHub Copilot CLI | All extensions | `curl -fsSL https://gh.io/copilot-install \| bash` |
| Linux + systemd | scheduler, heartbeat, daemon | Built into most Linux distros |
| sqlite3 | memory-db | `sudo apt install sqlite3` |
| age | vault | `sudo apt install age` |
| jq | daemon | `sudo apt install jq` |

### Install Clawpilot

```bash
git clone https://github.com/jduartedj/clawpilot.git ~/.clawpilot
cd ~/.clawpilot
./install.sh
```

Then restart Copilot CLI or run `/clear`. All `clawpilot_*` tools become available.

### Update

```bash
cd ~/.clawpilot && git pull && ./install.sh
```

### Uninstall

```bash
cd ~/.clawpilot && ./uninstall.sh
# Optionally remove state: rm -rf ~/.clawpilot
```

---

## 🚀 spawn — Background Sessions

Launch autonomous Copilot CLI sessions in the background. Each session runs `copilot -p` with `--allow-all --autopilot` and captures output to a log file.

### Tools

#### `clawpilot_spawn`

Launch a background session.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `name` | ✅ | Unique session name (e.g., `refactor-auth`) |
| `prompt` | ✅ | Full task prompt for the background session |
| `cwd` | | Working directory (default: current directory) |
| `model` | | Model override (e.g., `claude-sonnet-4`, `gpt-5.5`) |

**Example:**
```
> Spawn a session named "fix-tests" to find and fix all failing unit tests in the project
```

#### `clawpilot_spawn_list`

List all spawned sessions with status (🟢 running, ✅ completed, ❌ failed), PID, duration, and model.

#### `clawpilot_spawn_read`

Read the output log of a spawned session.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `name` | ✅ | Session name |
| `tail` | | Lines from end (default: 50) |

#### `clawpilot_spawn_kill`

Kill a running session by name.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `name` | ✅ | Session name to kill |

#### `clawpilot_spawn_clean`

Remove completed/failed/killed sessions and their logs.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `name` | | Specific session to clean (omit = clean all non-running) |

### Session Start Hook

When you start a new Copilot CLI session, the spawn extension automatically checks for completed background sessions and injects a summary into context. You'll see something like:

```
[Clawpilot] 2 background session(s) finished since last check:
• fix-tests: completed (Find and fix all failing unit tests...)
• refactor-auth: completed (Refactor the auth module to use...)
```

### How It Works

1. Runs `setsid copilot -p "prompt" --allow-all --autopilot --name "spawn-{name}" --silent --no-ask-user`
2. Output captured to `~/.clawpilot/spawned/{name}/output.log`
3. PID and metadata stored in `~/.clawpilot/spawned/{name}/meta.json`
4. Process runs detached — survives parent CLI exit

---

## ⏰ scheduler — Systemd Timers

Schedule recurring Copilot CLI tasks using systemd user timers. Each run is a fresh `copilot -p` session.

### Tools

#### `clawpilot_schedule`

Create a scheduled task.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `name` | ✅ | Unique task name |
| `schedule` | ✅ | systemd OnCalendar syntax (see below) |
| `prompt` | ✅ | Task prompt |
| `cwd` | | Working directory (default: home) |
| `model` | | Model override |

**Schedule syntax (systemd OnCalendar):**

| Pattern | Meaning |
|---------|---------|
| `hourly` | Every hour |
| `daily` | Every day at midnight |
| `weekly` | Every Monday at midnight |
| `*-*-* 08:00:00` | Every day at 8:00 AM |
| `*-*-* */4:00:00` | Every 4 hours |
| `Mon *-*-* 09:00:00` | Every Monday at 9:00 AM |
| `*-*-01 00:00:00` | First of every month |
| `Mon..Fri *-*-* 08:00:00` | Weekdays at 8:00 AM |

**Example:**
```
> Schedule "daily-review" to run daily at 8am: review all PRs and summarize findings
```

#### `clawpilot_schedule_list`

List all Clawpilot timers with next run time. Output is from `systemctl --user list-timers`.

#### `clawpilot_schedule_cancel`

Stop, disable, and remove a scheduled task and its systemd units.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `name` | ✅ | Task name to cancel |

#### `clawpilot_schedule_run_now`

Manually trigger a scheduled task immediately.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `name` | ✅ | Task name to trigger |

#### `clawpilot_schedule_logs`

View journald logs from a scheduled task's recent runs.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `name` | ✅ | Task name |
| `lines` | | Number of log lines (default: 100) |

### How It Works

1. Prompt written to `~/.clawpilot/scheduler/{name}.prompt` (not inline in unit)
2. Creates `~/.config/systemd/user/clawpilot-{name}.service` + `.timer`
3. Service runs `/bin/bash -c 'exec copilot -p "$(cat promptfile)" --allow-all ...'`
4. `systemctl --user enable --now` activates the timer
5. Logs go to journald (queryable via `journalctl --user`)

---

## 💓 heartbeat — Proactive Checks

Schedule background checks that report findings when you start a new Copilot CLI session. Builds on the scheduler — heartbeats are scheduled tasks with a notification layer.

### Tools

#### `clawpilot_heartbeat_add`

Add a proactive check.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `name` | ✅ | Unique check name (e.g., `email`, `services`) |
| `schedule` | ✅ | systemd OnCalendar schedule |
| `prompt` | ✅ | What to check — runs as a background Copilot session |

**Example:**
```
> Add a heartbeat named "email" running hourly: check Gmail for urgent emails and summarize any that need attention
```

#### `clawpilot_heartbeat_remove`

Remove a heartbeat check and its systemd timer.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `name` | ✅ | Check name to remove |

#### `clawpilot_heartbeat_status`

Show all checks with their schedule, timer status, and any pending results.

#### `clawpilot_heartbeat_ack`

Clear pending heartbeat results.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `name` | | Specific check to clear (omit = clear all) |

### Session Start Hook

On every session start, the heartbeat extension injects pending results as context:

```
[Clawpilot Heartbeat] 3 result(s) since last session:

🔴 URGENT (1):
• email: 2 urgent emails from CTO about production outage
  Details: Email from John at 14:30...

🟢 Normal (2):
• services: All 5 services healthy
• backups: Last backup completed successfully
```

### How It Works

1. Each heartbeat is a systemd timer that runs `copilot -p` with instructions to write a JSON result
2. Results written to `~/.clawpilot/heartbeat/results/{name}-{timestamp}.json`
3. On session start, pending results are read and injected as `additionalContext`
4. Urgent items (`"urgent": true`) are highlighted with 🔴

---

## 📨 channels — Native Messaging

Send and read messages on Telegram, Discord, and Slack using direct API calls. Zero external dependencies — pure Node.js `fetch()`.

### Supported Channels

| Channel | Auth | Target Format |
|---------|------|---------------|
| **Telegram** | Bot token from [@BotFather](https://t.me/BotFather) | Chat ID (number) |
| **Discord** | Bot token from [Developer Portal](https://discord.com/developers/applications) | Channel ID (number) |
| **Slack** | Bot token (`xoxb-...`) or [Incoming Webhook](https://api.slack.com/messaging/webhooks) URL | Channel name/ID |

### Tools

#### `clawpilot_channel_setup`

Configure a messaging channel. Validates the token on setup.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `channel` | ✅ | `telegram`, `discord`, or `slack` |
| `token` | ✅ | Bot token, API key, or webhook URL |
| `note` | | Optional label (e.g., `personal bot`) |

**Setup examples:**

**Telegram:**
1. Message [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token
2. Start a chat with your bot (or add it to a group)
3. Get the chat ID: send a message to the bot, then visit `https://api.telegram.org/bot<TOKEN>/getUpdates`

```
> Set up Telegram with token 123456:ABCdefGHI...
```

**Discord:**
1. Go to [Discord Developer Portal](https://discord.com/developers/applications) → New Application → Bot → copy token
2. Under OAuth2 → URL Generator, select `bot` scope + `Send Messages` + `Read Message History`
3. Use the generated URL to invite the bot to your server
4. Right-click a channel → Copy Channel ID (enable Developer Mode in settings)

```
> Set up Discord with token MTk5...
```

**Slack:**
1. Create a [Slack App](https://api.slack.com/apps) → OAuth & Permissions → add `chat:write` scope → install → copy Bot Token
2. Or create an [Incoming Webhook](https://api.slack.com/messaging/webhooks) URL

```
> Set up Slack with webhook https://hooks.slack.com/services/T.../B.../xxx
```

#### `clawpilot_send_message`

Send a message to a configured channel.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `channel` | ✅ | `telegram`, `discord`, or `slack` |
| `target` | ✅ | Chat ID, channel ID, or channel name |
| `message` | ✅ | Message text |

#### `clawpilot_read_messages`

Read recent messages from a channel.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `channel` | ✅ | `telegram`, `discord`, or `slack` |
| `target` | | Chat/channel ID (optional for Telegram, required for Discord/Slack) |
| `count` | | Number of messages (default: 10) |

#### `clawpilot_channel_status`

Show all configured channels with live connection status. Validates tokens against the platform API.

#### `clawpilot_channel_remove`

Remove a configured channel.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `channel` | ✅ | Channel name to remove |

### Security

- Tokens stored in `~/.clawpilot/channels/config.json` with `0600` permissions
- Directory created with `0700` permissions
- Tokens never leave your machine — direct API calls only

---

## 🤖 daemon — Always-On Service

A systemd `.path` unit that watches an inbox directory. When a JSON file appears, it spawns a Copilot CLI session to handle it.

### Tools

#### `clawpilot_daemon_setup`

Install the systemd path watcher and handler script. Creates:
- `~/.config/systemd/user/clawpilot-daemon.path` (watches inbox)
- `~/.config/systemd/user/clawpilot-daemon.service` (handler)
- `~/.clawpilot/daemon-handler.sh` (dispatch script)

#### `clawpilot_daemon_status`

Show daemon status (active/inactive), inbox queue, and processed count.

#### `clawpilot_daemon_inbox`

Queue a task for the daemon to process.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `prompt` | ✅ | Task prompt |
| `name` | | Task name (default: timestamp) |
| `model` | | Model override |
| `cwd` | | Working directory |

**Example:**
```
> Queue a task for the daemon to analyze yesterday's server logs
```

The daemon picks up the file and runs `copilot -p "prompt" --allow-all --autopilot`.

#### `clawpilot_daemon_stop`

Stop and disable the daemon.

### How It Works

1. `systemd .path` unit watches `~/.clawpilot/inbox/` for new `.json` files
2. When a file appears, the handler script runs
3. Handler reads `{prompt, model?, cwd?}` from the JSON file
4. Spawns `copilot -p` via `setsid` for each message
5. Moves processed files to `~/.clawpilot/processed/`
6. Logs go to `~/.clawpilot/logs/`

### Manual Usage (without Copilot CLI)

You can also queue tasks by writing JSON files directly:

```bash
echo '{"prompt":"Check disk space and report"}' > ~/.clawpilot/inbox/check-disk.json
```

---

## 🏗️ orchestrator — Self-Driving Tasks

Reads `ORCHESTRATION.md` and `ROADMAP.md` to pick and execute the highest-priority unblocked task autonomously.

### Tools

#### `clawpilot_orchestrator_run`

Trigger an orchestration cycle. Reads orchestration files and generates a prompt for the next task.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `orchestration_file` | | Path to ORCHESTRATION.md (default: `~/clawd/ORCHESTRATION.md`) |
| `roadmap_file` | | Path to ROADMAP.md (default: `~/clawd/ROADMAP.md`) |

**Example:**
```
> Run an orchestration cycle to pick and execute the next task
```

#### `clawpilot_orchestrator_status`

Show current orchestrator state: status (idle/running/paused), current task, and recent history.

#### `clawpilot_orchestrator_steer`

Give the orchestrator a directive to change priorities.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `directive` | ✅ | Steering instruction (e.g., `focus on trading bot`, `skip website tasks`) |

#### `clawpilot_orchestrator_pause`

Pause orchestration. Current task finishes, but no new tasks are picked.

#### `clawpilot_orchestrator_resume`

Resume orchestration after a pause.

### Combining with Scheduler

For nightly autonomous operation:
```
> Schedule "nightly-orchestrator" to run daily at midnight: run an orchestration cycle and execute the next high-priority task
```

---

## 🧠 memory-db — SQLite Memory Store

Searchable memory database with FTS5 full-text search. Active daily memory files stay on disk; older files rotate into the database.

### Tools

#### `clawpilot_memory_search`

Full-text search across all stored memories.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `query` | ✅ | Search query (supports FTS5 syntax) |
| `limit` | | Max results, 1–100 (default: 20) |

**FTS5 search syntax:**

| Syntax | Example | Meaning |
|--------|---------|---------|
| Simple | `trading` | Match word |
| AND | `trading AND bot` | Both words |
| OR | `bug OR error` | Either word |
| NOT | `trading NOT crypto` | Exclude word |
| Phrase | `"code review"` | Exact phrase |

#### `clawpilot_memory_store`

Store a memory or decision.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `content` | ✅ | The memory/decision/event |
| `tags` | | Comma-separated tags |
| `date` | | YYYY-MM-DD (default: today) |

#### `clawpilot_memory_recent`

Retrieve recent memories from the database.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `days` | | Lookback period, 1–3650 (default: 30) |
| `limit` | | Max results, 1–100 (default: 20) |

#### `clawpilot_memory_rotate`

Rotate daily memory files older than 7 days into the database. Files in `~/clawd/memory/` matching `YYYY-MM-DD*.md` are ingested and deleted.

### Session End Hook

On session end, the extension automatically captures the session summary into the `sessions_log` table.

### Database Schema

```sql
memories(id, date, source, content, tags, created_at)  -- with FTS5 index
sessions_log(id, name, summary, started_at, ended_at, model, cwd)
```

Database location: `~/.clawpilot/memory.db`

---

## 🔐 vault — Encrypted Secrets

Local secret store using [age](https://age-encryption.org/) encryption with rotation tracking.

### Prerequisites

```bash
sudo apt install age
```

### Tools

#### `clawpilot_vault_set`

Encrypt and store a secret.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `key` | ✅ | Secret name (e.g., `api-key-openai`) |
| `value` | ✅ | Secret value to encrypt |

#### `clawpilot_vault_get`

Decrypt and retrieve a secret.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `key` | ✅ | Secret name to retrieve |

#### `clawpilot_vault_list`

List all secrets (names and rotation history, not values).

#### `clawpilot_vault_delete`

Delete a secret from the vault.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `key` | ✅ | Secret name to delete |

### Security

- Encryption key auto-generated on first use (`~/.clawpilot/vault/.age-key`)
- Vault directory: `0700` permissions
- Key file: `0600` permissions
- Rotation log: `0600` permissions
- Secrets stored as individual `.age` files
- Both `age` and `age-keygen` binaries verified before any operation

---

## 🔄 fallback — Error Retry

Automatic retry on model call errors with configurable retry count.

### How It Works

The `onErrorOccurred` hook catches recoverable model call failures and retries up to N times. If all retries fail, it aborts with a notification.

- Retry counter resets after 5 minutes of no errors
- Only retries `model_call` errors (not tool or system errors)
- Does **not** switch to alternate models (retries the same model)

### Configuration

Create `~/.clawpilot/fallback.json`:

```json
{
  "enabled": true,
  "maxRetries": 2
}
```

### Tools

#### `clawpilot_fallback_status`

Show current retry configuration and counter.

---

## State & Files

All Clawpilot state lives in `~/.clawpilot/` — completely isolated from `~/.copilot/`.

```
~/.clawpilot/
├── spawned/              # Background session logs + metadata
│   └── {name}/
│       ├── output.log    # Session output
│       └── meta.json     # PID, status, timestamps
├── scheduler/            # Scheduled task metadata + prompts
│   ├── {name}.json       # Task metadata
│   └── {name}.prompt     # Task prompt (separate from unit file)
├── heartbeat/
│   ├── config.json       # Heartbeat check definitions
│   ├── {name}.prompt     # Check prompt
│   └── results/          # Pending check results (JSON)
├── channels/
│   └── config.json       # Channel tokens (0600 perms)
├── orchestrator/
│   └── state.json        # Orchestrator state + directives
├── vault/                # 0700 permissions
│   ├── .age-key          # Encryption key (0600, auto-generated)
│   ├── .rotation.json    # Rotation tracking (0600)
│   └── *.age             # Encrypted secret files
├── inbox/                # Daemon message queue (JSON files)
├── processed/            # Daemon processed messages
├── logs/                 # Daemon session logs
├── memory.db             # SQLite memory database
├── fallback.json         # Fallback retry config
└── daemon-handler.sh     # Daemon dispatch script (0755)
```

### Systemd Units (created by scheduler/heartbeat/daemon)

```
~/.config/systemd/user/
├── clawpilot-{name}.service    # Scheduler task
├── clawpilot-{name}.timer      # Scheduler timer
├── clawpilot-hb-{name}.service # Heartbeat task
├── clawpilot-hb-{name}.timer   # Heartbeat timer
├── clawpilot-daemon.path       # Daemon inbox watcher
└── clawpilot-daemon.service    # Daemon handler
```

---

## Troubleshooting

### Extensions not loading

```bash
# Re-run install (copies extension files)
cd ~/.clawpilot && ./install.sh

# Restart Copilot CLI
copilot  # or /clear in existing session

# Check extension status
# Inside Copilot CLI, the agent can use extensions_manage(operation: "list")
```

### Scheduler/heartbeat timers not running

```bash
# List all Clawpilot timers
systemctl --user list-timers 'clawpilot-*'

# Check a specific timer
systemctl --user status clawpilot-{name}.timer

# View logs
journalctl --user -u clawpilot-{name}.service --no-pager -n 50

# Reload after manual unit edits
systemctl --user daemon-reload
```

### Daemon not picking up messages

```bash
# Check daemon status
systemctl --user status clawpilot-daemon.path

# Check inbox
ls ~/.clawpilot/inbox/

# Check handler script
cat ~/.clawpilot/daemon-handler.sh

# View daemon logs
journalctl --user -u clawpilot-daemon.service --no-pager -n 50
```

### Vault errors

```bash
# Install age
sudo apt install age

# Verify
age --version
age-keygen --version

# Check permissions
ls -la ~/.clawpilot/vault/
```

### Memory-db errors

```bash
# Install sqlite3
sudo apt install sqlite3

# Check database
sqlite3 ~/.clawpilot/memory.db ".tables"
sqlite3 ~/.clawpilot/memory.db "SELECT count(*) FROM memories;"
```

### Spawn sessions dying early

```bash
# Check session log
cat ~/.clawpilot/spawned/{name}/output.log

# Check metadata
cat ~/.clawpilot/spawned/{name}/meta.json

# Verify copilot is in PATH
which copilot
```
