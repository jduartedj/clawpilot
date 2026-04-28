// Clawpilot CLI — daemon extension
// Always-on message queue dispatcher.
// Watches ~/.clawpilot/inbox/ for message files and spawns Copilot sessions to handle them.
import { joinSession } from "@github/copilot-sdk/extension";
import { fileURLToPath } from "node:url";
import { writeFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { ensureDir, sanitizeName } from "../_lib/fs.mjs";
import { HOME, IS_WINDOWS, statePath } from "../_lib/platform.mjs";
import { activeStatus, daemonReload, enableNow, stopDisable, writeUserUnit } from "../_lib/systemd.mjs";
import { createOnLogonTask, deleteTask, endTask, queryTask } from "../_lib/taskscheduler.mjs";

const INBOX_DIR = statePath("inbox");
const PROCESSED_DIR = statePath("processed");
const DAEMON_UNIT = "clawpilot-daemon";
const WINDOWS_DAEMON_TASK = "Clawpilot-daemon";
const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const DAEMON_HANDLER = resolve(EXTENSION_DIR, "..", "_lib", "daemon-handler.mjs");

function buildDaemonService() {
    // The daemon is a systemd path unit that watches the inbox directory
    // When a file appears, it triggers the handler service
    return {
        path: `[Unit]
Description=Clawpilot inbox watcher

[Path]
PathExistsGlob=${INBOX_DIR}/*.json
MakeDirectory=yes

[Install]
WantedBy=default.target
`,
        service: `[Unit]
Description=Clawpilot inbox handler

[Service]
Type=oneshot
KillMode=process
ExecStart=/usr/bin/env node ${DAEMON_HANDLER}
Environment=HOME=${HOME}
Environment=PATH=${process.env.PATH}
StandardOutput=journal
StandardError=journal
`,
    };
}

function quoteWin(value) {
    return `"${String(value).replace(/"/g, '\\"')}"`;
}

function quotePowerShellLiteral(value) {
    return `'${String(value).replace(/'/g, "''")}'`;
}

function buildWindowsDaemonCommand() {
    const command = [
        "&",
        quotePowerShellLiteral(process.execPath),
        quotePowerShellLiteral(DAEMON_HANDLER),
        "--watch",
    ].join(" ");
    return [
        "powershell.exe",
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-Command", quoteWin(command),
    ].join(" ");
}

const session = await joinSession({
    tools: [
        {
            name: "clawpilot_daemon_setup",
            description:
                "Set up the Clawpilot daemon — a systemd path watcher on Linux or logon Task Scheduler watcher on Windows. " +
                "It automatically processes messages dropped into the Clawpilot inbox. When a JSON file appears, it spawns a Copilot session to handle it.",
            parameters: { type: "object", properties: {} },
            handler: async () => {
                await ensureDir(INBOX_DIR);
                await ensureDir(PROCESSED_DIR);
                await ensureDir(statePath("logs"));

                if (IS_WINDOWS) {
                    const result = await createOnLogonTask({
                        name: WINDOWS_DAEMON_TASK,
                        command: buildWindowsDaemonCommand(),
                    });
                    if (!result.ok) {
                        return { textResultForLlm: `Setup failed: ${result.stderr}`, resultType: "failure" };
                    }
                    return `Daemon setup complete.\n• Inbox: ${INBOX_DIR}\n• Drop JSON files with {prompt, model?, cwd?} to trigger Copilot sessions.\n• Task: ${WINDOWS_DAEMON_TASK} (runs at logon)\n• Start now: schtasks /Run /TN ${WINDOWS_DAEMON_TASK}\n• Logs: ${statePath("logs")}`;
                }

                const units = buildDaemonService();

                await writeUserUnit(`${DAEMON_UNIT}.path`, units.path);
                await writeUserUnit(`${DAEMON_UNIT}.service`, units.service);

                await daemonReload();
                const result = await enableNow(`${DAEMON_UNIT}.path`);

                if (!result.ok) {
                    return { textResultForLlm: `Setup failed: ${result.stderr}`, resultType: "failure" };
                }

                return `Daemon setup complete.\n• Inbox: ${INBOX_DIR}\n• Drop JSON files with {prompt, model?, cwd?} to trigger Copilot sessions.\n• Handler: ${DAEMON_HANDLER}\n• Logs: ~/.clawpilot/logs/`;
            },
        },
        {
            name: "clawpilot_daemon_status",
            description: "Check if the Clawpilot daemon is running and show inbox status.",
            parameters: { type: "object", properties: {} },
            handler: async () => {
                const pathStatus = IS_WINDOWS
                    ? await queryTask(WINDOWS_DAEMON_TASK)
                    : await activeStatus(`${DAEMON_UNIT}.path`);

                await ensureDir(INBOX_DIR);
                await ensureDir(PROCESSED_DIR);
                let pending = 0, processed = 0;
                try {
                    pending = (await readdir(INBOX_DIR)).filter((f) => f.endsWith(".json")).length;
                } catch { /* ok */ }
                try {
                    processed = (await readdir(PROCESSED_DIR)).filter((f) => f.endsWith(".json")).length;
                } catch { /* ok */ }

                const statusText = IS_WINDOWS
                    ? (pathStatus.ok ? `installed (${WINDOWS_DAEMON_TASK})` : "not installed")
                    : (pathStatus.stdout || "not installed");
                return `Daemon: ${statusText}\nInbox: ${pending} pending, ${processed} processed\nPath: ${INBOX_DIR}`;
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
                const fileName = `${sanitizeName(name)}.json`;

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
                if (IS_WINDOWS) {
                    await endTask(WINDOWS_DAEMON_TASK);
                    const result = await deleteTask(WINDOWS_DAEMON_TASK);
                    if (!result.ok) {
                        return { textResultForLlm: `Failed to remove Windows daemon task: ${result.stderr}`, resultType: "failure" };
                    }
                    return "Daemon stopped and disabled. Use clawpilot_daemon_setup to restart.";
                }
                await stopDisable(`${DAEMON_UNIT}.path`);
                return "Daemon stopped and disabled. Use clawpilot_daemon_setup to restart.";
            },
        },
    ],
});
