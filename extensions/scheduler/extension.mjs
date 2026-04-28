// Clawpilot CLI — scheduler extension
// Schedule recurring tasks via systemd user timers.
import { joinSession } from "@github/copilot-sdk/extension";
import { writeFile, unlink, readFile } from "node:fs/promises";
import { join } from "node:path";
import { HOME, COPILOT_BIN, IS_WINDOWS, statePath } from "../_lib/platform.mjs";
import { ensureDir, readJsonFile, sanitizeName } from "../_lib/fs.mjs";
import { daemonReload, enableNow, journalLogs, listTimers, removeUserUnit, runTransientUnit, startUnit, statusUnit, stopDisable, unitName as systemdUnitName, writeUserUnit } from "../_lib/systemd.mjs";
import { createScheduledCopilotTask, deleteTask, queryAllTasks, queryTask, readTaskMeta, runTask, taskLog, taskName as windowsTaskName } from "../_lib/taskscheduler.mjs";

const STATE_DIR = statePath("scheduler");
const OPENCLAW_CRON_DIR = join(HOME, ".openclaw", "cron");
const OPENCLAW_JOBS_FILE = join(OPENCLAW_CRON_DIR, "jobs.json");
const OPENCLAW_STATE_FILE = join(OPENCLAW_CRON_DIR, "jobs-state.json");
const OPENCLAW_RUNS_DIR = join(OPENCLAW_CRON_DIR, "runs");
const OPENCLAW_WORKSPACE = join(HOME, "clawd");

function unitName(name) {
    return systemdUnitName("clawpilot", name);
}

function scheduledTaskName(name) {
    return windowsTaskName("sched", name);
}

