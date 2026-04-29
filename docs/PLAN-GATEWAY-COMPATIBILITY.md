# PilotClaw Gateway Compatibility Plan

## Goal

Expose PilotClaw through an OpenClaw-style gateway interface so Jackson can connect to either OpenClaw or PilotClaw without managing separate backend concepts.

The gateway contract should look interchangeable from the client side. Internally, PilotClaw can translate gateway calls into turn-based Copilot sessions, spawned runs, daemon inbox items, schedules, heartbeats, logs, and local state.

## Current direction

Build a **PilotClaw Gateway Compatibility Mode**:

```text
Jackson
  -> OpenClaw-compatible HTTP/WebSocket gateway
      -> OpenClaw native gateway
      OR
      -> PilotClaw compatibility gateway
            -> pilotclaw --session <name> -p <message>
            -> ~/.pilotclaw/spawned/*/output.log
            -> ~/.pilotclaw/inbox/*.json
            -> ~/.pilotclaw/scheduler/*.json
            -> ~/.pilotclaw/heartbeat/*
            -> ~/.pilotclaw/memory.db
```

The interface should preserve OpenClaw-style envelopes, method names, lifecycle states, and records where practical. When exact parity is impossible or not worth doing yet, expose the same shape with emulated data and clear capability flags.

## Decisions from compatibility review

| # | Area | Decision |
|---:|---|---|
| 1 | Turn-based chat | Acceptable. Turn-based PilotClaw sessions are close enough to normal usage. |
| 2 | Abort/kill | Good enough. Kill the process/run and recover via resume/dirty-session handling. |
| 3 | Message/session format | Replicate OpenClaw-style format in local PilotClaw storage or DB. |
| 4 | Token-level streaming | Not needed initially. Stream output/events at practical chunks instead. |
| 5 | Session graph/names | Try to mimic OpenClaw hierarchy through Copilot session names, e.g. `name:other:name`, if Copilot accepts it safely. |
| 6 | Node APIs | Implemented as a native PilotClaw node hub. OpenClaw-compatible nodes connect directly to PilotClaw; no OpenClaw gateway bridge is required. |
| 7 | Canvas/camera/screen/location | Available through direct node commands when a connected node advertises those capabilities; PilotClaw-native node UX remains future work. |
| 8 | Channels | Separate registration is fine if interaction looks the same through the gateway. |
| 9 | Voice | Park. Future target is direct voice tokens in a local model, not current OpenClaw voice parity. |
| 10 | Cron/schedule management | Interface should allow managing PilotClaw and OpenClaw crons as interchangeable schedule entities. |
| 11 | Agent/subagent runtime graph | Mimic by directing agents/tasks to name work accordingly and by recording compatible metadata. |
| 12 | Node approvals/permissions | Gateway auth/pairing is the permission boundary. After a node authenticates with the gateway key, PilotClaw grants full node access and auto-approves `system.run` requests sent via `node.exec`/`node.invoke`. |
| 13 | Gateway state | Avoid real gateway state unless needed. If clients expect it, expose a fake/derived gateway state. |
| 14 | Lifecycle/error states | Emulate according to OpenClaw source/docs. |
| 15 | Multi-client writes | Park. If needed, add an incoming request queue and release bundled requests at specific intervals. |
| 16 | Tool-call records | Try to mimic OpenClaw tool-call records in session history when Copilot output exposes enough information. |
| 17 | Hot attach/resume | Use Copilot resume-session behavior, matching PilotClaw's current exit/rejoin recovery model. |

## Compatibility target

The PilotClaw gateway should prioritize these OpenClaw-compatible surfaces first:

1. `health/status`
2. gateway connection/auth envelope
3. `chat.send` turn-based messages
4. event stream for run/session output
5. session/run list
6. message/session history in OpenClaw-like local records
7. schedule/cron list, trigger, create, delete
8. heartbeat list/status/ack
9. channel status and send interactions
10. memory search/status
11. vault secret-name list only
12. native node list/describe/invoke/exec and node pending queue methods

## Emulation strategy

### Sessions

