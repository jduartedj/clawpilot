// PilotClaw CLI — heartbeat extension
// Proactive background checks with session-start notification injection.
import { joinSession } from "@github/copilot-sdk/extension";
import { readFile, writeFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { ensureDir, sanitizeName } from "../_lib/fs.mjs";
import { HOME, IS_WINDOWS, statePath } from "../_lib/platform.mjs";
import { activeStatus, daemonReload, enableNow, removeUserUnit, stopDisable, unitName as systemdUnitName, writeUserUnit } from "../_lib/systemd.mjs";
import { createScheduledCopilotTask, deleteTask, queryTask, taskName as windowsTaskName } from "../_lib/taskscheduler.mjs";

const HEARTBEAT_DIR = statePath("heartbeat");
const CONFIG_FILE = join(HEARTBEAT_DIR, "config.json");
const RESULTS_DIR = join(HEARTBEAT_DIR, "results");

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
    return systemdUnitName("pilotclaw-hb", name);
}

function scheduledTaskName(name) {
    return windowsTaskName("hb", name);
}

// Heartbeat scheduled tasks write their results to a file.
// The prompt includes instructions to write results to the results dir.
function buildHeartbeatPrompt(name, userPrompt) {
    // Use a dynamic filename pattern — the LLM will substitute the actual timestamp
    return (
        `${userPrompt}\n\n` +
        `IMPORTANT: After completing the check, write a brief JSON summary of your findings to ` +
        `${RESULTS_DIR}/${name}-TIMESTAMP.json (replace TIMESTAMP with the current unix timestamp) ` +
        `with this structure: ` +
        `{"name":"${name}","timestamp":"<ISO date>","summary":"<1-2 sentence summary>","urgent":true/false,"details":"<details>"}`
    );
}

function buildServiceUnit(name, prompt) {
    // Store prompt in a file, not inline in the unit
    const promptFile = join(HEARTBEAT_DIR, `${name}.prompt`);
    return `[Unit]
Description=PilotClaw heartbeat: ${name.replace(/[\r\n]/g, "")}

[Service]
Type=oneshot
WorkingDirectory=${HOME}
ExecStart=/bin/bash -c 'exec copilot -p "$$(cat "${promptFile}")" --allow-all --autopilot --silent --no-ask-user --name "hb-${name.replace(/[\r\n"]/g, "")}"'
Environment=HOME=${HOME}
Environment=PATH=${process.env.PATH}
StandardOutput=journal
StandardError=journal
`;
}

