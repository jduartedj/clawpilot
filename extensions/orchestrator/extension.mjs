// PilotClaw CLI — orchestrator extension
// Self-driving task engine. Reads ORCHESTRATION.md/ROADMAP.md, picks tasks, spawns agents.
import { joinSession } from "@github/copilot-sdk/extension";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const STATE_DIR = join(homedir(), ".pilotclaw", "orchestrator");
const STATE_FILE = join(STATE_DIR, "state.json");

async function ensureDir(dir) {
    await mkdir(dir, { recursive: true });
}

async function loadState() {
    try {
        return JSON.parse(await readFile(STATE_FILE, "utf-8"));
    } catch {
        return { status: "idle", currentTask: null, history: [], pausedAt: null };
    }
}

async function saveState(state) {
    await ensureDir(STATE_DIR);
    await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

const session = await joinSession({
    tools: [
        {
            name: "pilotclaw_orchestrator_status",
            description: "Show the current orchestrator state: what task is running, queue, and history.",
            parameters: { type: "object", properties: {} },
            handler: async () => {
                const state = await loadState();
                let output = `## Orchestrator Status\n`;
                output += `Status: ${state.status}\n`;

                if (state.currentTask) {
                    output += `\nCurrent Task: ${state.currentTask.name}\n`;
                    output += `Started: ${state.currentTask.startedAt}\n`;
                    output += `Prompt: ${state.currentTask.prompt?.slice(0, 200)}...\n`;
                }

                if (state.history.length > 0) {
                    output += `\nRecent History (last 5):\n`;
                    for (const h of state.history.slice(-5)) {
                        output += `• ${h.name} — ${h.status} (${h.endedAt})\n`;
                    }
                }

                return output;
            },
        },
        {
            name: "pilotclaw_orchestrator_steer",
            description: "Give the orchestrator a directive to change focus, priority, or behavior.",
            parameters: {
                type: "object",
                properties: {
                    directive: {
                        type: "string",
                        description: "Steering instruction (e.g., 'focus on trading bot', 'skip website tasks', 'pause after current task')",
                    },
                },
                required: ["directive"],
            },
            handler: async (args) => {
                const state = await loadState();
                if (!state.directives) state.directives = [];
                state.directives.push({
                    directive: args.directive,
                    addedAt: new Date().toISOString(),
                });
                await saveState(state);
                return `Directive added: "${args.directive}"\nThe orchestrator will apply this on next task selection.`;
            },
        },
        {
            name: "pilotclaw_orchestrator_pause",
            description: "Pause the orchestrator. It will finish the current task but not pick a new one.",
            parameters: { type: "object", properties: {} },
            handler: async () => {
                const state = await loadState();
                state.status = "paused";
                state.pausedAt = new Date().toISOString();
                await saveState(state);
                return "Orchestrator paused. Use pilotclaw_orchestrator_resume to restart.";
            },
        },
        {
            name: "pilotclaw_orchestrator_resume",
            description: "Resume the orchestrator after a pause.",
            parameters: { type: "object", properties: {} },
            handler: async () => {
                const state = await loadState();
                state.status = "idle";
                state.pausedAt = null;
                await saveState(state);
                return "Orchestrator resumed. It will pick a new task on next scheduled run.";
            },
        },
        {
            name: "pilotclaw_orchestrator_run",
            description:
                "Trigger an orchestration cycle: read ORCHESTRATION.md and ROADMAP.md, pick the highest priority unblocked task, " +
                "and spawn a background Copilot session to work on it. " +
                "Use pilotclaw_schedule to make this run automatically (e.g., nightly).",
            parameters: {
                type: "object",
                properties: {
                    orchestration_file: {
                        type: "string",
                        description: "Path to orchestration file (default: ~/clawd/ORCHESTRATION.md)",
                    },
                    roadmap_file: {
                        type: "string",
                        description: "Path to roadmap file (default: ~/clawd/ROADMAP.md)",
                    },
                },
            },
            handler: async (args) => {
                const state = await loadState();
                if (state.status === "paused") {
                    return "Orchestrator is paused. Use pilotclaw_orchestrator_resume first.";
                }
                if (state.status === "running" && state.currentTask) {
                    return `Orchestrator is already running task '${state.currentTask.name}'. Wait for it to complete or steer it.`;
                }

                // Read orchestration files
                const orchFile = args.orchestration_file || join(homedir(), "clawd", "ORCHESTRATION.md");
                const roadmapFile = args.roadmap_file || join(homedir(), "clawd", "ROADMAP.md");

                let orchestration = "", roadmap = "";
                try { orchestration = await readFile(orchFile, "utf-8"); } catch { /* ok */ }
                try { roadmap = await readFile(roadmapFile, "utf-8"); } catch { /* ok */ }

                if (!orchestration && !roadmap) {
                    return "No ORCHESTRATION.md or ROADMAP.md found. Create one with tasks to orchestrate.";
                }

                // Build a prompt for the spawned session to pick and execute a task
                const directives = (state.directives || []).map((d) => d.directive).join("\n");
                const prompt =
                    `You are the PilotClaw Orchestrator. Your job is to pick the highest-priority unblocked task and execute it.\n\n` +
                    `## ORCHESTRATION.md\n${orchestration}\n\n` +
                    `## ROADMAP.md\n${roadmap}\n\n` +
                    (directives ? `## Active Directives\n${directives}\n\n` : "") +
                    `## Instructions\n` +
                    `1. Identify the highest priority task that is NOT blocked\n` +
                    `2. Execute it fully — write code, run tests, commit changes\n` +
                    `3. When done, write a summary of what you accomplished\n` +
                    `4. Do NOT ask for user input — work autonomously`;

                // Don't set "running" — this handler only generates the prompt,
                // it doesn't spawn anything. The LLM or scheduler does the actual spawn.
                state.currentTask = {
                    name: "auto-selected",
                    prompt: prompt.slice(0, 500),
                    generatedAt: new Date().toISOString(),
                };
                await saveState(state);

                return `Orchestration cycle ready. Use pilotclaw_spawn to launch:\n\npilotclaw_spawn(name: "orchestrator", prompt: <the generated prompt>)\n\nGenerated prompt (${prompt.length} chars) analyzes ORCHESTRATION.md + ROADMAP.md to pick and execute the next task.`;
            },
        },
    ],
});
