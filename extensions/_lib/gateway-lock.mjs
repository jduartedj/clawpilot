import { open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { GATEWAY_LOCKS_DIR } from "./platform.mjs";
import { isProcessRunning } from "./spawn-backend.mjs";
import { ensureGatewayDir } from "./gateway-session.mjs";
import { sanitizeName } from "./fs.mjs";

const chains = new Map();

function lockPath(sessionId) {
    return join(GATEWAY_LOCKS_DIR, `${sanitizeName(sessionId) || "main"}.lock`);
}

async function acquireFileLock(sessionId, runId) {
    await ensureGatewayDir(GATEWAY_LOCKS_DIR);
    const path = lockPath(sessionId);
    for (let attempt = 0; attempt < 40; attempt++) {
        try {
            const handle = await open(path, "wx", 0o600);
            await handle.writeFile(JSON.stringify({
                pid: process.pid,
                runId,
                startedAt: new Date().toISOString(),
            }));
            await handle.close();
            return async () => {
                try { await unlink(path); } catch (err) { if (err?.code !== "ENOENT") throw err; }
            };
        } catch (err) {
            if (err?.code !== "EEXIST") throw err;
            try {
                const current = JSON.parse(await readFile(path, "utf8"));
                if (current?.pid && !isProcessRunning(current.pid)) {
                    await unlink(path);
                    continue;
                }
            } catch { /* active writer or corrupt lock: wait for timeout instead of deleting */ }
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
    }
    throw new Error(`Session '${sessionId}' is busy.`);
}

export function withSessionLock(sessionId, runId, fn) {
    const previous = chains.get(sessionId) || Promise.resolve();
    const next = previous.then(async () => {
        const release = await acquireFileLock(sessionId, runId);
        try {
            return await fn();
        } finally {
            await release();
        }
    });
    chains.set(sessionId, next.catch(() => {}).finally(() => {
        if (chains.get(sessionId) === next) chains.delete(sessionId);
    }));
    return next;
}
