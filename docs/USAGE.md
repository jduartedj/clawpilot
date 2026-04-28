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

### Install Clawpilot

Linux:

```bash
git clone https://github.com/jduartedj/clawpilot.git ~/.clawpilot
cd ~/.clawpilot
./install.sh
```

Windows:

```powershell
git clone https://github.com/jduartedj/clawpilot.git $env:LOCALAPPDATA\Clawpilot\src
cd $env:LOCALAPPDATA\Clawpilot\src
.\install.ps1
```

The installer automatically:
- Installs GitHub Copilot CLI if not found on Linux; Windows currently requires Copilot CLI to already be on PATH
- Copies all 9 extensions to `~/.copilot/extensions/`
- Creates state directories in `~/.clawpilot/` on Linux or `%LOCALAPPDATA%\Clawpilot` on Windows
- Links or installs the `clawpilot` launcher (`~/.local/bin/` on Linux, `%LOCALAPPDATA%\Clawpilot\bin` on Windows)
- Reports any missing optional dependencies (sqlite3, age)

Then restart Copilot CLI or run `/clear`. All `clawpilot_*` tools become available.

### Optional dependencies

| Tool | For | Install |
|------|-----|---------|
| `sqlite3` | memory-db extension | Linux: `sudo apt install sqlite3`; Windows: `winget install SQLite.SQLite` |
| `age` | vault extension | Linux: `sudo apt install age`; Windows: `winget install FiloSottile.age` |

### System requirements

- **Linux with systemd** or **Windows 10/11 with Task Scheduler**
- **Node.js 18+** — included with Copilot CLI

### Update

Linux:

```bash
cd ~/.clawpilot && git pull && ./install.sh
```

Windows:

```powershell
cd $env:LOCALAPPDATA\Clawpilot\src
git pull
.\install.ps1
```

### Uninstall

Linux:

```bash
cd ~/.clawpilot && ./uninstall.sh
# Optionally remove state: rm -rf ~/.clawpilot
```

Windows:

```powershell
cd $env:LOCALAPPDATA\Clawpilot\src
.\uninstall.ps1
# Optionally remove state after backing up anything important:
# Remove-Item -Recurse -Force $env:LOCALAPPDATA\Clawpilot
```

### The `clawpilot` Command

After install, you get a `clawpilot` command (in `~/.local/bin/`):

```bash
clawpilot              # Resume main session (autopilot + yolo mode)
clawpilot --no-yolo    # Resume without auto-approving tools
clawpilot --no-autopilot  # Resume in interactive mode
clawpilot --session work  # Use a different named session
clawpilot -p "do X"   # Non-interactive autonomous run
clawpilot --model X    # Resume with model override
copilot                # Normal Copilot CLI (starts a new session)
```

The `clawpilot` command wraps `copilot` with these defaults:
- `--resume="main"` — always resume the same persistent session
- `--autopilot` — agent continues working without pausing for approval at each step
- `--allow-all` — auto-approve all tools, paths, and URLs (yolo mode)

Use `--no-yolo` and `--no-autopilot` to disable these for more cautious work. Use `--session <name>` to maintain multiple persistent sessions (e.g., `--session work`, `--session personal`).

### OpenClaw Agent Sync

On install and on every `clawpilot` start, Clawpilot reads `~/.openclaw/openclaw.json` and imports OpenClaw agents that have an `agentDir` with a `SOUL.md` into Copilot's user custom-agent directory:

```text
~/.copilot/agents/<agent-id>.agent.md
```

The sync is timestamp-aware:

- Missing Copilot agents are imported.
- Existing Copilot agents are updated only when the OpenClaw config or any imported source file is newer.
- Existing Copilot agents with the same or newer timestamp are preserved, so local Copilot edits are not overwritten.

Imported agents include the OpenClaw agent config snapshot plus safe definition files from both:

- `agents.list[].agentDir` — agent-specific persona/docs/config files.
- `agents.list[].workspace` — documented OpenClaw bootstrap files such as `AGENTS.md`, `SOUL.md`, `USER.md`, `IDENTITY.md`, `TOOLS.md`, `HEARTBEAT.md`, `BOOT.md`, `BOOTSTRAP.md`, `MEMORY.md`, and workspace skills.

Sensitive runtime state is intentionally excluded: auth profiles, auth state, sessions, credentials, tokens, keys, secrets, and provider model credential files. Imported agents also include a safety note that OpenClaw instructions about spawning/invoking Copilot CLI should be ignored because the agent is already running inside Copilot CLI.

Already-running Copilot CLI sessions may need `/clear` or a restart before newly imported agents appear in the available custom-agent list.

---

## ⚠️ Important: Spawn Long Tasks

**If you quit the CLI, any in-progress direct work stops.** However, Clawpilot's auto-resume safety net detects this and spawns a background session to continue the work (see below). For guaranteed background execution, use `clawpilot_spawn` explicitly:

**Rule of thumb:** If a task might take more than a few minutes, always use `clawpilot_spawn` instead of asking directly:

