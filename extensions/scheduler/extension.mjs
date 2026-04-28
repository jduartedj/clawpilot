// Clawpilot CLI — scheduler extension
// Schedule recurring tasks via systemd user timers.
import { joinSession } from "@github/copilot-sdk/extension";
import { execFile } from "node:child_process";
import { mkdir, writeFile, unlink, readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const SYSTEMD_DIR = join(homedir(), ".config", "systemd", "user");
const STATE_DIR = join(homedir(), ".clawpilot", "scheduler");
const COPILOT_BIN = "copilot";

async function ensureDir(dir) {
    await mkdir(dir, { recursive: true });
}

function exec(cmd, args) {
    return new Promise((resolve) => {
        execFile(cmd, args, { timeout: 15000 }, (err, stdout, stderr) => {
            resolve({ ok: !err, stdout: stdout?.trim() || "", stderr: stderr?.trim() || "", code: err?.code });
        });
    });
}

function unitName(name) {
    return `clawpilot-${name.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function buildServiceUnit(name, cwd, model) {
    // Prompt is stored in a separate file, not inline in the unit
    const promptFile = join(STATE_DIR, `${name}.prompt`);
    const modelArg = model ? ` --model "${model.replace(/[\r\n"]/g, "")}"` : "";
    return `[Unit]
Description=Clawpilot scheduled task: ${name.replace(/[\r\n]/g, "")}

[Service]
Type=oneshot
WorkingDirectory=${cwd.replace(/[\r\n]/g, "")}
ExecStart=/bin/bash -c 'exec ${COPILOT_BIN} -p "$$(cat "${promptFile}")" --allow-all --autopilot --silent --no-ask-user --name "sched-${name.replace(/[\r\n"]/g, "")}"${modelArg}'
Environment=HOME=${homedir()}
Environment=PATH=${process.env.PATH}
StandardOutput=journal
StandardError=journal
`;
}

function buildTimerUnit(name, schedule) {
    return `[Unit]
Description=Clawpilot timer: ${name.replace(/[\r\n]/g, "")}

[Timer]
OnCalendar=${schedule.replace(/[\r\n]/g, "")}
Persistent=true
RandomizedDelaySec=30

[Install]
WantedBy=timers.target
`;
}

