# Clawpilot — Copilot CLI Custom Instructions

Add this to your project's `.github/copilot-instructions.md` or reference via `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` to teach Copilot CLI how to use Clawpilot tools naturally.

---

## Clawpilot Tools

You have `clawpilot_*` tools for background sessions, scheduling, heartbeats, messaging, memory, secrets, and orchestration.

### OpenClaw Agent Imports
- On install and `clawpilot` startup, OpenClaw agents from `~/.openclaw/openclaw.json` with `agentDir/SOUL.md` are synced into Copilot custom agents under `~/.copilot/agents/`.
- Missing agents are imported; existing agents are updated only when the OpenClaw `SOUL.md` is newer than the Copilot agent file.
- Imported agents are normal Copilot custom agents and can be invoked with the Task tool's custom-agent types when available.

### Background Work
- `clawpilot_spawn(name, prompt, cwd?, model?)` — launch long tasks in the background
- `clawpilot_spawn_list()` — check spawned session status
- `clawpilot_spawn_read(name, tail?)` — read output from background work
- `clawpilot_spawn_kill(name)` — stop a running session
- `clawpilot_spawn_clean(name?)` — remove finished sessions
- Completed sessions are reported automatically on session start
- **Auto-resume:** if the user quits mid-task, the interrupted work is auto-spawned in the background. On return, the output is injected as context — if the background session finished, the agent reports results; if still running, it's stopped and the agent continues interactively.

### Scheduling
- `clawpilot_schedule(name, schedule, prompt, cwd?, model?)` — create recurring tasks
- Schedule uses systemd OnCalendar syntax: `hourly`, `daily`, `*-*-* 08:00:00`
- `clawpilot_schedule_list()` — show all timers
- `clawpilot_schedule_cancel(name)` — remove a task
- `clawpilot_schedule_run_now(name)` — trigger immediately
- `clawpilot_schedule_logs(name, lines?)` — view run logs

### Proactive Monitoring
- `clawpilot_heartbeat_add(name, schedule, prompt)` — add a periodic check
- `clawpilot_heartbeat_status()` — show checks and pending results
- `clawpilot_heartbeat_remove(name)` — remove a check
- `clawpilot_heartbeat_ack(name?)` — clear pending results
- Results with `"urgent": true` are highlighted on session start

### Messaging (Telegram, Discord, Slack)
- `clawpilot_channel_setup(channel, token, note?)` — configure with token validation
- `clawpilot_send_message(channel, target, message)` — send to any configured channel
- `clawpilot_read_messages(channel, target?, count?)` — read recent messages
- `clawpilot_channel_status()` — live connection health
- `clawpilot_channel_remove(channel)` — remove a channel
- Ask before sending external messages unless urgency requires it

### Always-On Daemon
- `clawpilot_daemon_setup()` — install systemd inbox watcher
- `clawpilot_daemon_inbox(prompt, name?, model?, cwd?)` — queue a task
- `clawpilot_daemon_status()` — check daemon and inbox
- `clawpilot_daemon_stop()` — stop the daemon

### Memory
- `clawpilot_memory_store(content, tags?, date?)` — store important decisions/events
- `clawpilot_memory_search(query, limit?)` — FTS5 search (supports AND, OR, NOT, phrases)
- `clawpilot_memory_recent(days?, limit?)` — retrieve recent memories
- `clawpilot_memory_rotate()` — archive old daily files into the database

### Secrets
- `clawpilot_vault_set(key, value)` — encrypt and store (uses age encryption)
- `clawpilot_vault_get(key)` — decrypt and retrieve
- `clawpilot_vault_list()` — list stored secrets (names only)
- `clawpilot_vault_delete(key)` — remove a secret
- Never store secrets in plain files — always use the vault

### Orchestration
- `clawpilot_orchestrator_run(orchestration_file?, roadmap_file?)` — pick next task
- `clawpilot_orchestrator_status()` — show current state
- `clawpilot_orchestrator_steer(directive)` — adjust priorities
- `clawpilot_orchestrator_pause()` / `clawpilot_orchestrator_resume()` — control

### Error Resilience
- `clawpilot_fallback_status()` — show retry config
- Automatic retry on model errors (configurable in `~/.clawpilot/fallback.json`)