function shellSingleQuote(value) {
    return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function formatDate(ms) {
    if (!ms) return "-";
    return new Date(ms).toISOString();
}

function openclawRef(job) {
    return `openclaw:${job.id}`;
}

function formatDuration(ms) {
    if (!Number.isFinite(ms)) return "-";
    if (ms % 86400000 === 0) return `${ms / 86400000}d`;
    if (ms % 3600000 === 0) return `${ms / 3600000}h`;
    if (ms % 60000 === 0) return `${ms / 60000}m`;
    if (ms % 1000 === 0) return `${ms / 1000}s`;
    return `${ms}ms`;
}

function formatOpenClawSchedule(schedule) {
    if (!schedule || typeof schedule !== "object") return "-";
    if (schedule.kind === "cron") return `${schedule.expr || "-"} ${schedule.tz || ""}`.trim();
    if (schedule.kind === "every") return `every ${formatDuration(Number(schedule.everyMs))}`;
    if (schedule.kind === "at") return `at ${schedule.at || "-"}`;
    return schedule.kind || "-";
}

async function readOpenClawCrons() {
    const jobsDoc = await readJsonFile(OPENCLAW_JOBS_FILE, { jobs: [] });
    const stateDoc = await readJsonFile(OPENCLAW_STATE_FILE, { jobs: {} });
    const jobs = Array.isArray(jobsDoc.jobs) ? jobsDoc.jobs : [];
    const states = stateDoc.jobs && typeof stateDoc.jobs === "object" ? stateDoc.jobs : {};
    return { jobs, states };
}

async function findOpenClawJob(ref) {
    if (!String(ref || "").startsWith("openclaw:")) return null;
    const needle = String(ref).slice("openclaw:".length).trim();
    if (!needle) return null;

    const { jobs, states } = await readOpenClawCrons();
    const normalizedNeedle = sanitizeName(needle).toLowerCase();
    const job = jobs.find((candidate) => {
        const id = String(candidate.id || "");
        return id === needle ||
            id.startsWith(needle) ||
            sanitizeName(candidate.name).toLowerCase() === normalizedNeedle;
    });
    if (!job) return null;
    return { job, state: states[job.id]?.state || {} };
}

function formatOpenClawCronList(jobs, states) {
    if (!jobs.length) return "No OpenClaw crons found.";
    const header = "SOURCE     REF                                      NEXT RUN                  LAST STATUS  SCHEDULE                 NAME";
    const rows = jobs
        .slice()
        .sort((a, b) => (states[a.id]?.state?.nextRunAtMs || Number.MAX_SAFE_INTEGER) -
            (states[b.id]?.state?.nextRunAtMs || Number.MAX_SAFE_INTEGER))
        .map((job) => {
            const state = states[job.id]?.state || {};
            const schedule = formatOpenClawSchedule(job.schedule);
            const status = job.enabled === false ? "disabled" : (state.lastStatus || "-");
            return [
                "openclaw",
                openclawRef(job),
                formatDate(state.nextRunAtMs),
                status,
                schedule,
                job.name || "(unnamed)",
            ].join("  ");
        });
    return [header, ...rows].join("\n");
}

function buildOpenClawPrompt(job) {
    const message = job.payload?.message || "";
    return [
        `Imported OpenClaw cron: ${job.name || job.id}`,
        `OpenClaw job ID: ${job.id}`,
        `OpenClaw agent ID: ${job.agentId || "main"}`,
        "",
        "Run the original cron task below as a Clawpilot scheduled task.",
        "",
        message,
    ].join("\n");
}

async function runOpenClawJob(job) {
    await ensureDir(STATE_DIR);
    const slug = sanitizeName(`${job.name || job.id}-${String(job.id || "").slice(0, 8)}`) || "openclaw-cron";
    const promptFile = join(STATE_DIR, `${slug}.openclaw.prompt`);
    const unit = `clawpilot-openclaw-${slug}-${Date.now()}`;
    const cwd = OPENCLAW_WORKSPACE;
    await writeFile(promptFile, buildOpenClawPrompt(job), { mode: 0o600 });

    if (IS_WINDOWS) {
        const { spawnDetachedCopilot } = await import("../_lib/spawn-backend.mjs");
        const logPath = join(STATE_DIR, `${slug}.openclaw.log`);
        const child = spawnDetachedCopilot({
            prompt: buildOpenClawPrompt(job),
            name: `openclaw-cron-${slug}`,
            cwd,
            logPath,
        });
        return `Triggered imported OpenClaw cron '${job.name || job.id}'.\nPID: ${child.pid}\nLog: ${logPath}`;
    }

    const command = `exec ${COPILOT_BIN} -p "$(cat ${shellSingleQuote(promptFile)})" --allow-all --autopilot --silent --no-ask-user --name ${shellSingleQuote(`openclaw-cron-${slug}`)}`;
    const result = await runTransientUnit({ unit, cwd, command });
    if (!result.ok) {
        return { textResultForLlm: `Failed to trigger imported OpenClaw cron: ${result.stderr}`, resultType: "failure" };
    }
    return `Triggered imported OpenClaw cron '${job.name || job.id}'.\nUnit: ${unit}\nLogs: journalctl --user -u ${unit} --no-pager`;
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
Environment=HOME=${HOME}
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
                "On Windows, uses Task Scheduler for the supported schedule subset. " +
                "The task runs `copilot -p` on the specified schedule. " +
                "Schedule uses systemd OnCalendar syntax on Linux and compatible subset syntax on Windows: 'hourly', 'daily', '*-*-* 08:00:00', 'Mon *-*-* 09:00:00', etc.",
            parameters: {
                type: "object",
                properties: {
                    name: { type: "string", description: "Unique name for this scheduled task" },
                    schedule: {
                        type: "string",
                        description: "Schedule (Linux systemd OnCalendar; Windows supported subset: hourly, daily, weekly, '*-*-* HH:MM[:SS]', 'Mon *-*-* HH:MM[:SS]', every N minutes/hours)",
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
                const cwd = args.cwd || HOME;

                await ensureDir(STATE_DIR);

                if (/[\r\n]/.test(args.schedule)) {
                    return { textResultForLlm: "Schedule must not contain newlines.", resultType: "failure" };
                }

                // Write prompt to a separate file (not inline in unit)
                const promptFile = join(STATE_DIR, `${name}.prompt`);
                await writeFile(promptFile, args.prompt, { mode: 0o600 });

                if (IS_WINDOWS) {
                    let created;
                    try {
                        created = await createScheduledCopilotTask({
                            name,
                            prefix: "sched",
                            schedule: args.schedule,
                            prompt: args.prompt,
                            cwd,
                            model: args.model,
                            stateDir: STATE_DIR,
                            copilotName: `sched-${name}`,
                        });
                    } catch (err) {
                        return { textResultForLlm: err.message, resultType: "failure" };
                    }
                    if (!created.ok) {
                        return { textResultForLlm: `Failed to create Windows scheduled task: ${created.stderr}`, resultType: "failure" };
                    }
                    return `Scheduled '${name}' (${args.schedule})\nTask: ${created.taskName}\nLog: ${created.logFile}\n${created.stdout}`;
                }

                // Write service unit
                await writeUserUnit(`${unit}.service`, buildServiceUnit(name, cwd, args.model));

                // Write timer unit
                await writeUserUnit(`${unit}.timer`, buildTimerUnit(name, args.schedule));

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
                await daemonReload();
                const result = await enableNow(`${unit}.timer`);

                if (!result.ok) {
                    return { textResultForLlm: `Failed to enable timer: ${result.stderr}`, resultType: "failure" };
                }

                // Get next run time
                const status = await statusUnit(`${unit}.timer`);

                return `Scheduled '${name}' (${args.schedule})\nUnit: ${unit}\n${status.stdout}`;
            },
        },
        {
            name: "clawpilot_schedule_list",
            description: "List all scheduled Clawpilot tasks with their next run time, including imported OpenClaw crons if present.",
            parameters: { type: "object", properties: {} },
            handler: async () => {
                if (IS_WINDOWS) {
                    const result = await queryAllTasks();
                    const local = result.ok
                        ? (result.stdout.split(/\r?\n\r?\n/).filter((block) => block.includes("TaskName:") && block.includes("Clawpilot-sched-")).join("\n\n") || "No native Clawpilot scheduled tasks.")
                        : `Failed to query Windows scheduled tasks: ${result.stderr}`;
                    const { jobs, states } = await readOpenClawCrons();
                    return `${local}\n\n${formatOpenClawCronList(jobs, states)}`;
                }
                const result = await listTimers("clawpilot-*");
                const local = (!result.stdout || result.stdout.includes("0 timers"))
                    ? "No native Clawpilot scheduled tasks."
                    : result.stdout;
                const { jobs, states } = await readOpenClawCrons();
                return `${local}\n\n${formatOpenClawCronList(jobs, states)}`;
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
                const openclaw = await findOpenClawJob(args.name);
                if (openclaw) {
                    return {
                        textResultForLlm:
                            "Imported OpenClaw crons are read-only in Clawpilot. Disable or delete them with OpenClaw's cron tools.",
                        resultType: "failure",
                    };
                }

                const name = args.name.replace(/[^a-zA-Z0-9_-]/g, "-");
                const unit = unitName(name);

                if (IS_WINDOWS) {
                    const result = await deleteTask(scheduledTaskName(name));
                    if (!result.ok) {
                        return { textResultForLlm: `Failed to delete Windows scheduled task: ${result.stderr}`, resultType: "failure" };
                    }
                    const promptPath = join(STATE_DIR, `${name}.prompt`);
                    const metaPath = join(STATE_DIR, `${name}.json`);
                    try { await unlink(promptPath); } catch { /* ignore */ }
                    try { await unlink(metaPath); } catch { /* ignore */ }
                    return `Cancelled and removed scheduled task '${name}'.`;
                }

                await stopDisable(`${unit}.timer`);

                const promptPath = join(STATE_DIR, `${name}.prompt`);
                const metaPath = join(STATE_DIR, `${name}.json`);

                await removeUserUnit(`${unit}.service`);
                await removeUserUnit(`${unit}.timer`);
                try { await unlink(promptPath); } catch { /* ignore */ }
                try { await unlink(metaPath); } catch { /* ignore */ }

                await daemonReload();
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
                const openclaw = await findOpenClawJob(args.name);
                if (openclaw) {
                    return runOpenClawJob(openclaw.job);
                }

                const name = args.name.replace(/[^a-zA-Z0-9_-]/g, "-");
                const unit = unitName(name);
                if (IS_WINDOWS) {
                    const result = await runTask(scheduledTaskName(name));
                    if (!result.ok) {
                        return { textResultForLlm: `Failed to start Windows scheduled task: ${result.stderr}`, resultType: "failure" };
                    }
                    return `Triggered '${name}' — check logs with clawpilot_schedule_logs.`;
                }
                const result = await startUnit(`${unit}.service`);

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
                const openclaw = await findOpenClawJob(args.name);
                if (openclaw) {
                    const lines = Number(args.lines || 100);
                    try {
                        const content = await readFile(join(OPENCLAW_RUNS_DIR, `${openclaw.job.id}.jsonl`), "utf8");
                        const tail = content.trimEnd().split("\n").slice(-lines).join("\n");
                        return tail || "(no OpenClaw logs yet)";
                    } catch (err) {
                        if (err?.code === "ENOENT") return "(no OpenClaw logs yet)";
                        throw err;
                    }
                }

                const name = args.name.replace(/[^a-zA-Z0-9_-]/g, "-");
                const unit = unitName(name);
                if (IS_WINDOWS) {
                    const meta = await readTaskMeta(STATE_DIR, name);
                    const taskStatus = await queryTask(meta?.taskName || scheduledTaskName(name));
                    const logs = await taskLog(STATE_DIR, name, args.lines || 100);
                    return `${taskStatus.stdout || taskStatus.stderr || "(task not found)"}\n\n--- log ---\n${logs}`;
                }
                const result = await journalLogs(`${unit}.service`, args.lines || 100);
                return result.stdout || "(no logs yet)";
            },
        },
    ],
});
