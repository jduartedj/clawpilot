import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ensureDir, sanitizeName, tailFile } from "./fs.mjs";
import { exec } from "./exec.mjs";
import { COPILOT_BIN, IS_WINDOWS, statePath } from "./platform.mjs";

export function taskName(prefix, name) {
    return `Clawpilot-${sanitizeName(`${prefix}-${name}`)}`;
}

function winCommandQuote(value) {
    return `"${String(value).replace(/"/g, '\\"')}"`;
}

async function restrictWindowsFileAccess(path) {
    if (!IS_WINDOWS) return;
    const account = process.env.USERDOMAIN && process.env.USERNAME
        ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}`
        : process.env.USERNAME;
    if (!account) {
        throw new Error("Cannot restrict Windows file ACLs because USERNAME is not set.");
    }
    const result = await exec("icacls.exe", [
        path,
        "/inheritance:r",
        "/grant:r",
        `${account}:F`,
        "*S-1-5-18:F",
        "*S-1-5-32-544:F",
    ]);
    if (!result.ok) {
        throw new Error(`Failed to restrict ACLs for ${path}: ${result.stderr || result.stdout}`);
    }
}

function normalizeTime(value) {
    const match = String(value || "").match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (!match) return null;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    const second = Number(match[3] || 0);
    if (hour > 23 || minute > 59 || second > 59) return null;
    return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function normalizeDay(value) {
    const days = {
        mon: "MON", monday: "MON",
        tue: "TUE", tuesday: "TUE",
        wed: "WED", wednesday: "WED",
        thu: "THU", thursday: "THU",
        fri: "FRI", friday: "FRI",
        sat: "SAT", saturday: "SAT",
        sun: "SUN", sunday: "SUN",
    };
    return days[String(value || "").toLowerCase()] || null;
}

export function parseWindowsSchedule(schedule) {
    const raw = String(schedule || "").trim();
    const lower = raw.toLowerCase();
    if (lower === "hourly") return ["/SC", "HOURLY", "/MO", "1"];
    if (lower === "daily") return ["/SC", "DAILY", "/ST", "00:00"];
    if (lower === "weekly") return ["/SC", "WEEKLY", "/D", "MON", "/ST", "00:00"];

    let match = raw.match(/^\*-\*-\*\s+(\d{1,2}:\d{2}(?::\d{2})?)$/);
    if (match) {
        const time = normalizeTime(match[1]);
        if (time) return ["/SC", "DAILY", "/ST", time];
    }

    match = raw.match(/^\*-\*-\*\s+\*\/(\d+):00(?::00)?$/);
    if (match) {
        const every = Number(match[1]);
        if (Number.isInteger(every) && every >= 1 && every <= 23) {
            return ["/SC", "HOURLY", "/MO", String(every), "/ST", "00:00"];
        }
    }

    match = raw.match(/^\*-\*-\*\s+\*:0\/(\d+):00$/);
    if (match) {
        const every = Number(match[1]);
        if (Number.isInteger(every) && every >= 1 && every <= 1439) {
            return ["/SC", "MINUTE", "/MO", String(every)];
        }
    }

    match = lower.match(/^every\s+(\d+)\s+(minute|minutes|hour|hours)$/);
    if (match) {
        const every = Number(match[1]);
        if (Number.isInteger(every) && every >= 1) {
            if (match[2].startsWith("minute") && every <= 1439) {
                return ["/SC", "MINUTE", "/MO", String(every)];
            }
            if (match[2].startsWith("hour") && every <= 23) {
                return ["/SC", "HOURLY", "/MO", String(every)];
            }
        }
    }

    match = raw.match(/^([A-Za-z]+)\s+\*-\*-\*\s+(\d{1,2}:\d{2}(?::\d{2})?)$/);
    if (match) {
        const day = normalizeDay(match[1]);
        const time = normalizeTime(match[2]);
        if (day && time) return ["/SC", "WEEKLY", "/D", day, "/ST", time];
    }

    throw new Error(
        `Unsupported Windows schedule '${raw}'. Supported: hourly, daily, weekly, ` +
        "`*-*-* HH:MM[:SS]`, `Mon *-*-* HH:MM[:SS]`, `*-*-* */N:00:00`, " +
        "`*-*-* *:0/N:00`, or `every N minutes/hours`."
    );
}

async function ensureRunnerScript() {
    const scriptPath = statePath("scripts", "run-copilot-task.ps1");
    await ensureDir(dirname(scriptPath));
    await writeFile(scriptPath, `param(
    [Parameter(Mandatory=$true)][string]$PromptFile,
    [Parameter(Mandatory=$true)][string]$Name,
    [Parameter(Mandatory=$true)][string]$Cwd,
    [string]$Model = "",
    [string]$LogFile = ""
)
$ErrorActionPreference = "Stop"
if ($LogFile) {
    $logDir = Split-Path -Parent $LogFile
    if ($logDir) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }
    "[$(Get-Date -Format o)] Starting Clawpilot task $Name" | Out-File -FilePath $LogFile -Append -Encoding utf8
}
Set-Location -LiteralPath $Cwd
$prompt = Get-Content -LiteralPath $PromptFile -Raw
$copilotArgs = @("-p", $prompt, "--allow-all", "--autopilot", "--silent", "--no-ask-user", "--name", $Name)
if ($Model) { $copilotArgs += @("--model", $Model) }
if ($LogFile) {
    & ${COPILOT_BIN} @copilotArgs *>> $LogFile
} else {
    & ${COPILOT_BIN} @copilotArgs
}
$exitCode = if ($null -eq $LASTEXITCODE) { 0 } else { $LASTEXITCODE }
if ($LogFile) {
    "[$(Get-Date -Format o)] Finished Clawpilot task $Name with exit code $exitCode" | Out-File -FilePath $LogFile -Append -Encoding utf8
}
exit $exitCode
`);
    await restrictWindowsFileAccess(scriptPath);
    return scriptPath;
}

export function buildPowerShellTaskCommand({ scriptPath, promptFile, copilotName, cwd, model, logFile }) {
    const parts = [
        "powershell.exe",
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", winCommandQuote(scriptPath),
        "-PromptFile", winCommandQuote(promptFile),
        "-Name", winCommandQuote(copilotName),
        "-Cwd", winCommandQuote(cwd),
    ];
    if (model) parts.push("-Model", winCommandQuote(model));
    if (logFile) parts.push("-LogFile", winCommandQuote(logFile));
    return parts.join(" ");
}

export async function createScheduledCopilotTask({
    name,
    prefix = "sched",
    schedule,
    prompt,
    cwd,
    model,
    stateDir = statePath("scheduler"),
    copilotName,
}) {
    const safe = sanitizeName(name);
    const tn = taskName(prefix, safe);
    const promptFile = join(stateDir, `${safe}.prompt`);
    const logFile = join(stateDir, `${safe}.log`);
    const metaFile = join(stateDir, `${safe}.json`);
    await ensureDir(stateDir);
    await writeFile(promptFile, prompt, { mode: 0o600 });
    await restrictWindowsFileAccess(promptFile);
    const scriptPath = await ensureRunnerScript();
    const scheduleArgs = parseWindowsSchedule(schedule);
    const command = buildPowerShellTaskCommand({
        scriptPath,
        promptFile,
        copilotName: copilotName || `${prefix}-${safe}`,
        cwd,
        model,
        logFile,
    });
    const result = await exec("schtasks.exe", ["/Create", "/F", "/TN", tn, "/TR", command, ...scheduleArgs]);
    if (!result.ok) return { ...result, taskName: tn };
    await writeFile(metaFile, JSON.stringify({
        name: safe,
        taskName: tn,
        schedule,
        prompt,
        cwd,
        model: model || "default",
        logFile,
        createdAt: new Date().toISOString(),
    }, null, 2), { mode: 0o600 });
    await restrictWindowsFileAccess(metaFile);
    return { ...result, taskName: tn, logFile };
}

export function queryTask(tn) {
    return exec("schtasks.exe", ["/Query", "/TN", tn, "/FO", "LIST", "/V"]);
}

export function queryAllTasks() {
    return exec("schtasks.exe", ["/Query", "/FO", "LIST", "/V"], { timeout: 30000 });
}

export function runTask(tn) {
    return exec("schtasks.exe", ["/Run", "/TN", tn]);
}

export function endTask(tn) {
    return exec("schtasks.exe", ["/End", "/TN", tn]);
}

export function deleteTask(tn) {
    return exec("schtasks.exe", ["/Delete", "/F", "/TN", tn]);
}

export async function taskLog(stateDir, name, lines = 100) {
    return tailFile(join(stateDir, `${sanitizeName(name)}.log`), lines);
}

export async function readTaskMeta(stateDir, name) {
    try {
        return JSON.parse(await readFile(join(stateDir, `${sanitizeName(name)}.json`), "utf8"));
    } catch {
        return null;
    }
}

export async function createOnLogonTask({ name, command }) {
    const result = await exec("schtasks.exe", ["/Create", "/F", "/TN", name, "/SC", "ONLOGON", "/TR", command]);
    return { ...result, taskName: name };
}
