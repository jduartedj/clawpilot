import { execFile } from "node:child_process";
import { readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureDir, readJsonFile, sanitizeName } from "./fs.mjs";
import { exec } from "./exec.mjs";
import { gatewayCapabilities, unsupportedCapability } from "./gateway-capabilities.mjs";
import { COPILOT_BIN, HOME, IS_WINDOWS, CLAWPILOT_STATE_DIR, compatStatePath, statePath } from "./platform.mjs";
import { createScheduledCopilotTask, deleteTask, queryAllTasks, queryTask, runTask, taskLog, taskName as windowsTaskName } from "./taskscheduler.mjs";
import { daemonReload, enableNow, journalLogs, listTimers, removeUserUnit, runTransientUnit, startUnit, stopDisable, unitName as systemdUnitName, writeUserUnit } from "./systemd.mjs";
import { validateGatewayCwd } from "./gateway-cwd.mjs";

const SCHEDULER_DIR = statePath("scheduler");
const HEARTBEAT_DIR = statePath("heartbeat");
const HEARTBEAT_RESULTS_DIR = join(HEARTBEAT_DIR, "results");
const CHANNELS_CONFIG_FILE = compatStatePath("channels", "config.json");
const VAULT_DIR = compatStatePath("vault");
const MEMORY_DB = compatStatePath("memory.db");
const OPENCLAW_CRON_DIR = join(HOME, ".openclaw", "cron");
const OPENCLAW_JOBS_FILE = join(OPENCLAW_CRON_DIR, "jobs.json");
const OPENCLAW_STATE_FILE = join(OPENCLAW_CRON_DIR, "jobs-state.json");
const OPENCLAW_RUNS_DIR = join(OPENCLAW_CRON_DIR, "runs");
const OPENCLAW_WORKSPACE = join(HOME, "clawd");

