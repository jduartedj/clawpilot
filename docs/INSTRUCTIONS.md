# Clawpilot Custom Instructions for Copilot CLI

These instructions should be copied to your project's `.github/copilot-instructions.md` or referenced via `COPILOT_CUSTOM_INSTRUCTIONS_DIRS`.

---

## Clawpilot Tools Available

You have access to `clawpilot_*` tools for background sessions, scheduling, heartbeats, messaging, memory, secrets, and orchestration.

### Background Work
- Use `clawpilot_spawn` to run long tasks in the background while continuing interactive work
- Use `clawpilot_spawn_list` to check on spawned sessions
- Use `clawpilot_spawn_read` to see output from background work
- Completed spawn sessions are reported automatically when a new session starts

### Scheduling
- Use `clawpilot_schedule` for recurring tasks (daily reports, periodic checks)
- Schedule syntax is systemd OnCalendar: 'hourly', 'daily', '*-*-* 08:00:00'
- Each scheduled run is an independent `copilot -p` session

### Proactive Monitoring
- Use `clawpilot_heartbeat_add` for checks that should run periodically and report on session start
- Heartbeat results with `urgent: true` are highlighted prominently
- Good candidates: email checks, service health, calendar events, security scans

### Messaging
- Use `clawpilot_send_message` to notify the user on WhatsApp, Discord, Telegram, etc.
- Ask before sending external messages unless urgency requires it
- Requires OpenClaw CLI with configured channels

### Memory
- Use `clawpilot_memory_store` for important decisions, events, and lessons learned
- Use `clawpilot_memory_search` to find past decisions and context (FTS5 syntax)
- Use `clawpilot_memory_rotate` periodically to archive old daily memory files into the database

### Secrets
- Use `clawpilot_vault_set` / `clawpilot_vault_get` for sensitive data (API keys, passwords)
- Never store secrets in plain files — always use the vault
- The vault uses age encryption; secrets are encrypted at rest

### Orchestration
- Use `clawpilot_orchestrator_run` to trigger autonomous task selection from ORCHESTRATION.md
- Use `clawpilot_orchestrator_steer` to adjust priorities
- Combine with `clawpilot_schedule` for nightly autonomous operation

### Daemon
- Use `clawpilot_daemon_setup` for always-on message processing
- Use `clawpilot_daemon_inbox` to queue tasks for asynchronous processing