```
# ❌ Risky — dies if you quit
> Refactor the entire auth module

# ✅ Safe — survives CLI exit
> Spawn "refactor-auth" to refactor the entire auth module
```

### Auto-Resume (safety net)

If you quit the CLI while the agent is mid-task, Clawpilot automatically:
1. Detects the agent was still working (tools in flight or response not yet complete)
2. Captures your last prompt
3. Spawns a background `copilot -p` session to continue the interrupted work

**When you come back,** one of two things happens:

**If the background session finished:**
The output is injected into your new session as context. The agent reviews it and tells you what was accomplished:
```
[Clawpilot Auto-Resume] Your last session was interrupted.
A background session completed the task while you were away.

Original task: Refactor the entire auth module
Background session output: ...
```

**If the background session is still running:**
It's stopped and handed back to you with its partial output. The agent picks up where it left off, interactively:
```
[Clawpilot Auto-Resume] Your last session was interrupted.
A background session was working on it but you're back now —
it has been stopped and handed back to you.

Original task: Refactor the entire auth module
Progress from background session: ...
```

This is a **best-effort safety net** — the spawned session gets the original prompt but not the full conversation context. For guaranteed results, use `clawpilot_spawn` explicitly.

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

1. Runs a detached `copilot -p "prompt" --allow-all --autopilot --name "spawn-{name}" --silent --no-ask-user`
2. Output captured to the Clawpilot spawned log path (`spawned/{name}/output.log`)
3. PID and metadata stored in `spawned/{name}/meta.json`
4. Process runs detached — survives parent CLI exit; Windows kills process trees with `taskkill /T /F /PID`

---

## ⏰ scheduler — Timers

Schedule recurring Copilot CLI tasks. Linux uses systemd user timers; Windows uses Task Scheduler. Each run is a fresh `copilot -p` session.

### Tools

#### `clawpilot_schedule`

Create a scheduled task.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `name` | ✅ | Unique task name |
| `schedule` | ✅ | Linux: systemd OnCalendar syntax. Windows: documented compatible subset (see below). |
| `prompt` | ✅ | Task prompt |
| `cwd` | | Working directory (default: home) |
| `model` | | Model override |

**Schedule syntax:**

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

Windows currently supports: `hourly`, `daily`, `weekly`, `*-*-* HH:MM[:SS]`, `Mon *-*-* HH:MM[:SS]`, `*-*-* */N:00:00`, `*-*-* *:0/N:00`, and `every N minutes/hours`. Systemd-only patterns such as monthly dates or weekday ranges fail clearly instead of being approximated.

**Example:**
```
> Schedule "daily-review" to run daily at 8am: review all PRs and summarize findings
```

#### `clawpilot_schedule_list`

List all native Clawpilot timers with next run time and any existing OpenClaw crons discovered in `~/.openclaw/cron`.

OpenClaw jobs are shown as read-only imported refs:

```
openclaw:<job-id>
```

They are not duplicated into systemd timers, so Clawpilot will not double-run existing OpenClaw jobs. Use the `openclaw:<job-id>` ref with `clawpilot_schedule_logs` to read the OpenClaw JSONL run log, or with `clawpilot_schedule_run_now` to manually run the same prompt through Clawpilot.

#### `clawpilot_schedule_cancel`

Stop, disable, and remove a scheduled task and its native scheduler definition.

Imported `openclaw:<job-id>` refs are read-only in Clawpilot. Disable or delete those jobs with OpenClaw's cron tools.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `name` | ✅ | Task name to cancel |

#### `clawpilot_schedule_run_now`

Manually trigger a scheduled task immediately.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `name` | ✅ | Task name to trigger |

For imported OpenClaw jobs, pass `openclaw:<job-id>` or `openclaw:<job-name>`. Clawpilot runs the original OpenClaw cron prompt through `copilot -p`; it does not modify the OpenClaw cron definition.

#### `clawpilot_schedule_logs`

View logs from a scheduled task's recent runs.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `name` | ✅ | Task name |
| `lines` | | Number of log lines (default: 100) |

For imported OpenClaw jobs, pass `openclaw:<job-id>` to tail `~/.openclaw/cron/runs/<job-id>.jsonl`.

### How It Works

1. Prompt written to Clawpilot state (`scheduler/{name}.prompt`) instead of being embedded inline
2. Linux creates `~/.config/systemd/user/clawpilot-{name}.service` + `.timer`
3. Windows creates a `Clawpilot-sched-{name}` Task Scheduler task that calls a generated PowerShell runner
4. Linux logs go to journald; Windows logs go to `scheduler/{name}.log`
6. OpenClaw cron metadata is read from `~/.openclaw/cron/jobs.json` and `jobs-state.json`; logs are read from `~/.openclaw/cron/runs/`

---

## 💓 heartbeat — Proactive Checks

Schedule background checks that report findings when you start a new Copilot CLI session. Builds on the scheduler — heartbeats are scheduled tasks with a notification layer.

### Tools

#### `clawpilot_heartbeat_add`

