// Clawpilot CLI — spawn extension
// Launch and manage parallel background Copilot CLI sessions.
import { joinSession } from "@github/copilot-sdk/extension";
import { execFile, spawn as nodeSpawn } from "node:child_process";
import { mkdir, readFile, writeFile, readdir, stat, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

const SPAWNED_DIR = join(homedir(), ".clawpilot", "spawned");
const COPILOT_BIN = "copilot";

async function ensureDir(dir) {
    await mkdir(dir, { recursive: true });
}

async function getMeta(name) {
    try {
        const raw = await readFile(join(SPAWNED_DIR, name, "meta.json"), "utf-8");
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

async function saveMeta(name, meta) {
    const dir = join(SPAWNED_DIR, name);
    await ensureDir(dir);
    await writeFile(join(dir, "meta.json"), JSON.stringify(meta, null, 2));
}

function isProcessRunning(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function tailFile(path, lines = 50) {
    return new Promise((resolve) => {
        execFile("tail", ["-n", String(lines), path], (err, stdout) => {
            resolve(err ? `(no output yet)` : stdout);
        });
    });
}

const session = await joinSession({
    tools: [
        {
            name: "clawpilot_spawn",
            description:
                "Launch a background Copilot CLI session. Runs `copilot -p` in the background with full tool access. " +
                "The session runs autonomously and output is captured to a log file. " +
                "Use clawpilot_spawn_list to check status and clawpilot_spawn_read to see output.",
            parameters: {
                type: "object",
                properties: {
                    name: {
                        type: "string",
                        description: "Unique name for this spawned session (e.g., 'refactor-auth', 'fix-tests')",
                    },
                    prompt: {
                        type: "string",
                        description: "The full prompt/task for the background session",
                    },
                    cwd: {
                        type: "string",
                        description: "Working directory for the session (default: current directory)",
                    },
                    model: {
                        type: "string",
                        description: "Model to use (e.g., 'claude-sonnet-4', 'gpt-5.5'). Omit for default.",
                    },
                },
                required: ["name", "prompt"],
            },
            handler: async (args) => {
                const name = args.name.replace(/[^a-zA-Z0-9_-]/g, "-");
                const existing = await getMeta(name);
                if (existing && isProcessRunning(existing.pid)) {
                    return { textResultForLlm: `Session '${name}' is already running (PID ${existing.pid}). Kill it first or use a different name.`, resultType: "failure" };
                }

                const sessionDir = join(SPAWNED_DIR, name);
                await ensureDir(sessionDir);
                const logPath = join(sessionDir, "output.log");

                const copilotArgs = [
                    "-p", args.prompt,
                    "--allow-all",
                    "--autopilot",
                    "--name", `spawn-${name}`,
                    "--output-format", "text",
                    "--silent",
                    "--no-ask-user",
                ];
                if (args.model) copilotArgs.push("--model", args.model);

                const { openSync, closeSync } = await import("node:fs");
                const logFd = openSync(logPath, "w");

                const child = nodeSpawn("setsid", [COPILOT_BIN, ...copilotArgs], {
                    cwd: args.cwd || process.cwd(),
                    stdio: ["ignore", logFd, logFd],
                    detached: true,
                    env: { ...process.env },
                });

                child.unref();
                // Close our copy of the FD — the child owns it now
                closeSync(logFd);

                const meta = {
                    pid: child.pid,
                    name,
                    prompt: args.prompt,
                    model: args.model || "default",
                    cwd: args.cwd || process.cwd(),
                    startedAt: new Date().toISOString(),
                    status: "running",
                };
                await saveMeta(name, meta);

                // Watch for exit
                child.on("exit", async (code) => {
                    const m = await getMeta(name);
                    if (m) {
                        m.status = code === 0 ? "completed" : "failed";
                        m.exitCode = code;
                        m.endedAt = new Date().toISOString();
                        await saveMeta(name, m);
                    }
                });

                return `Spawned session '${name}' (PID ${child.pid})\nLog: ${logPath}\nUse clawpilot_spawn_read to check output.`;
            },
        },
        {
            name: "clawpilot_spawn_list",
            description: "List all spawned background sessions with their status (running/completed/failed).",
            parameters: { type: "object", properties: {} },
            handler: async () => {
                await ensureDir(SPAWNED_DIR);
                let entries;
                try {
                    entries = await readdir(SPAWNED_DIR);
                } catch {
                    return "No spawned sessions.";
                }

                if (entries.length === 0) return "No spawned sessions.";

                const results = [];
                for (const name of entries) {
                    const meta = await getMeta(name);
                    if (!meta) continue;

                    // Update status if process died
                    if (meta.status === "running" && !isProcessRunning(meta.pid)) {
                        meta.status = "completed";
                        meta.endedAt = meta.endedAt || new Date().toISOString();
                        await saveMeta(name, meta);
                    }

                    const duration = meta.endedAt
                        ? `${Math.round((new Date(meta.endedAt) - new Date(meta.startedAt)) / 1000)}s`
                        : `${Math.round((Date.now() - new Date(meta.startedAt)) / 1000)}s (running)`;

                    results.push(
                        `${meta.status === "running" ? "🟢" : meta.status === "completed" ? "✅" : "❌"} ${name} | PID ${meta.pid} | ${meta.status} | ${duration} | ${meta.model}`
                    );
                }

                return results.length > 0 ? results.join("\n") : "No spawned sessions.";
            },
        },
        {
            name: "clawpilot_spawn_read",
            description: "Read the output log of a spawned background session.",
            parameters: {
                type: "object",
                properties: {
                    name: { type: "string", description: "Name of the spawned session" },
                    tail: { type: "number", description: "Number of lines from the end (default: 50)" },
                },
                required: ["name"],
            },
            handler: async (args) => {
                const name = args.name.replace(/[^a-zA-Z0-9_-]/g, "-");
                const logPath = join(SPAWNED_DIR, name, "output.log");
                const meta = await getMeta(name);

                let header = "";
                if (meta) {
                    if (meta.status === "running" && !isProcessRunning(meta.pid)) {
                        meta.status = "completed";
                        meta.endedAt = new Date().toISOString();
                        await saveMeta(name, meta);
                    }
                    header = `[${meta.status}] Session '${name}' | PID ${meta.pid} | Started ${meta.startedAt}\n---\n`;
                }

                const output = await tailFile(logPath, args.tail || 50);
                return header + output;
            },
        },
        {
            name: "clawpilot_spawn_kill",
            description: "Kill a running spawned background session.",
            parameters: {
                type: "object",
                properties: {
                    name: { type: "string", description: "Name of the spawned session to kill" },
                },
                required: ["name"],
            },
            handler: async (args) => {
                const name = args.name.replace(/[^a-zA-Z0-9_-]/g, "-");
                const meta = await getMeta(name);
                if (!meta) return `Session '${name}' not found.`;
                if (meta.status !== "running") return `Session '${name}' is not running (status: ${meta.status}).`;
                if (!isProcessRunning(meta.pid)) {
                    meta.status = "completed";
                    meta.endedAt = new Date().toISOString();
                    await saveMeta(name, meta);
                    return `Session '${name}' already exited.`;
                }

                try {
                    // Kill the process group (setsid created a new group)
                    process.kill(-meta.pid, "SIGTERM");
                } catch {
                    try { process.kill(meta.pid, "SIGTERM"); } catch { /* already dead */ }
                }

                meta.status = "killed";
                meta.endedAt = new Date().toISOString();
                await saveMeta(name, meta);
                return `Killed session '${name}' (PID ${meta.pid}).`;
            },
        },
        {
            name: "clawpilot_spawn_clean",
            description: "Remove completed/failed/killed spawned sessions and their logs.",
            parameters: {
                type: "object",
                properties: {
                    name: { type: "string", description: "Name of a specific session to clean (omit to clean all non-running)" },
                },
            },
            handler: async (args) => {
                await ensureDir(SPAWNED_DIR);
                const sanitize = (n) => n.replace(/[^a-zA-Z0-9_-]/g, "-");
                const entries = args.name ? [sanitize(args.name)] : await readdir(SPAWNED_DIR);
                let cleaned = 0;

                for (const name of entries) {
                    // Verify path stays inside SPAWNED_DIR
                    const target = resolve(SPAWNED_DIR, name);
                    if (!target.startsWith(resolve(SPAWNED_DIR) + "/")) continue;

                    const meta = await getMeta(name);
                    if (!meta) continue;
                    if (meta.status === "running" && isProcessRunning(meta.pid)) continue;

                    await rm(target, { recursive: true, force: true });
                    cleaned++;
                }

                return `Cleaned ${cleaned} session(s).`;
            },
        },
    ],
    hooks: {
        onSessionStart: async () => {
            await ensureDir(SPAWNED_DIR);
            let entries;
            try {
                entries = await readdir(SPAWNED_DIR);
            } catch {
                return;
            }

            const completed = [];
            for (const name of entries) {
                const meta = await getMeta(name);
                if (!meta) continue;
                if (meta.status === "running" && !isProcessRunning(meta.pid)) {
                    meta.status = "completed";
                    meta.endedAt = meta.endedAt || new Date().toISOString();
                    await saveMeta(name, meta);
                }
                if (meta.status !== "running") {
                    completed.push(`• ${name}: ${meta.status} (${meta.prompt.slice(0, 80)}...)`);
                }
            }

            if (completed.length > 0) {
                return {
                    additionalContext: `[Clawpilot] ${completed.length} background session(s) finished since last check:\n${completed.join("\n")}\nUse clawpilot_spawn_read to see their output, or clawpilot_spawn_clean to remove them.`,
                };
            }
        },
    },
});
