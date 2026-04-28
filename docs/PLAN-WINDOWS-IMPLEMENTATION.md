# Windows Implementation Plan

## Goal

Add first-class Clawpilot support on Windows using native Windows primitives while preserving the current Clawpilot tool surface.

## Prerequisites

- Linux refactor completed and merged.
- Shared platform interfaces exist for scheduler, daemon, spawn, filesystem paths, and exec.
- Kara is available for final smoke testing, or CI/VM testing covers most behavior until Kara is powered on.

## Target behavior

| Feature | Windows backend |
|---|---|
| Launcher | `clawpilot.cmd` delegating to `clawpilot.ps1` |
| Installer | `install.ps1` |
| Scheduler | Task Scheduler via `schtasks.exe` |
| Heartbeat | Same scheduler backend |
| Daemon | Node inbox watcher started at logon via Task Scheduler |
| Spawn | detached child process + `taskkill /T /F /PID` |
| Logs | files under `%LOCALAPPDATA%\\Clawpilot\\logs` and compatibility `~\\.clawpilot\\logs` |
| State | `%LOCALAPPDATA%\\Clawpilot`, with `%USERPROFILE%\\.clawpilot` compatibility alias when safe |
| Extensions | `%USERPROFILE%\\.copilot\\extensions\\clawpilot-*` |

## Implementation sequence

1. Add Windows paths in `platform.mjs`.
2. Add `taskscheduler.mjs` backend:
   - create/list/run/cancel/log status operations.
   - support documented schedule subset.
   - return clear error for unsupported systemd-only calendars.
3. Add Windows spawn backend:
   - use `detached: true`, `windowsHide: true`.
   - kill with `taskkill /T /F /PID`.
4. Add Windows daemon backend:
   - create a Task Scheduler `ONLOGON` task.
   - run Node watcher loop against inbox directory.
   - use atomic move to avoid duplicate processing from `fs.watch`.
5. Add installer/launcher:
   - `install.ps1`
   - `uninstall.ps1`
   - `clawpilot.ps1`
   - `clawpilot.cmd`
6. Update docs:
   - README Windows install.
   - troubleshooting for PowerShell execution policy and PATH refresh.
   - optional dependency install commands for `age` and `sqlite3`.

## Schedule subset

Initially support:

- `hourly`
- `daily`
- `weekly`
- `*-*-* HH:MM[:SS]`
- `Mon *-*-* HH:MM[:SS]`
- every N minutes/hours when expressible with `/SC MINUTE` or `/SC HOURLY`

Unsupported patterns should fail clearly with a suggested supported alternative.

## Kara validation

When Kara is available:

1. Fresh clone and `install.ps1` as non-admin.
2. `clawpilot` runs from PowerShell and cmd.
3. `clawpilot_schedule` creates a visible Task Scheduler task.
4. `clawpilot_schedule_run_now` starts the task.
5. `clawpilot_schedule_cancel` removes it.
6. `clawpilot_spawn` starts a background job.
7. `clawpilot_spawn_kill` kills the entire child tree.
8. `clawpilot_daemon_setup` installs the watcher.
9. Dropping inbox JSON triggers processing within 30 seconds.
10. Reboot or log out/in and verify scheduled/logon tasks still work.

## Risks

| Risk | Mitigation |
|---|---|
| Task Scheduler calendar mismatch | documented subset + clear errors |
| PowerShell execution policy | use `.cmd` shim and installation guidance |
| PATH not refreshed in existing shells | installer prints restart-shell message |
| `fs.watch` duplicate events | atomic move to processing directory |
| Optional binaries missing | graceful feature-level errors |

## Acceptance criteria

- CI Windows smoke passes.
- Kara smoke passes when available.
- No Linux behavior regressions.
- Public docs include Windows install, limitations, and troubleshooting.