function buildTimerUnit(name, schedule) {
    return `[Unit]
Description=PilotClaw heartbeat timer: ${name}

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
            name: "pilotclaw_heartbeat_add",
            description:
                "Add a proactive heartbeat check. Runs on a schedule and reports results when you start a new session. " +
                "Uses systemd timers on Linux and Task Scheduler on Windows. " +
                "Examples: check email hourly, check service health every 4 hours, daily code review.",
            parameters: {
                type: "object",
                properties: {
                    name: { type: "string", description: "Unique name for this heartbeat check" },
                    schedule: { type: "string", description: "Schedule (Linux systemd OnCalendar; Windows supported subset: hourly, daily, weekly, every N hours/minutes)" },
                    prompt: { type: "string", description: "What to check — this prompt runs in a background Copilot session" },
                },
                required: ["name", "schedule", "prompt"],
            },
            handler: async (args) => {
                const name = sanitizeName(args.name);
                const config = await loadConfig();

                if (config.checks.find((c) => c.name === name)) {
                    return { textResultForLlm: `Heartbeat '${name}' already exists. Remove it first.`, resultType: "failure" };
                }

                if (/[\r\n]/.test(args.schedule)) {
                    return { textResultForLlm: "Schedule must not contain newlines.", resultType: "failure" };
                }

                await ensureDir(RESULTS_DIR);

                const fullPrompt = buildHeartbeatPrompt(name, args.prompt);
                const unit = unitName(name);

                // Write prompt to file (not inline in unit)
                const promptFile = join(HEARTBEAT_DIR, `${name}.prompt`);
                await writeFile(promptFile, fullPrompt, { mode: 0o600 });

                if (IS_WINDOWS) {
                    let created;
                    try {
                        created = await createScheduledCopilotTask({
                            name,
                            prefix: "hb",
                            schedule: args.schedule,
                            prompt: fullPrompt,
                            cwd: HOME,
                            stateDir: HEARTBEAT_DIR,
                            copilotName: `hb-${name}`,
                        });
                    } catch (err) {
                        return { textResultForLlm: err.message, resultType: "failure" };
                    }
                    if (!created.ok) {
                        return { textResultForLlm: `Failed to create Windows heartbeat task: ${created.stderr}`, resultType: "failure" };
                    }

                    config.checks.push({
                        name,
                        schedule: args.schedule,
                        prompt: args.prompt,
                        createdAt: new Date().toISOString(),
                    });
                    await saveConfig(config);
                    return `Heartbeat '${name}' added (${args.schedule}). Windows task: ${created.taskName}. Results will appear on session start.`;
                }

                await writeUserUnit(`${unit}.service`, buildServiceUnit(name, fullPrompt));
                await writeUserUnit(`${unit}.timer`, buildTimerUnit(name, args.schedule));

                await daemonReload();
                await enableNow(`${unit}.timer`);

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
            name: "pilotclaw_heartbeat_remove",
            description: "Remove a heartbeat check and its systemd timer.",
            parameters: {
                type: "object",
                properties: {
                    name: { type: "string", description: "Name of the heartbeat to remove" },
                },
                required: ["name"],
            },
            handler: async (args) => {
                const name = sanitizeName(args.name);
                const unit = unitName(name);

                if (IS_WINDOWS) {
                    const result = await deleteTask(scheduledTaskName(name));
                    if (!result.ok) {
                        return { textResultForLlm: `Failed to delete Windows heartbeat task: ${result.stderr}`, resultType: "failure" };
                    }
                    try { await unlink(join(HEARTBEAT_DIR, `${name}.prompt`)); } catch { /* ok */ }
                    try { await unlink(join(HEARTBEAT_DIR, `${name}.json`)); } catch { /* ok */ }
                    try { await unlink(join(HEARTBEAT_DIR, `${name}.ps1`)); } catch { /* ok */ }

                    const config = await loadConfig();
                    config.checks = config.checks.filter((c) => c.name !== name);
                    await saveConfig(config);

                    return `Heartbeat '${name}' removed.`;
                }

                await stopDisable(`${unit}.timer`);

                await removeUserUnit(`${unit}.service`);
                await removeUserUnit(`${unit}.timer`);
                try { await unlink(join(HEARTBEAT_DIR, `${name}.prompt`)); } catch { /* ok */ }
                await daemonReload();

                const config = await loadConfig();
                config.checks = config.checks.filter((c) => c.name !== name);
                await saveConfig(config);

                return `Heartbeat '${name}' removed.`;
            },
        },
        {
            name: "pilotclaw_heartbeat_status",
            description: "Show all heartbeat checks, their schedules, and any pending results.",
            parameters: { type: "object", properties: {} },
            handler: async () => {
                const config = await loadConfig();
                const pending = await getPendingResults();

                if (config.checks.length === 0 && pending.length === 0) {
                    return "No heartbeat checks configured. Use pilotclaw_heartbeat_add to create one.";
                }

                let output = "## Heartbeat Checks\n";
                for (const c of config.checks) {
                    let statusText;
                    if (IS_WINDOWS) {
                        const result = await queryTask(scheduledTaskName(c.name));
                        statusText = result.ok ? "installed" : "not installed";
                    } else {
                        const unit = unitName(c.name);
                        const result = await activeStatus(`${unit}.timer`);
                        statusText = result.stdout || "unknown";
                    }
                    output += `• ${c.name} | ${c.schedule} | ${statusText}\n`;
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
            name: "pilotclaw_heartbeat_ack",
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
                    if (args.name && !f.startsWith(args.name + "-")) continue;
                    try { await unlink(join(RESULTS_DIR, f)); cleared++; } catch { /* ok */ }
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

            let ctx = `[PilotClaw Heartbeat] ${pending.length} result(s) since last session:\n`;
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
            ctx += `\nUse pilotclaw_heartbeat_ack to clear these, or pilotclaw_heartbeat_status for details.`;

            return { additionalContext: ctx };
        },
    },
});
