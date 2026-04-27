// Clawpilot CLI — heartbeat extension
// Proactive background checks with session-start notification injection.
import { joinSession } from "@github/copilot-sdk/extension";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const HEARTBEAT_DIR = join(homedir(), ".clawpilot", "heartbeat");
const CONFIG_FILE = join(HEARTBEAT_DIR, "config.json");
const RESULTS_DIR = join(HEARTBEAT_DIR, "results");
const SYSTEMD_DIR = join(homedir(), ".config", "systemd", "user");

async function ensureDir(dir) {
    await mkdir(dir, { recursive: true });
}

function exec(cmd, args) {
    return new Promise((resolve) => {
        execFile(cmd, args, { timeout: 15000 }, (err, stdout, stderr) => {
            resolve({ ok: !err, stdout: stdout?.trim() || "", stderr: stderr?.trim() || "" });
        });
    });
}

async function loadConfig() {
    try {
        return JSON.parse(await readFile(CONFIG_FILE, "utf-8"));
    } catch {
        return { checks: [] };
    }
}

async function saveConfig(config) {
    await ensureDir(HEARTBEAT_DIR);
    await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));
}

async function getPendingResults() {
    await ensureDir(RESULTS_DIR);
    const files = await readdir(RESULTS_DIR);
    const results = [];
    for (const f of files) {
        if (!f.endsWith(".json")) continue;
        try {
            const data = JSON.parse(await readFile(join(RESULTS_DIR, f), "utf-8"));
            results.push(data);
        } catch { /* skip corrupt files */ }
    }
    return results;
}