function shellSingleQuote(value) {
    return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function scheduleUnitName(name) {
    return systemdUnitName("clawpilot", name);
}

function heartbeatUnitName(name) {
    return systemdUnitName("clawpilot-hb", name);
}

function linuxScheduleService(name, cwd, model) {
    const promptFile = join(SCHEDULER_DIR, `${name}.prompt`);
    const modelArgs = model ? ` --model ${shellSingleQuote(model)}` : "";
    return `[Unit]
Description=Clawpilot scheduled task: ${name}

[Service]
Type=oneshot
WorkingDirectory=${cwd}
ExecStart=/bin/bash -c 'exec copilot -p "$$(cat "${promptFile}")" --allow-all --autopilot --silent --no-ask-user --name "sched-${name}"${modelArgs}'
Environment=HOME=${HOME}
Environment=PATH=${process.env.PATH}
StandardOutput=journal
StandardError=journal
`;
}

function linuxTimer(name, schedule) {
    return `[Unit]
Description=Clawpilot schedule timer: ${name}

[Timer]
OnCalendar=${String(schedule).replace(/[\r\n]/g, " ")}
Persistent=true

[Install]
WantedBy=timers.target
`;
}

function buildHeartbeatPrompt(name, userPrompt) {
    return `${userPrompt}

IMPORTANT: After completing the check, write a brief JSON summary of your findings to ${HEARTBEAT_RESULTS_DIR}/${name}-TIMESTAMP.json (replace TIMESTAMP with the current unix timestamp) with this structure: {"name":"${name}","timestamp":"<ISO date>","summary":"<1-2 sentence summary>","urgent":true/false,"details":"<details>"}`;
}

function heartbeatService(name, prompt) {
    const promptFile = join(HEARTBEAT_DIR, `${name}.prompt`);
    return `[Unit]
Description=Clawpilot heartbeat: ${name}

[Service]
Type=oneshot
WorkingDirectory=${HOME}
ExecStart=/bin/bash -c 'exec copilot -p "$$(cat "${promptFile}")" --allow-all --autopilot --silent --no-ask-user --name "hb-${name}"'
Environment=HOME=${HOME}
Environment=PATH=${process.env.PATH}
StandardOutput=journal
StandardError=journal
`;
}

async function readOpenClawCrons() {
    const jobsDoc = await readJsonFile(OPENCLAW_JOBS_FILE, { jobs: [] });
    const stateDoc = await readJsonFile(OPENCLAW_STATE_FILE, { jobs: {} });
    return {
        jobs: Array.isArray(jobsDoc.jobs) ? jobsDoc.jobs : [],
        states: stateDoc.jobs && typeof stateDoc.jobs === "object" ? stateDoc.jobs : {},
    };
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

function scrubbedGatewayEnv() {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
        if (key.startsWith("CLAWPILOT_GATEWAY_")) delete env[key];
    }
    return env;
}

async function triggerOpenClawJob(job) {
    await ensureDir(SCHEDULER_DIR);
    const slug = sanitizeName(`${job.name || job.id}-${String(job.id || "").slice(0, 8)}`) || "openclaw-cron";
    const cwd = await validateGatewayCwd(OPENCLAW_WORKSPACE);
    const prompt = buildOpenClawPrompt(job);
    const promptFile = join(SCHEDULER_DIR, `${slug}.openclaw.prompt`);
    await writeFile(promptFile, prompt, { mode: 0o600 });
    if (IS_WINDOWS) {
        const { spawnDetachedCopilot } = await import("./spawn-backend.mjs");
        const logPath = join(SCHEDULER_DIR, `${slug}.openclaw.log`);
        const child = spawnDetachedCopilot({
            prompt,
            name: `openclaw-cron-${slug}`,
            cwd,
            logPath,
            env: scrubbedGatewayEnv(),
        });
        return { id: `openclaw:${job.id}`, triggered: true, pid: child.pid, logFile: logPath, compatibility: "triggered-through-clawpilot" };
    }
    const unit = `clawpilot-openclaw-${slug}-${Date.now()}`;
    const command = `exec ${COPILOT_BIN} -p "$(cat ${shellSingleQuote(promptFile)})" --allow-all --autopilot --silent --no-ask-user --name ${shellSingleQuote(`openclaw-cron-${slug}`)}`;
    const result = await runTransientUnit({ unit, cwd, command });
    if (!result.ok) throw new Error(result.stderr || result.stdout || "Failed to trigger imported OpenClaw cron.");
    return { id: `openclaw:${job.id}`, triggered: true, unit, compatibility: "triggered-through-clawpilot" };
}

export async function scheduleList() {
    await ensureDir(SCHEDULER_DIR);
    const items = [];
    if (IS_WINDOWS) {
        const result = await queryAllTasks();
        if (result.ok) {
            for (const block of result.stdout.split(/\r?\n\r?\n/)) {
                const taskName = block.match(/TaskName:\s*(.+)/)?.[1]?.trim();
                if (taskName?.includes("Clawpilot-sched-")) {
                    items.push({ id: taskName.replace(/^.*Clawpilot-sched-/, ""), source: "clawpilot", platform: "windows", mutable: true, raw: block });
                }
            }
        }
    } else {
        const result = await listTimers("clawpilot-*");
        if (result.ok) {
            for (const line of result.stdout.split(/\r?\n/).filter((line) => line.includes("clawpilot-"))) {
                const unit = line.match(/(clawpilot-[^\s]+\.timer)/)?.[1];
                if (unit) items.push({ id: unit.replace(/^clawpilot-/, "").replace(/\.timer$/, ""), source: "clawpilot", platform: "linux", mutable: true, raw: line });
            }
        }
    }
    const { jobs, states } = await readOpenClawCrons();
    for (const job of jobs) {
        items.push({
            id: `openclaw:${job.id}`,
            source: "openclaw",
            mutable: false,
            compatibility: "read-through-openclaw-trigger-through-clawpilot",
            name: job.name || job.id,
            enabled: job.enabled !== false,
            state: states[job.id]?.state || {},
        });
    }
    return { schedules: items };
}

export async function scheduleCreate({ name, schedule, prompt, cwd = HOME, model = null }) {
    name = name || arguments[0]?.id;
    const safe = sanitizeName(name);
    if (!safe) throw new Error("schedule.create requires a name.");
    if (/[\r\n]/.test(String(schedule || ""))) throw new Error("schedule.create schedule must not contain newlines.");
    cwd = await validateGatewayCwd(cwd);
    if (String(name).startsWith("openclaw:")) {
        return { ok: false, error: { code: "managed_by_openclaw", message: "OpenClaw-owned schedules are read-only in Clawpilot v0.1." } };
    }
    await ensureDir(SCHEDULER_DIR);
    if (IS_WINDOWS) {
        const created = await createScheduledCopilotTask({ name: safe, prefix: "sched", schedule, prompt, cwd, model, stateDir: SCHEDULER_DIR, copilotName: `sched-${safe}` });
        if (!created.ok) throw new Error(created.stderr || created.stdout || "Failed to create Windows scheduled task.");
        return { id: safe, taskName: created.taskName, logFile: created.logFile };
    }
    await writeFile(join(SCHEDULER_DIR, `${safe}.prompt`), prompt, { mode: 0o600 });
    await writeFile(join(SCHEDULER_DIR, `${safe}.json`), JSON.stringify({ name: safe, schedule, prompt, cwd, model: model || "default", createdAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
    const unit = scheduleUnitName(safe);
    await writeUserUnit(`${unit}.service`, linuxScheduleService(safe, cwd, model));
    await writeUserUnit(`${unit}.timer`, linuxTimer(safe, schedule));
    await daemonReload();
    const result = await enableNow(`${unit}.timer`);
    if (!result.ok) throw new Error(result.stderr || result.stdout || "Failed to enable timer.");
    return { id: safe, unit };
}

export async function scheduleDelete({ name }) {
    name = name || arguments[0]?.id;
    if (String(name).startsWith("openclaw:")) {
        return { ok: false, error: { code: "managed_by_openclaw", message: "OpenClaw-owned schedules are read-only in Clawpilot v0.1." } };
    }
    const safe = sanitizeName(name);
    if (!safe) throw new Error("schedule.delete requires a name.");
    if (IS_WINDOWS) {
        const result = await deleteTask(windowsTaskName("sched", safe));
        if (!result.ok) throw new Error(result.stderr || result.stdout || "Failed to delete Windows scheduled task.");
    } else {
        const unit = scheduleUnitName(safe);
        await stopDisable(`${unit}.timer`);
        await removeUserUnit(`${unit}.timer`);
        await removeUserUnit(`${unit}.service`);
        await daemonReload();
    }
    await rm(join(SCHEDULER_DIR, `${safe}.prompt`), { force: true });
    await rm(join(SCHEDULER_DIR, `${safe}.json`), { force: true });
    await rm(join(SCHEDULER_DIR, `${safe}.ps1`), { force: true });
    return { id: safe, deleted: true };
}

export async function scheduleTrigger({ name }) {
    name = name || arguments[0]?.id;
    if (String(name).startsWith("openclaw:")) {
        const openclaw = await findOpenClawJob(name);
        if (!openclaw) throw new Error(`OpenClaw schedule not found: ${name}`);
        return await triggerOpenClawJob(openclaw.job);
    }
    const safe = sanitizeName(name);
    if (!safe) throw new Error("schedule.trigger requires a name.");
    const result = IS_WINDOWS
        ? await runTask(windowsTaskName("sched", safe))
        : await startUnit(`${scheduleUnitName(safe)}.service`);
    if (!result.ok) throw new Error(result.stderr || result.stdout || "Failed to trigger schedule.");
    return { id: safe, triggered: true, output: result.stdout };
}

export async function scheduleLogs({ name, lines = 100 }) {
    name = name || arguments[0]?.id;
    if (String(name).startsWith("openclaw:")) {
        const openclaw = await findOpenClawJob(name);
        if (!openclaw) throw new Error(`OpenClaw schedule not found: ${name}`);
        const content = await readFile(join(OPENCLAW_RUNS_DIR, `${openclaw.job.id}.jsonl`), "utf8").catch(() => "");
        return { id: `openclaw:${openclaw.job.id}`, output: content.split(/\r?\n/).filter(Boolean).slice(-Number(lines || 100)).join("\n") };
    }
    const safe = sanitizeName(name);
    if (!safe) throw new Error("schedule.logs requires a name.");
    const output = IS_WINDOWS
        ? await taskLog(SCHEDULER_DIR, safe, lines)
        : (await journalLogs(`${scheduleUnitName(safe)}.service`, lines)).stdout;
    return { id: safe, output };
}

async function loadHeartbeatConfig() {
    return await readJsonFile(join(HEARTBEAT_DIR, "config.json"), { checks: [] });
}

async function saveHeartbeatConfig(config) {
    await ensureDir(HEARTBEAT_DIR);
    await writeFile(join(HEARTBEAT_DIR, "config.json"), JSON.stringify(config, null, 2), { mode: 0o600 });
}

export async function heartbeatList() {
    await ensureDir(HEARTBEAT_RESULTS_DIR);
    const config = await loadHeartbeatConfig();
    const results = [];
    for (const file of await readdir(HEARTBEAT_RESULTS_DIR).catch(() => [])) {
        if (!file.endsWith(".json")) continue;
        try { results.push(JSON.parse(await readFile(join(HEARTBEAT_RESULTS_DIR, file), "utf8"))); } catch { /* skip */ }
    }
    return { checks: config.checks || [], results };
}

export async function heartbeatAdd({ name, schedule, prompt }) {
    const safe = sanitizeName(name);
    if (!safe) throw new Error("heartbeat.add requires a name.");
    if (/[\r\n]/.test(String(schedule || ""))) throw new Error("heartbeat.add schedule must not contain newlines.");
    const fullPrompt = buildHeartbeatPrompt(safe, prompt);
    await ensureDir(HEARTBEAT_RESULTS_DIR);
    if (IS_WINDOWS) {
        const created = await createScheduledCopilotTask({ name: safe, prefix: "hb", schedule, prompt: fullPrompt, cwd: HOME, stateDir: HEARTBEAT_DIR, copilotName: `hb-${safe}` });
        if (!created.ok) throw new Error(created.stderr || created.stdout || "Failed to create Windows heartbeat.");
    } else {
        const unit = heartbeatUnitName(safe);
        await writeFile(join(HEARTBEAT_DIR, `${safe}.prompt`), fullPrompt, { mode: 0o600 });
        await writeUserUnit(`${unit}.service`, heartbeatService(safe, fullPrompt));
        await writeUserUnit(`${unit}.timer`, linuxTimer(safe, schedule));
        await daemonReload();
        await enableNow(`${unit}.timer`);
    }
    const config = await loadHeartbeatConfig();
    config.checks = (config.checks || []).filter((check) => check.name !== safe);
    config.checks.push({ name: safe, schedule, prompt, createdAt: new Date().toISOString() });
    await saveHeartbeatConfig(config);
    return { name: safe, added: true };
}

export async function heartbeatRemove({ name }) {
    const safe = sanitizeName(name);
    if (!safe) throw new Error("heartbeat.remove requires a name.");
    if (IS_WINDOWS) {
        await deleteTask(windowsTaskName("hb", safe));
    } else {
        const unit = heartbeatUnitName(safe);
        await stopDisable(`${unit}.timer`);
        await removeUserUnit(`${unit}.timer`);
        await removeUserUnit(`${unit}.service`);
        await daemonReload();
    }
    await rm(join(HEARTBEAT_DIR, `${safe}.prompt`), { force: true });
    await rm(join(HEARTBEAT_DIR, `${safe}.json`), { force: true });
    await rm(join(HEARTBEAT_DIR, `${safe}.ps1`), { force: true });
    const config = await loadHeartbeatConfig();
    config.checks = (config.checks || []).filter((check) => check.name !== safe);
    await saveHeartbeatConfig(config);
    return { name: safe, removed: true };
}

export async function heartbeatAck({ name = null } = {}) {
    await ensureDir(HEARTBEAT_RESULTS_DIR);
    let cleared = 0;
    for (const file of await readdir(HEARTBEAT_RESULTS_DIR).catch(() => [])) {
        if (!file.endsWith(".json")) continue;
        if (name && !file.startsWith(`${sanitizeName(name)}-`)) continue;
        await unlink(join(HEARTBEAT_RESULTS_DIR, file));
        cleared++;
    }
    return { cleared };
}

export async function channelStatus() {
    const config = await readJsonFile(CHANNELS_CONFIG_FILE, { channels: {} });
    return {
        channels: Object.entries(config.channels || {}).map(([name, value]) => ({
            name,
            configured: Boolean(value?.token || value?.webhookUrl),
            note: value?.note || null,
        })),
    };
}

export async function channelSend({ channel, target, message, dryRun = true }) {
    if (!dryRun) {
        return { ok: false, error: { code: "external_send_blocked", message: "Gateway channel.send requires dryRun=true in v0.1 to avoid accidental external sends." } };
    }
    return { channel, target, messageLength: String(message || "").length, dryRun: true };
}

function sqliteJson(sql) {
    return new Promise((resolve) => {
        execFile("sqlite3", ["-json", MEMORY_DB, sql], { timeout: 30000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
            resolve({ ok: !err, stdout: stdout?.trim() || "", stderr: stderr?.trim() || "" });
        });
    });
}

export async function memorySearch({ query, limit = 20 }) {
    const safeLimit = Math.max(1, Math.min(100, Number(limit || 20)));
    const rawQuery = String(query || "");
    if (rawQuery.length > 500) throw new Error("memory.search query is too long.");
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(rawQuery)) throw new Error("memory.search query contains control characters.");
    const q = rawQuery.replace(/'/g, "''");
    const result = await sqliteJson(`SELECT date, source, content, tags FROM memory_fts WHERE memory_fts MATCH '${q}' LIMIT ${safeLimit};`);
    if (!result.ok) return { available: false, error: result.stderr || "sqlite3 unavailable or memory DB not initialized." };
    return { available: true, results: result.stdout ? JSON.parse(result.stdout) : [] };
}

export async function vaultListNames() {
    await ensureDir(VAULT_DIR);
    const names = (await readdir(VAULT_DIR).catch(() => []))
        .filter((file) => file.endsWith(".age") && !file.startsWith("."))
        .map((file) => file.replace(/\.age$/, ""));
    return { names };
}

export async function adapterStatus() {
    return {
        stateDir: CLAWPILOT_STATE_DIR,
        capabilities: gatewayCapabilities(),
        parked: {
            nodes: unsupportedCapability("nodes"),
            voice: unsupportedCapability("voice"),
            canvas: unsupportedCapability("canvas"),
        },
    };
}
