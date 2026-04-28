import { spawn as nodeSpawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { exec } from "./exec.mjs";
import { COPILOT_BIN, IS_WINDOWS } from "./platform.mjs";

export function isProcessRunning(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

export function spawnDetachedCopilot({ prompt, name, cwd, model, logPath, env = process.env }) {
    const copilotArgs = [
        "-p", prompt,
        "--allow-all",
        "--autopilot",
        "--name", `spawn-${name}`,
        "--output-format", "text",
        "--silent",
        "--no-ask-user",
    ];
    if (model) copilotArgs.push("--model", model);

    const logFd = openSync(logPath, "w");
    const child = nodeSpawn(COPILOT_BIN, copilotArgs, {
        cwd: cwd || process.cwd(),
        stdio: ["ignore", logFd, logFd],
        detached: true,
        windowsHide: true,
        env: { ...env },
    });
    child.once("error", () => {});
    child.unref();
    closeSync(logFd);
    if (!child.pid) {
        throw new Error(`Failed to spawn ${COPILOT_BIN}`);
    }
    return child;
}

export async function killProcessTree(pid, signal = "SIGTERM") {
    if (IS_WINDOWS) {
        return exec("taskkill", ["/PID", String(pid), "/T", "/F"]);
    }
    try {
        process.kill(-pid, signal);
        return { ok: true, stdout: "", stderr: "" };
    } catch {
        try {
            process.kill(pid, signal);
            return { ok: true, stdout: "", stderr: "" };
        } catch (err) {
            return { ok: false, stdout: "", stderr: err.message, code: err.code };
        }
    }
}