Use named Copilot sessions as the backing primitive. Test whether Copilot safely accepts OpenClaw-like hierarchical names:

```text
main
main:researcher
main:researcher:task-name
```

If colons are not safe across platforms or Copilot versions, store the OpenClaw-style logical name in gateway metadata and map it to a sanitized Copilot session name internally.

### Message history

Create PilotClaw gateway records that mimic OpenClaw JSONL/session records:

```text
~/.pilotclaw/gateway/sessions/<session-id>/session.json
~/.pilotclaw/gateway/sessions/<session-id>/messages.jsonl
~/.pilotclaw/gateway/sessions/<session-id>/events.jsonl
```

The gateway should write normalized records for:

- user messages
- assistant output chunks
- run started/completed/failed/killed
- tool-call records when detectable
- schedule/cron actions
- dirty-session recovery events

### Request handling

Default write behavior should be serialized per session. If multi-client writes become important, add a queue:

```text
~/.pilotclaw/gateway/queues/<session-id>.jsonl
```

The queue can release bundled requests at fixed intervals to avoid overlapping Copilot turns.

### Schedules and crons

Expose one schedule interface for both:

- native PilotClaw schedules
- imported OpenClaw crons

Records must include source/ownership:

```json
{
  "id": "openclaw:<id>",
  "source": "openclaw",
  "mutable": true,
  "compatibility": "managed-through-openclaw"
}
```

If PilotClaw is asked to mutate an OpenClaw-owned cron, the compatibility gateway should route that operation to OpenClaw when available instead of duplicating it as a PilotClaw timer.

### Nodes

PilotClaw now owns a native OpenClaw-compatible node hub instead of bridging to OpenClaw. Node clients connect to the PilotClaw gateway WebSocket with `role: "node"` and the PilotClaw gateway token. The hub registers connected nodes, persists last-known node metadata, sends `node.invoke.request` events to node sockets, and resolves operator `node.invoke` calls from node `node.invoke.result` requests.

`system.run` follows the OpenClaw node-host flow but without a separate PilotClaw approval UI: PilotClaw sends `system.run.prepare`, then sends `system.run` with an auto-approved `allow-once` decision. This matches the chosen policy that gateway-key auth grants full access to everything the node can do.

## Parked items

These are intentionally deferred and should not block the first gateway compatibility implementation.

| Parked item | Reason | Future direction |
|---|---|---|
| PilotClaw-native node UX/manager | Direct node RPC compatibility is implemented; a full node-management UI/installer flow is separate. | Add first-class node pairing/install management around the direct hub. |
| PilotClaw-native canvas/camera/screen/location UX | Node transport can carry these commands, but no PilotClaw-native UX is implemented yet. | Build UI/workflows on top of connected node commands. |
| Voice pipeline parity | Current design is changing toward direct voice tokens/local model. | Revisit after local voice-token architecture is defined. |
| Multi-client simultaneous writes | Unlikely initial scenario. | Add per-session queue and bundled dispatch intervals. |
| Perfect token-level streaming | Too technical and not required for user experience. | Stream practical output/event chunks first. |
| Exact gateway in-memory state | Avoid unless clients require it. | Expose fake/derived state from filesystem/process truth. |

## Open questions to validate during implementation

These are engineering checks, not product blockers:

1. Does Copilot CLI accept colon-separated session names consistently on Linux, Windows, and macOS?
2. Which Copilot output formats expose enough structure to reconstruct tool-call records?
3. Which exact OpenClaw gateway methods does Jackson currently rely on at runtime?
4. Can OpenClaw cron mutations be safely routed through OpenClaw from PilotClaw compatibility mode without duplicating jobs?

## Acceptance criteria

- Jackson can connect to PilotClaw through the same gateway-shaped interface used for OpenClaw.
- Common interactions do not require Jackson to branch on backend type.
- Unsupported/parked features are represented through capability flags, not crashes.
- PilotClaw writes OpenClaw-like local session/message records for compatibility.
- Turn-based `chat.send` works through named/resumable Copilot sessions.
- Schedule/cron operations present a unified model while preserving ownership.
- No node, voice, or vault-value features are implemented accidentally in the first version.
