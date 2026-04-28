# Linux Refactor Plan

## Goal

Refactor Clawpilot's current Linux/systemd implementation behind platform abstractions without changing Linux behavior. This is the foundation for later Windows and macOS support.

## Scope

In scope:

- Introduce shared platform helpers under `extensions/_lib/`.
- Move Linux scheduler operations behind a `systemd` backend.
- Move Linux spawn/process-tree operations behind a spawn backend.
- Replace daemon's bash + `jq` handler with a Node handler while keeping the systemd `.path` model.
- Keep existing public tool names, parameters, state paths, and user-visible behavior stable.
- Add smoke tests that exercise syntax, install, scheduler, spawn, daemon handler, and agent import.

Out of scope:

- Windows Task Scheduler implementation.
- macOS launchd implementation.
- Changing public tool schemas.
- Changing storage layout under `~/.clawpilot`.

## Current Linux-specific surfaces

| Extension | Linux-specific dependency | Refactor target |
|---|---|---|
| `scheduler` | `systemctl --user`, `.service`/`.timer`, `systemd-run`, `journalctl`, `/bin/bash -c` | `extensions/_lib/systemd.mjs` |
| `heartbeat` | `systemctl --user`, `.service`/`.timer`, `journalctl` | shared scheduler backend |
| `daemon` | systemd `.path`, bash handler, `jq`, `setsid` | systemd path + Node handler |
| `spawn` | POSIX detached process groups, negative PID kill, `tail` command | spawn backend + Node log tail |
| installers | POSIX shell, chmod, `~/.local/bin` | preserve now, route reusable logic later |

## Architecture

Add shared modules:

| Module | Responsibility |
|---|---|
| `extensions/_lib/exec.mjs` | `execFile` wrapper with consistent `{ ok, stdout, stderr, code }` result |
| `extensions/_lib/fs.mjs` | `ensureDir`, safe JSON read/write, log tail, path sanitizers |
| `extensions/_lib/platform.mjs` | OS detection and state/bin path constants |
| `extensions/_lib/spawn-backend.mjs` | spawn detached Copilot sessions and kill process trees |
| `extensions/_lib/systemd.mjs` | Linux systemd unit write/enable/disable/start/status/log helpers |
| `extensions/_lib/daemon-handler.mjs` | Node inbox processor used by the Linux systemd path service |

The Linux refactor should keep imports explicit and dependency-free: only Node built-ins plus Copilot SDK.

## Implementation sequence

1. Add `_lib` helpers.
2. Refactor `spawn`:
   - Use backend for detached spawn and kill.
   - Replace shell `tail` with Node file tail.
   - Preserve metadata format.
3. Refactor `daemon`:
   - Generate a Node handler in `~/.clawpilot/daemon-handler.mjs`.
   - Keep `clawpilot-daemon.path` + `.service`.
   - Remove runtime dependency on `jq`.
   - Preserve inbox JSON format and processed-file behavior.
4. Refactor `scheduler`:
   - Move native systemd operations into `_lib/systemd.mjs`.
   - Preserve OpenClaw cron import behavior.
   - Preserve prompt-file and metadata format.
5. Refactor `heartbeat`:
   - Use the shared systemd helper.
   - Preserve heartbeat config/results format.
6. Update docs if user-facing wording changes.

## Validation plan

Run locally on Linux:

1. `node --check` for all `.mjs` files.
2. `bash -n install.sh clawpilot.sh uninstall.sh`.
3. `./install.sh`.
4. Reload Copilot extensions.
5. Scheduler smoke:
   - create a far-future timer
   - confirm `clawpilot_schedule_list`
   - trigger/cancel/log without leaving units behind
6. Spawn smoke:
   - spawn short task or synthetic long task
   - list/read/kill/clean
7. Daemon smoke:
   - run setup
   - enqueue a harmless task
   - verify JSON moved to processed and log path exists
8. Agent import smoke:
   - repeated runs are idempotent
   - generated agents exclude secret tokens and runtime auth/session files

## QA and review loop

Before final commit:

1. Run a QA agent against the changed repo with focus on regressions and behavior parity.
2. Run code review against the diff with focus on path safety, process handling, shell quoting, and systemd semantics.
3. Fix every material issue.
4. Re-run validation.
5. Commit and push.

## Acceptance criteria

- Existing Linux tools behave the same from the user's perspective.
- No hard dependency on `jq` remains in daemon runtime.
- No spawned/test systemd units are left behind after validation.
- Public docs and tool descriptions are still accurate.
- Code review and QA find no blocking issues.

