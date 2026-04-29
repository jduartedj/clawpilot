import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureDir, sanitizeName } from "./fs.mjs";
import { COPILOT_BIN, HOME } from "./platform.mjs";
import { validateGatewayCwd } from "./gateway-cwd.mjs";
import { withSessionLock } from "./gateway-lock.mjs";
import { killProcessTree } from "./spawn-backend.mjs";
import {
    appendGatewayEvent,
    appendGatewayMessage,
    ensureGatewaySession,
    sessionPaths,
    updateGatewaySession,
} from "./gateway-session.mjs";

const activeRuns = new Map();

function runId(preferred = null) {
    const safe = sanitizeName(preferred);
    if (safe) return safe;
    return `run_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
}

async function appendOutput(sessionId, runIdValue, chunk) {
    if (!chunk) return;
    await appendGatewayEvent(sessionId, { runId: runIdValue, type: "run.output", data: { chunk } });
}

function scrubbedChildEnv() {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
        if (key.startsWith("PILOTCLAW_GATEWAY_")) delete env[key];
    }
    return env;
}

export async function runCopilotTurn({
    sessionId = "main",
    message,
    cwd = HOME,
    model = null,
    dryRun = false,
    idempotencyKey = null,
    runId: preferredRunId = null,
} = {}) {
    if (!String(message || "").trim()) {
        throw new Error("chat.send requires a non-empty message.");
    }
    const resolvedCwd = await validateGatewayCwd(cwd || HOME);
    const runIdValue = runId(preferredRunId || idempotencyKey);
    return withSessionLock(sessionId, runIdValue, async () => {
        const session = await ensureGatewaySession({ sessionId, cwd: resolvedCwd, model });
        const paths = sessionPaths(sessionId);
        await ensureDir(paths.runsDir);
        const runPath = join(paths.runsDir, `${runIdValue}.json`);
        await appendGatewayMessage(sessionId, { type: "user", runId: runIdValue, content: message });
        await updateGatewaySession(sessionId, { status: "running", lastRunId: runIdValue, cwd: resolvedCwd, model: model || session.model });
        await appendGatewayEvent(sessionId, { runId: runIdValue, type: "run.started", data: { cwd: resolvedCwd, model, dryRun } });

        if (dryRun) {
            const content = `DRY_RUN_OK ${session.logicalName}: ${String(message).slice(0, 200)}`;
            await appendOutput(sessionId, runIdValue, content);
            await appendGatewayMessage(sessionId, { type: "assistant", runId: runIdValue, content });
            await appendGatewayEvent(sessionId, { runId: runIdValue, type: "run.completed", data: { exitCode: 0, dryRun: true } });
            const completed = await updateGatewaySession(sessionId, { status: "idle" });
            const run = { id: runIdValue, sessionId: completed.id, status: "completed", dryRun: true, exitCode: 0, startedAt: new Date().toISOString(), endedAt: new Date().toISOString() };
            await writeFile(runPath, JSON.stringify(run, null, 2), { mode: 0o600 });
            return { session: completed, run, output: content, runId: run.id, status: run.status };
        }

        const args = [
            "-p", message,
            "--allow-all",
            "--autopilot",
            "--name", session.copilotName,
            "--output-format", "text",
            "--silent",
            "--no-ask-user",
        ];
        if (model) args.push("--model", model);
        const startedAt = new Date().toISOString();
        const child = spawn(COPILOT_BIN, args, { cwd: resolvedCwd, windowsHide: true, detached: true, env: scrubbedChildEnv() });
        activeRuns.set(sessionId, { child, runId: runIdValue });
        let output = "";
        let stderr = "";
        let eventChain = Promise.resolve();
        const queueOutput = (chunk) => {
            eventChain = eventChain.then(() => appendOutput(sessionId, runIdValue, chunk));
        };
        await writeFile(runPath, JSON.stringify({
            id: runIdValue,
            sessionId: session.id,
            pid: child.pid,
            status: "running",
            dryRun: false,
            startedAt,
        }, null, 2), { mode: 0o600 });
        child.stdout.on("data", (data) => {
            const chunk = data.toString();
            output += chunk;
            queueOutput(chunk);
        });
        child.stderr.on("data", (data) => {
            const chunk = data.toString();
            stderr += chunk;
            queueOutput(chunk);
        });

        const result = await new Promise((resolve, reject) => {
            child.once("error", (err) => {
                activeRuns.delete(sessionId);
                reject(err);
            });
            child.once("exit", (code, signal) => resolve({ exitCode: code, signal }));
        });
        activeRuns.delete(sessionId);
        const exitCode = result.exitCode;
        const status = result.signal ? "aborted" : exitCode === 0 ? "completed" : "failed";
        if (output.trim()) {
            await appendGatewayMessage(sessionId, { type: "assistant", runId: runIdValue, content: output.trim() });
        }
        await eventChain;
        await appendGatewayEvent(sessionId, {
            runId: runIdValue,
            type: status === "completed" ? "run.completed" : status === "aborted" ? "run.aborted" : "run.failed",
            data: { exitCode, signal: result.signal, stderr: stderr.slice(-4000) },
        });
        const updated = await updateGatewaySession(sessionId, { status: "idle" });
        const run = { id: runIdValue, sessionId: updated.id, status, dryRun: false, exitCode, signal: result.signal, startedAt, endedAt: new Date().toISOString(), stderr: stderr.slice(-4000) };
        await writeFile(runPath, JSON.stringify(run, null, 2), { mode: 0o600 });
        return { session: updated, run, output, runId: run.id, status: run.status };
    });
}

export async function abortCopilotTurn(sessionId = "main") {
    const active = activeRuns.get(sessionId);
    if (!active) {
        return { sessionId, aborted: false, reason: "no_active_run" };
    }
    const result = await killProcessTree(active.child.pid, "SIGTERM");
    const signaled = result.ok;
    await appendGatewayEvent(sessionId, { runId: active.runId, type: "run.abort_requested", data: { signaled } });
    return { sessionId, runId: active.runId, aborted: signaled };
}
