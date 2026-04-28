// Clawpilot CLI — daemon extension
// Always-on message queue dispatcher.
// Watches ~/.clawpilot/inbox/ for message files and spawns Copilot sessions to handle them.
import { joinSession } from "@github/copilot-sdk/extension";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile, readdir, unlink, stat, rename } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const INBOX_DIR = join(homedir(), ".clawpilot", "inbox");
const PROCESSED_DIR = join(homedir(), ".clawpilot", "processed");
const DAEMON_STATE = join(homedir(), ".clawpilot", "daemon-state.json");
const SYSTEMD_DIR = join(homedir(), ".config", "systemd", "user");
const DAEMON_UNIT = "clawpilot-daemon";

async function ensureDir(dir) {
    await mkdir(dir, { recursive: true });
}

function exec(cmd, args, opts = {}) {
    return new Promise((resolve) => {
        execFile(cmd, args, { timeout: 15000, ...opts }, (err, stdout, stderr) => {
            resolve({ ok: !err, stdout: stdout?.trim() || "", stderr: stderr?.trim() || "" });
        });
    });
}

function buildDaemonService() {
    // The daemon is a systemd path unit that watches the inbox directory
    // When a file appears, it triggers the handler service
    return {
        path: `[Unit]
Description=Clawpilot inbox watcher

[Path]
DirectoryNotEmpty=${INBOX_DIR}
MakeDirectory=yes

[Install]
WantedBy=default.target
`,
        service: `[Unit]
Description=Clawpilot inbox handler

[Service]
Type=oneshot
KillMode=process
ExecStart=${join(homedir(), ".clawpilot", "daemon-handler.sh")}
Environment=HOME=${homedir()}
Environment=PATH=${process.env.PATH}
StandardOutput=journal
StandardError=journal
`,
        handler: `#!/usr/bin/env bash
set -euo pipefail
INBOX="${INBOX_DIR}"
PROCESSED="${PROCESSED_DIR}"
mkdir -p "$PROCESSED"

for f in "$INBOX"/*.json; do
    [ -f "$f" ] || continue
    name="$(basename "$f" .json)"
    prompt="$(jq -r '.prompt // empty' "$f" 2>/dev/null)"
    model="$(jq -r '.model // empty' "$f" 2>/dev/null)"
    cwd="$(jq -r '.cwd // empty' "$f" 2>/dev/null)"

    if [ -z "$prompt" ]; then
        mv "$f" "$PROCESSED/"
        continue
    fi

    args=(-p "$prompt" --allow-all --autopilot --silent --no-ask-user --name "daemon-$name")
    [ -n "$model" ] && args+=(--model "$model")

    cd "\${cwd:-$HOME}"
    setsid copilot "\${args[@]}" >> "${homedir()}/.clawpilot/logs/daemon-$name.log" 2>&1 &

    mv "$f" "$PROCESSED/"
done
`,
    };
}

const session = await joinSession({
    tools: [
        {
            name: "clawpilot_daemon_setup",
            description:
                "Set up the Clawpilot daemon — a systemd path watcher that automatically processes messages " +
                "dropped into ~/.clawpilot/inbox/. When a JSON file appears, it spawns a Copilot session to handle it.",
            parameters: { type: "object", properties: {} },
            handler: async () => {
                await ensureDir(INBOX_DIR);
                await ensureDir(PROCESSED_DIR);
                await ensureDir(join(homedir(), ".clawpilot", "logs"));
                await ensureDir(SYSTEMD_DIR);

                const units = buildDaemonService();

                await writeFile(join(SYSTEMD_DIR, `${DAEMON_UNIT}.path`), units.path);
                await writeFile(join(SYSTEMD_DIR, `${DAEMON_UNIT}.service`), units.service);

                const handlerPath = join(homedir(), ".clawpilot", "daemon-handler.sh");
                await writeFile(handlerPath, units.handler, { mode: 0o755 });

                await exec("systemctl", ["--user", "daemon-reload"]);
                const result = await exec("systemctl", ["--user", "enable", "--now", `${DAEMON_UNIT}.path`]);

                if (!result.ok) {
                    return { textResultForLlm: `Setup failed: ${result.stderr}`, resultType: "failure" };
                }

                return `Daemon setup complete.\n• Inbox: ${INBOX_DIR}\n• Drop JSON files with {prompt, model?, cwd?} to trigger Copilot sessions.\n• Logs: ~/.clawpilot/logs/`;
            },
        },
        {
            name: "clawpilot_daemon_status",
            description: "Check if the Clawpilot daemon is running and show inbox status.",
            parameters: { type: "object", properties: {} },
            handler: async () => {
                const pathStatus = await exec("systemctl", ["--user", "is-active", `${DAEMON_UNIT}.path`]);

                await ensureDir(INBOX_DIR);
                await ensureDir(PROCESSED_DIR);
                let pending = 0, processed = 0;
                try {
                    pending = (await readdir(INBOX_DIR)).filter((f) => f.endsWith(".json")).length;
                } catch { /* ok */ }
                try {
                    processed = (await readdir(PROCESSED_DIR)).filter((f) => f.endsWith(".json")).length;
                } catch { /* ok */ }

                return `Daemon: ${pathStatus.stdout || "not installed"}\nInbox: ${pending} pending, ${processed} processed\nPath: ${INBOX_DIR}`;
            },
        },
        {
            name: "clawpilot_daemon_inbox",
            description: "Queue a message for the daemon to process. Creates a JSON file in the inbox that the daemon will pick up.",
            parameters: {
                type: "object",
                properties: {
                    prompt: { type: "string", description: "Task/prompt for the Copilot session" },
                    name: { type: "string", description: "Name for this task (default: timestamp)" },
                    model: { type: "string", description: "Model to use (optional)" },
                    cwd: { type: "string", description: "Working directory (optional)" },
                },
                required: ["prompt"],
            },
            handler: async (args) => {
                await ensureDir(INBOX_DIR);
                const name = args.name || `task-${Date.now()}`;
                const fileName = `${name.replace(/[^a-zA-Z0-9_-]/g, "-")}.json`;

                await writeFile(
                    join(INBOX_DIR, fileName),
                    JSON.stringify({
                        prompt: args.prompt,
                        model: args.model || null,
                        cwd: args.cwd || null,
                        queuedAt: new Date().toISOString(),
                    }, null, 2)
                );

                return `Queued '${name}' in daemon inbox. It will be processed automatically when the daemon picks it up.`;
            },
        },
        {
            name: "clawpilot_daemon_stop",
            description: "Stop the Clawpilot daemon.",
            parameters: { type: "object", properties: {} },
            handler: async () => {
                await exec("systemctl", ["--user", "stop", `${DAEMON_UNIT}.path`]);
                await exec("systemctl", ["--user", "disable", `${DAEMON_UNIT}.path`]);
                return "Daemon stopped and disabled. Use clawpilot_daemon_setup to restart.";
            },
        },
    ],
});