function unitName(name) {
    return `clawpilot-hb-${name.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

// Heartbeat scheduled tasks write their results to a file.
// The prompt includes instructions to write results to the results dir.
function buildHeartbeatPrompt(name, userPrompt) {
    return (
        `${userPrompt}\n\n` +
        `IMPORTANT: After completing the check, write a brief JSON summary of your findings to ` +
        `${join(RESULTS_DIR, name + "-" + Date.now() + ".json")} with this structure: ` +
        `{"name":"${name}","timestamp":"<ISO>","summary":"<1-2 sentence summary>","urgent":true/false,"details":"<details>"}`
    );
}

function buildServiceUnit(name, prompt) {
    const escapedPrompt = prompt.replace(/'/g, "'\\''");
    return `[Unit]
Description=Clawpilot heartbeat: ${name}

[Service]
Type=oneshot
WorkingDirectory=${homedir()}
ExecStart=copilot -p '${escapedPrompt}' --allow-all --autopilot --silent --no-ask-user --name 'hb-${name}'
Environment=HOME=${homedir()}
Environment=PATH=${process.env.PATH}
StandardOutput=journal
StandardError=journal
`;
}

function buildTimerUnit(name, schedule) {
    return `[Unit]
Description=Clawpilot heartbeat timer: ${name}

[Timer]
OnCalendar=${schedule}
Persistent=true

[Install]
WantedBy=timers.target
`;
}

const session = await joinSession({
    tools: [
        {
            name: "clawpilot_heartbeat_add",
            description:
                "Add a proactive heartbeat check. Runs on a schedule and reports results when you start a new session. " +
                "Examples: check email hourly, check service health every 4 hours, daily code review.",
            parameters: {
                type: "object",
                properties: {
                    name: { type: "string", description: "Unique name for this heartbeat check" },
                    schedule: { type: "string", description: "systemd OnCalendar schedule (e.g., 'hourly', '*-*-* */4:00:00')" },
                    prompt: { type: "string", description: "What to check — this prompt runs in a background Copilot session" },
                },
                required: ["name", "schedule", "prompt"],
            },
            handler: async (args) => {
                const name = args.name.replace(/[^a-zA-Z0-9_-]/g, "-");
                const config = await loadConfig();

                if (config.checks.find((c) => c.name === name)) {
                    return { textResultForLlm: `Heartbeat '${name}' already exists. Remove it first.`, resultType: "failure" };
                }

                await ensureDir(RESULTS_DIR);
                await ensureDir(SYSTEMD_DIR);

                const fullPrompt = buildHeartbeatPrompt(name, args.prompt);
                const unit = unitName(name);

                await writeFile(join(SYSTEMD_DIR, `${unit}.service`), buildServiceUnit(name, fullPrompt));
                await writeFile(join(SYSTEMD_DIR, `${unit}.timer`), buildTimerUnit(name, args.schedule));

                await exec("systemctl", ["--user", "daemon-reload"]);
                await exec("systemctl", ["--user", "enable", "--now", `${unit}.timer`]);

                config.checks.push({
                    name,
                    schedule: args.schedule,
                    prompt: args.prompt,
                    createdAt: new Date().toISOString(),
                });
                await saveConfig(config);

                return `Heartbeat '${name}' added (${args.schedule}). Results will appear on session start.`;
            },
        },
        {
            name: "clawpilot_heartbeat_remove",
            description: "Remove a heartbeat check and its systemd timer.",
            parameters: {
                type: "object",
                properties: {
                    name: { type: "string", description: "Name of the heartbeat to remove" },
                },
                required: ["name"],
            },
            handler: async (args) => {
                const name = args.name.replace(/[^a-zA-Z0-9_-]/g, "-");
                const unit = unitName(name);

                await exec("systemctl", ["--user", "stop", `${unit}.timer`]);
                await exec("systemctl", ["--user", "disable", `${unit}.timer`]);

                for (const ext of [".service", ".timer"]) {
                    try { const { unlink } = await import("node:fs/promises"); await unlink(join(SYSTEMD_DIR, `${unit}${ext}`)); } catch { /* ok */ }
                }
                await exec("systemctl", ["--user", "daemon-reload"]);

                const config = await loadConfig();
                config.checks = config.checks.filter((c) => c.name !== name);
                await saveConfig(config);

                return `Heartbeat '${name}' removed.`;
            },
        },
        {
            name: "clawpilot_heartbeat_status",
            description: "Show all heartbeat checks, their schedules, and any pending results.",
            parameters: { type: "object", properties: {} },
            handler: async () => {
                const config = await loadConfig();
                const pending = await getPendingResults();

                if (config.checks.length === 0 && pending.length === 0) {
                    return "No heartbeat checks configured. Use clawpilot_heartbeat_add to create one.";
                }

                let output = "## Heartbeat Checks\n";
                for (const c of config.checks) {
                    const unit = unitName(c.name);
                    const status = await exec("systemctl", ["--user", "is-active", `${unit}.timer`]);
                    output += `• ${c.name} | ${c.schedule} | ${status.stdout || "unknown"}\n`;
                }

                if (pending.length > 0) {
                    output += `\n## Pending Results (${pending.length})\n`;
                    for (const r of pending.sort((a, b) => b.timestamp?.localeCompare(a.timestamp || "") || 0)) {
                        output += `${r.urgent ? "🔴" : "🟢"} ${r.name} (${r.timestamp}): ${r.summary}\n`;
                    }
                }

                return output;
            },
        },
        {
            name: "clawpilot_heartbeat_ack",
            description: "Acknowledge and clear pending heartbeat results.",
            parameters: {
                type: "object",
                properties: {
                    name: { type: "string", description: "Clear results for a specific check (omit to clear all)" },
                },
            },
            handler: async (args) => {
                await ensureDir(RESULTS_DIR);
                const files = await readdir(RESULTS_DIR);
                let cleared = 0;
                for (const f of files) {
                    if (!f.endsWith(".json")) continue;
                    if (args.name && !f.startsWith(args.name)) continue;
                    try { const { unlink } = await import("node:fs/promises"); await unlink(join(RESULTS_DIR, f)); cleared++; } catch { /* ok */ }
                }
                return `Cleared ${cleared} heartbeat result(s).`;
            },
        },
    ],
    hooks: {
        onSessionStart: async () => {
            const pending = await getPendingResults();
            if (pending.length === 0) return;

            const urgent = pending.filter((r) => r.urgent);
            const normal = pending.filter((r) => !r.urgent);

            let ctx = `[Clawpilot Heartbeat] ${pending.length} result(s) since last session:\n`;
            if (urgent.length > 0) {
                ctx += `\n🔴 URGENT (${urgent.length}):\n`;
                for (const r of urgent) {
                    ctx += `• ${r.name}: ${r.summary}\n`;
                    if (r.details) ctx += `  Details: ${r.details}\n`;
                }
            }
            if (normal.length > 0) {
                ctx += `\n🟢 Normal (${normal.length}):\n`;
                for (const r of normal) {
                    ctx += `• ${r.name}: ${r.summary}\n`;
                }
            }
            ctx += `\nUse clawpilot_heartbeat_ack to clear these, or clawpilot_heartbeat_status for details.`;

            return { additionalContext: ctx };
        },
    },
});
