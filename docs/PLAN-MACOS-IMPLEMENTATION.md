# macOS Implementation Plan

## Goal

Add first-class PilotClaw support on macOS using launchd while preserving the existing PilotClaw tool surface.

## Prerequisites

- Linux refactor completed and merged.
- Shared platform interfaces exist for scheduler, daemon, spawn, filesystem paths, and exec.
- Lucius is available for final smoke testing, or GitHub Actions macOS runners cover most behavior first.

## Target behavior

| Feature | macOS backend |
|---|---|
| Launcher | shell launcher in `~/.local/bin/pilotclaw` |
| Installer | `install.command` wrapper plus shell installer support |
| Scheduler | LaunchAgents in `~/Library/LaunchAgents` |
| Heartbeat | Same launchd scheduler backend |
| Daemon | launchd `WatchPaths` or long-running Node watcher |
| Spawn | POSIX detached child process groups |
| Logs | `~/.pilotclaw/logs` plus LaunchAgent stdout/stderr files |
| State | `~/.pilotclaw`, optionally symlinked to `~/Library/Application Support/PilotClaw` later |
| Extensions | `~/.copilot/extensions/pilotclaw-*` |

## Implementation sequence

1. Add macOS paths in `platform.mjs`.
2. Add `launchd.mjs` scheduler backend:
   - write `com.pilotclaw.<name>.plist`.
   - bootstrap/bootout/kickstart jobs.
   - map schedule subset to `StartCalendarInterval` or `StartInterval`.
3. Add heartbeat support via the same backend.
4. Add macOS daemon backend:
   - prefer LaunchAgent with `WatchPaths` for inbox.
   - use shared Node daemon handler.
5. Add installer wrapper:
   - `install.command`.
   - update `install.sh` path handling if needed.
6. Update docs:
   - README macOS install.
   - LaunchAgent behavior and limitations.
   - Homebrew optional dependencies: `age`, `sqlite`, etc.

## Schedule subset

Initially support:

- `hourly`
- `daily`
- `weekly`
- `*-*-* HH:MM[:SS]`
- `Mon *-*-* HH:MM[:SS]`
- every N minutes/hours using `StartInterval`

Unsupported patterns should fail clearly with a suggested supported alternative.

## Lucius validation

When Lucius is available:

1. Fresh clone and `install.command`.
2. `pilotclaw` launches Copilot.
3. `pilotclaw_schedule` creates a loaded LaunchAgent.
4. `launchctl list` shows the job.
5. `pilotclaw_schedule_run_now` kicks the job.
6. `pilotclaw_schedule_cancel` unloads/removes it.
7. `pilotclaw_daemon_setup` installs inbox watcher.
8. Dropping inbox JSON triggers processing.
9. Reboot/login and verify LaunchAgents reload.

## Risks

| Risk | Mitigation |
|---|---|
| LaunchAgents run only after user login | document behavior; consider LaunchDaemon later |
| Calendar syntax mismatch | documented subset + clear errors |
| macOS permissions prompts | avoid protected paths; use user-owned state only |
| Homebrew deps missing | graceful errors and docs |
| Lucius availability | use macOS CI runner first |

## Acceptance criteria

- CI macOS smoke passes.
- Lucius smoke passes when available.
- Linux behavior remains unchanged.
- Public docs include macOS install, limitations, and troubleshooting.

