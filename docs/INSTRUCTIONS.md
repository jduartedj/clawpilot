# PilotClaw — Copilot CLI Custom Instructions

Add this to your project's `.github/copilot-instructions.md` or reference via `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` to teach Copilot CLI how to use PilotClaw tools naturally.

---

## PilotClaw Tools

You have `pilotclaw_*` tools for background sessions, scheduling, heartbeats, messaging, memory, secrets, and orchestration.

### OpenClaw Agent Imports
- On install and `pilotclaw` startup, OpenClaw agents from `~/.openclaw/openclaw.json` with `agentDir/SOUL.md` are synced into Copilot custom agents under `~/.copilot/agents/`.
- Imports include the OpenClaw agent config snapshot plus safe definition files from `agentDir` and documented workspace bootstrap files from `workspace`.
- Missing agents are imported; existing agents are updated only when the OpenClaw config or an imported source file is newer than the Copilot agent file.
- Sensitive runtime state is excluded: auth profiles, auth state, sessions, credentials, tokens, keys, secrets, and provider model credential files.
- Imported agents are normal Copilot custom agents and can be invoked with the Task tool's custom-agent types when available.

### Background Work
- `pilotclaw_spawn(name, prompt, cwd?, model?)` — launch long tasks in the background
- `pilotclaw_spawn_list()` — check spawned session status
- `pilotclaw_spawn_read(name, tail?)` — read output from background work
- `pilotclaw_spawn_kill(name)` — stop a running session
- `pilotclaw_spawn_clean(name?)` — remove finished sessions
- Completed sessions are reported automatically on session start
- **Auto-resume:** if the user quits mid-task, the interrupted work is auto-spawned in the background. On return, the output is injected as context — if the background session finished, the agent reports results; if still running, it's stopped and the agent continues interactively.

### Scheduling
- `pilotclaw_schedule(name, schedule, prompt, cwd?, model?)` — create recurring tasks
- Schedule uses systemd OnCalendar syntax: `hourly`, `daily`, `*-*-* 08:00:00`
- `pilotclaw_schedule_list()` — show all timers
- `pilotclaw_schedule_cancel(name)` — remove a task
- `pilotclaw_schedule_run_now(name)` — trigger immediately
- `pilotclaw_schedule_logs(name, lines?)` — view run logs

### Proactive Monitoring
- `pilotclaw_heartbeat_add(name, schedule, prompt)` — add a periodic check
- `pilotclaw_heartbeat_status()` — show checks and pending results
- `pilotclaw_heartbeat_remove(name)` — remove a check
- `pilotclaw_heartbeat_ack(name?)` — clear pending results
- Results with `"urgent": true` are highlighted on session start

### Messaging (Telegram, Discord, Slack)
- `pilotclaw_channel_setup(channel, token, note?)` — configure with token validation
- `pilotclaw_send_message(channel, target, message)` — send to any configured channel
- `pilotclaw_read_messages(channel, target?, count?)` — read recent messages
- `pilotclaw_channel_status()` — live connection health
- `pilotclaw_channel_remove(channel)` — remove a channel
- Ask before sending external messages unless urgency requires it

### Always-On Daemon
- `pilotclaw_daemon_setup()` — install systemd inbox watcher
- `pilotclaw_daemon_inbox(prompt, name?, model?, cwd?)` — queue a task
- `pilotclaw_daemon_status()` — check daemon and inbox
- `pilotclaw_daemon_stop()` — stop the daemon

### Memory
- `pilotclaw_memory_store(content, tags?, date?)` — store important decisions/events
- `pilotclaw_memory_search(query, limit?)` — FTS5 search (supports AND, OR, NOT, phrases)
- `pilotclaw_memory_recent(days?, limit?)` — retrieve recent memories
- `pilotclaw_memory_rotate()` — archive old daily files into the database

### Secrets
- `pilotclaw_vault_set(key, value)` — encrypt and store (uses age encryption)
- `pilotclaw_vault_get(key)` — decrypt and retrieve
- `pilotclaw_vault_list()` — list stored secrets (names only)
- `pilotclaw_vault_delete(key)` — remove a secret
- Never store secrets in plain files — always use the vault

### Orchestration
- `pilotclaw_orchestrator_run(orchestration_file?, roadmap_file?)` — pick next task
- `pilotclaw_orchestrator_status()` — show current state
- `pilotclaw_orchestrator_steer(directive)` — adjust priorities
- `pilotclaw_orchestrator_pause()` / `pilotclaw_orchestrator_resume()` — control

### Error Resilience
- `pilotclaw_fallback_status()` — show retry config
- Automatic retry on model errors (configurable in `~/.pilotclaw/fallback.json`)