Add a proactive check.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `name` | ✅ | Unique check name (e.g., `email`, `services`) |
| `schedule` | ✅ | Linux systemd OnCalendar schedule or Windows supported scheduler subset |
| `prompt` | ✅ | What to check — runs as a background Copilot session |

**Example:**
```
> Add a heartbeat named "email" running hourly: check Gmail for urgent emails and summarize any that need attention
```

#### `clawpilot_heartbeat_remove`

Remove a heartbeat check and its native timer/task.

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

1. Each heartbeat is a systemd timer on Linux or Task Scheduler task on Windows that runs `copilot -p` with instructions to write a JSON result
2. Results written to the Clawpilot heartbeat results directory (`~/.clawpilot/...` on Linux, `%LOCALAPPDATA%\Clawpilot\...` on Windows)
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

A native daemon watcher for the inbox directory. Linux uses a systemd `.path` unit; Windows uses a Task Scheduler logon task running the shared Node watcher loop. When a JSON file appears, it spawns a Copilot CLI session to handle it.

### Tools

#### `clawpilot_daemon_setup`

Install the native watcher and handler script. Linux creates:
- `~/.config/systemd/user/clawpilot-daemon.path` (watches inbox)
- `~/.config/systemd/user/clawpilot-daemon.service` (handler)
- shared Node daemon handler under `~/.copilot/extensions/_lib/`

Windows creates a `Clawpilot-daemon` logon task that runs the same shared Node daemon handler with `--watch`.

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

1. Native watcher monitors the Clawpilot inbox for new `.json` files
2. Handler atomically moves each file to `processing/` to avoid duplicate `fs.watch` events
3. Handler reads `{prompt, model?, cwd?}` from the JSON file
4. Spawns a detached `copilot -p` session for each message
5. Moves processed files to `processed/`
6. Spawned session logs go to `logs/`

### Manual Usage (without Copilot CLI)

You can also queue tasks by writing JSON files directly:

Linux:

```bash
echo '{"prompt":"Check disk space and report"}' > ~/.clawpilot/inbox/check-disk.json
```

Windows PowerShell:

```powershell
'{"prompt":"Check disk space and report"}' | Set-Content -Encoding utf8 $env:LOCALAPPDATA\Clawpilot\inbox\check-disk.json
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

Clawpilot state is isolated from `~/.copilot/`. Linux stores state in `~/.clawpilot/`; Windows stores state in `%LOCALAPPDATA%\Clawpilot` and also creates `~\.clawpilot` as a compatibility directory.

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
└── scripts/              # Helper scripts, including OpenClaw agent sync
```

### Systemd Units (Linux scheduler/heartbeat/daemon)

```
~/.config/systemd/user/
├── clawpilot-{name}.service    # Scheduler task
├── clawpilot-{name}.timer      # Scheduler timer
├── clawpilot-hb-{name}.service # Heartbeat task
├── clawpilot-hb-{name}.timer   # Heartbeat timer
├── clawpilot-daemon.path       # Daemon inbox watcher
└── clawpilot-daemon.service    # Daemon handler
```

### Windows Scheduled Tasks

```text
Task Scheduler Library
├── Clawpilot-sched-{name}  # Scheduler task
├── Clawpilot-hb-{name}     # Heartbeat task
└── Clawpilot-daemon        # Logon inbox watcher
```

---

## Troubleshooting

### Extensions not loading

Linux:

```bash
# Re-run install (copies extension files)
cd ~/.clawpilot && ./install.sh

# Restart Copilot CLI
copilot  # or /clear in existing session

# Check extension status
# Inside Copilot CLI, the agent can use extensions_manage(operation: "list")
```

Windows:

```powershell
cd $env:LOCALAPPDATA\Clawpilot\src
.\install.ps1
copilot
# In an existing Copilot CLI session, run /clear or restart the process.
```

### Scheduler/heartbeat timers not running

Linux:

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

Windows:

```powershell
schtasks /Query /FO LIST /V | Select-String Clawpilot
schtasks /Query /TN Clawpilot-sched-{name} /FO LIST /V
schtasks /Run /TN Clawpilot-sched-{name}
Get-Content $env:LOCALAPPDATA\Clawpilot\scheduler\{name}.log -Tail 50
```

### Daemon not picking up messages

Linux:

```bash
# Check daemon status
systemctl --user status clawpilot-daemon.path

# Check inbox
ls ~/.clawpilot/inbox/

# Check handler script
journalctl --user -u clawpilot-daemon.service --no-pager -n 100

# View daemon logs
journalctl --user -u clawpilot-daemon.service --no-pager -n 50
```

Windows:

```powershell
schtasks /Query /TN Clawpilot-daemon /FO LIST /V
schtasks /Run /TN Clawpilot-daemon
Get-ChildItem $env:LOCALAPPDATA\Clawpilot\inbox
Get-ChildItem $env:LOCALAPPDATA\Clawpilot\processed
Get-Content $env:LOCALAPPDATA\Clawpilot\logs\daemon-{name}.log -Tail 50
```

If PowerShell blocks scripts, run the installed `clawpilot.cmd` shim or start PowerShell with:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
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