const session = await joinSession({
    tools: [
        {
            name: "clawpilot_schedule",
            description:
                "Schedule a recurring Copilot CLI task using systemd user timers. " +
                "The task runs `copilot -p` on the specified schedule. " +
                "Schedule uses systemd OnCalendar syntax: 'hourly', 'daily', '*-*-* 08:00:00', 'Mon *-*-* 09:00:00', etc.",
            parameters: {
                type: "object",
                properties: {
                    name: { type: "string", description: "Unique name for this scheduled task" },
                    schedule: {
                        type: "string",
                        description: "systemd OnCalendar schedule (e.g., 'hourly', 'daily', '*-*-* 08:00:00', '*-*-* */4:00:00')",
                    },
                    prompt: { type: "string", description: "The prompt/task for the scheduled Copilot session" },
                    cwd: { type: "string", description: "Working directory (default: home directory)" },
                    model: { type: "string", description: "Model to use (omit for default)" },
                },
                required: ["name", "schedule", "prompt"],
            },
            handler: async (args) => {
                const name = args.name.replace(/[^a-zA-Z0-9_-]/g, "-");
                const unit = unitName(name);
                const cwd = args.cwd || homedir();

                await ensureDir(SYSTEMD_DIR);
                await ensureDir(STATE_DIR);

                if (/[\r\n]/.test(args.schedule)) {
                    return { textResultForLlm: "Schedule must not contain newlines.", resultType: "failure" };
                }

                // Write prompt to a separate file (not inline in unit)
                const promptFile = join(STATE_DIR, `${name}.prompt`);
                await writeFile(promptFile, args.prompt, { mode: 0o600 });

                // Write service unit
                await writeFile(
                    join(SYSTEMD_DIR, `${unit}.service`),
                    buildServiceUnit(name, cwd, args.model)
                );

                // Write timer unit
                await writeFile(
                    join(SYSTEMD_DIR, `${unit}.timer`),
                    buildTimerUnit(name, args.schedule)
                );

                // Save metadata
                await writeFile(
                    join(STATE_DIR, `${name}.json`),
                    JSON.stringify({
                        name,
                        schedule: args.schedule,
                        prompt: args.prompt,
                        cwd,
                        model: args.model || "default",
                        createdAt: new Date().toISOString(),
                    }, null, 2)
                );

                // Enable and start
                await exec("systemctl", ["--user", "daemon-reload"]);
                const result = await exec("systemctl", ["--user", "enable", "--now", `${unit}.timer`]);

                if (!result.ok) {
                    return { textResultForLlm: `Failed to enable timer: ${result.stderr}`, resultType: "failure" };
                }

                // Get next run time
                const status = await exec("systemctl", ["--user", "status", `${unit}.timer`, "--no-pager"]);

                return `Scheduled '${name}' (${args.schedule})\nUnit: ${unit}\n${status.stdout}`;
            },
        },
        {
            name: "clawpilot_schedule_list",
            description: "List all scheduled Clawpilot tasks with their next run time.",
            parameters: { type: "object", properties: {} },
            handler: async () => {
                const result = await exec("systemctl", [
                    "--user", "list-timers", "clawpilot-*", "--no-pager", "--all",
                ]);
                if (!result.stdout || result.stdout.includes("0 timers")) {
                    return "No scheduled tasks.";
                }
                return result.stdout;
            },
        },
        {
            name: "clawpilot_schedule_cancel",
            description: "Cancel and remove a scheduled task.",
            parameters: {
                type: "object",
                properties: {
                    name: { type: "string", description: "Name of the scheduled task to cancel" },
                },
                required: ["name"],
            },
            handler: async (args) => {
                const name = args.name.replace(/[^a-zA-Z0-9_-]/g, "-");
                const unit = unitName(name);

                await exec("systemctl", ["--user", "stop", `${unit}.timer`]);
                await exec("systemctl", ["--user", "disable", `${unit}.timer`]);

                const servicePath = join(SYSTEMD_DIR, `${unit}.service`);
                const timerPath = join(SYSTEMD_DIR, `${unit}.timer`);
                const metaPath = join(STATE_DIR, `${name}.json`);

                for (const f of [servicePath, timerPath, metaPath]) {
                    try { await unlink(f); } catch { /* ignore */ }
                }

                await exec("systemctl", ["--user", "daemon-reload"]);
                return `Cancelled and removed scheduled task '${name}'.`;
            },
        },
        {
            name: "clawpilot_schedule_run_now",
            description: "Manually trigger a scheduled task to run immediately.",
            parameters: {
                type: "object",
                properties: {
                    name: { type: "string", description: "Name of the scheduled task to trigger" },
                },
                required: ["name"],
            },
            handler: async (args) => {
                const name = args.name.replace(/[^a-zA-Z0-9_-]/g, "-");
                const unit = unitName(name);
                const result = await exec("systemctl", ["--user", "start", `${unit}.service`]);

                if (!result.ok) {
                    return { textResultForLlm: `Failed to start: ${result.stderr}`, resultType: "failure" };
                }
                return `Triggered '${name}' — check logs with clawpilot_schedule_logs.`;
            },
        },
        {
            name: "clawpilot_schedule_logs",
            description: "View logs from a scheduled task's recent runs.",
            parameters: {
                type: "object",
                properties: {
                    name: { type: "string", description: "Name of the scheduled task" },
                    lines: { type: "number", description: "Number of log lines (default: 100)" },
                },
                required: ["name"],
            },
            handler: async (args) => {
                const name = args.name.replace(/[^a-zA-Z0-9_-]/g, "-");
                const unit = unitName(name);
                const result = await exec("journalctl", [
                    "--user", "-u", `${unit}.service`, "--no-pager",
                    "-n", String(args.lines || 100),
                ]);
                return result.stdout || "(no logs yet)";
            },
        },
    ],
});
