// PilotClaw CLI — spawn extension
// Launch and manage parallel background Copilot CLI sessions.
// Includes auto-resume: detects interrupted tasks on exit and re-spawns them.
import { joinSession } from "@github/copilot-sdk/extension";
import { readFile, writeFile, readdir, rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { ensureDir, sanitizeName, tailFile, writeJsonFile } from "../_lib/fs.mjs";
import { HOME, statePath } from "../_lib/platform.mjs";
import { isProcessRunning, killProcessTree, spawnDetachedCopilot } from "../_lib/spawn-backend.mjs";

const SPAWNED_DIR = statePath("spawned");
const RESUME_FILE = statePath("interrupted.json");

// Track the session's last user message and whether the agent was mid-task
let lastUserPrompt = null;
let lastAssistantDone = true; // true = idle, false = agent is working
let toolsInFlight = 0;

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
    await writeJsonFile(join(dir, "meta.json"), meta);
}

const session = await joinSession({
    tools: [
        {
            name: "pilotclaw_spawn",
            description:
                "Launch a background Copilot CLI session. Runs `copilot -p` in the background with full tool access. " +
                "The session runs autonomously and output is captured to a log file. " +
                "Use pilotclaw_spawn_list to check status and pilotclaw_spawn_read to see output.",
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
                const name = sanitizeName(args.name);
                const existing = await getMeta(name);
                if (existing && isProcessRunning(existing.pid)) {
                    return { textResultForLlm: `Session '${name}' is already running (PID ${existing.pid}). Kill it first or use a different name.`, resultType: "failure" };
                }

                const sessionDir = join(SPAWNED_DIR, name);
                await ensureDir(sessionDir);
                const logPath = join(sessionDir, "output.log");

                const child = spawnDetachedCopilot({
                    prompt: args.prompt,
                    name,
                    cwd: args.cwd || process.cwd(),
                    model: args.model,
                    logPath,
                });

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

                return `Spawned session '${name}' (PID ${child.pid})\nLog: ${logPath}\nUse pilotclaw_spawn_read to check output.`;
            },
        },
        {
            name: "pilotclaw_spawn_list",
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
            name: "pilotclaw_spawn_read",
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
                const name = sanitizeName(args.name);
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
            name: "pilotclaw_spawn_kill",
            description: "Kill a running spawned background session.",
            parameters: {
                type: "object",
                properties: {
                    name: { type: "string", description: "Name of the spawned session to kill" },
                },
                required: ["name"],
            },
            handler: async (args) => {
                const name = sanitizeName(args.name);
                const meta = await getMeta(name);
                if (!meta) return `Session '${name}' not found.`;
                if (meta.status !== "running") return `Session '${name}' is not running (status: ${meta.status}).`;
                if (!isProcessRunning(meta.pid)) {
                    meta.status = "completed";
                    meta.endedAt = new Date().toISOString();
                    await saveMeta(name, meta);
                    return `Session '${name}' already exited.`;
                }

                await killProcessTree(meta.pid);

                meta.status = "killed";
                meta.endedAt = new Date().toISOString();
                await saveMeta(name, meta);
                return `Killed session '${name}' (PID ${meta.pid}).`;
            },
        },
        {
            name: "pilotclaw_spawn_clean",
            description: "Remove completed/failed/killed spawned sessions and their logs.",
            parameters: {
                type: "object",
                properties: {
                    name: { type: "string", description: "Name of a specific session to clean (omit to clean all non-running)" },
                },
            },
            handler: async (args) => {
                await ensureDir(SPAWNED_DIR);
                const entries = args.name ? [sanitizeName(args.name)] : await readdir(SPAWNED_DIR);
                let cleaned = 0;

                for (const name of entries) {
                    // Verify path stays inside SPAWNED_DIR
                    const target = resolve(SPAWNED_DIR, name);
                    const rel = relative(resolve(SPAWNED_DIR), target);
                    if (rel.startsWith("..") || rel === "" || resolve(rel) === rel) continue;

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
            let contextParts = [];

            // 1. Check for interrupted task FIRST (highest priority)
            try {
                const interrupted = JSON.parse(await readFile(RESUME_FILE, "utf-8"));
                if (interrupted && interrupted.prompt && interrupted.spawnName) {
                    await rm(RESUME_FILE, { force: true });

                    const meta = await getMeta(interrupted.spawnName);
                    if (meta) {
                        const stillRunning = meta.status === "running" && isProcessRunning(meta.pid);

                        if (stillRunning) {
                            // Stop it — we'll continue interactively
                            await killProcessTree(meta.pid);
                            meta.status = "handed-back";
                            meta.endedAt = new Date().toISOString();
                            await saveMeta(interrupted.spawnName, meta);

                            const partialOutput = await tailFile(
                                join(SPAWNED_DIR, interrupted.spawnName, "output.log"), 100
                            );

                            contextParts.push(
                                `[PilotClaw Auto-Resume] Your last session was interrupted. A background session was working on it but you're back now — it has been stopped and handed back to you.\n\n` +
                                `**Original task:** ${interrupted.prompt}\n\n` +
                                `**Progress from background session (partial output):**\n${partialOutput}\n\n` +
                                `Continue this task from where the background session left off. The user is back and available for interaction.`
                            );
                        } else {
                            if (meta.status === "running") {
                                meta.status = "completed";
                                meta.endedAt = new Date().toISOString();
                                await saveMeta(interrupted.spawnName, meta);
                            }

                            const output = await tailFile(
                                join(SPAWNED_DIR, interrupted.spawnName, "output.log"), 150
                            );

                            contextParts.push(
                                `[PilotClaw Auto-Resume] Your last session was interrupted. A background session completed the task while you were away.\n\n` +
                                `**Original task:** ${interrupted.prompt}\n\n` +
                                `**Background session output:**\n${output}\n\n` +
                                `Review the output above. The task was completed autonomously. Let the user know what was accomplished.`
                            );
                        }
                    }
                }
            } catch { /* no interrupted file */ }

            // 2. Report other completed spawned sessions
            let entries;
            try {
                entries = await readdir(SPAWNED_DIR);
            } catch {
                entries = [];
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
                // Skip the auto-resumed session (already reported above)
                if (meta.status === "handed-back") continue;
                if (meta.status !== "running") {
                    completed.push(`• ${name}: ${meta.status} (${meta.prompt.slice(0, 80)}...)`);
                }
            }

            if (completed.length > 0) {
                contextParts.push(
                    `[PilotClaw] ${completed.length} background session(s) finished since last check:\n${completed.join("\n")}\nUse pilotclaw_spawn_read to see their output, or pilotclaw_spawn_clean to remove them.`
                );
            }

            if (contextParts.length > 0) {
                return { additionalContext: contextParts.join("\n\n---\n\n") };
            }
        },
        onSessionEnd: async (input) => {
            // Only act on user_exit when the agent was mid-task
            if (input.reason !== "user_exit") return;
            if (lastAssistantDone && toolsInFlight === 0) return;
            if (!lastUserPrompt) return;

            // The user quit while the agent was working — auto-spawn to continue
                const name = `resume-${Date.now()}`;
                const resumeCwd = input.cwd || process.cwd();
                const resumePrompt =
                `CONTEXT: This task was interrupted when the user exited the CLI mid-execution.\n` +
                `ORIGINAL TASK: ${lastUserPrompt}\n\n` +
                `Continue and complete this task. Work autonomously to finish what was started.`;

            try {
                await ensureDir(SPAWNED_DIR);
                const sessionDir = join(SPAWNED_DIR, name);
                await ensureDir(sessionDir);
                const logPath = join(sessionDir, "output.log");

                const child = spawnDetachedCopilot({
                    prompt: resumePrompt,
                    name,
                    cwd: resumeCwd,
                    logPath,
                });

                await saveMeta(name, {
                    pid: child.pid,
                    name,
                    prompt: resumePrompt,
                    model: "default",
                    cwd: resumeCwd || HOME,
                    startedAt: new Date().toISOString(),
                    status: "running",
                    autoResumed: true,
                });

                // Write marker for next session start
                await writeFile(RESUME_FILE, JSON.stringify({
                    prompt: lastUserPrompt,
                    spawnName: name,
                    resumedAt: new Date().toISOString(),
                }));
            } catch { /* best effort — don't crash the exit */ }
        },
    },
});

// Track user messages and agent activity to detect mid-task exits
session.on("user.message", (event) => {
    lastUserPrompt = event.data?.content || null;
    lastAssistantDone = false;
});

session.on("assistant.message", () => {
    lastAssistantDone = true;
});

session.on("session.idle", () => {
    lastAssistantDone = true;
    toolsInFlight = 0;
});

session.on("tool.execution_start", () => {
    toolsInFlight++;
    lastAssistantDone = false;
});

session.on("tool.execution_complete", () => {
    toolsInFlight = Math.max(0, toolsInFlight - 1);
});
