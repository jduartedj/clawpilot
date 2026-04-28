import { appendFile, chmod, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ensureDir, readJsonFile, sanitizeName, writeJsonFile } from "./fs.mjs";
import { GATEWAY_SESSIONS_DIR, HOME } from "./platform.mjs";

const eventAppendChains = new Map();

function now() {
    return new Date().toISOString();
}

export function safeSessionId(sessionId = "main") {
    return sanitizeName(sessionId) || "main";
}

export function sessionDir(sessionId) {
    return join(GATEWAY_SESSIONS_DIR, safeSessionId(sessionId));
}

export async function ensureGatewayDir(dir) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    try { await chmod(dir, 0o700); } catch { /* best effort on Windows */ }
}

export function sessionPaths(sessionId) {
    const dir = sessionDir(sessionId);
    return {
        dir,
        runsDir: join(dir, "runs"),
        session: join(dir, "session.json"),
        messages: join(dir, "messages.jsonl"),
        events: join(dir, "events.jsonl"),
    };
}

export async function ensureGatewaySession({ sessionId = "main", cwd = HOME, model = null } = {}) {
    const paths = sessionPaths(sessionId);
    await ensureGatewayDir(paths.runsDir);
    const existing = await readJsonFile(paths.session, null);
    const ts = now();
    const doc = {
        id: safeSessionId(sessionId),
        logicalName: String(sessionId || "main"),
        copilotName: safeSessionId(sessionId),
        createdAt: existing?.createdAt || ts,
        updatedAt: ts,
        cwd: cwd || existing?.cwd || HOME,
        model: model || existing?.model || null,
        lastRunId: existing?.lastRunId || null,
        status: existing?.status || "idle",
    };
    await writeJsonFile(paths.session, doc, { mode: 0o600 });
    return doc;
}

export async function updateGatewaySession(sessionId, patch) {
    const paths = sessionPaths(sessionId);
    const existing = await readJsonFile(paths.session, null);
    if (!existing) throw new Error(`Gateway session '${sessionId}' does not exist.`);
    const doc = { ...existing, ...patch, updatedAt: now() };
    await writeJsonFile(paths.session, doc, { mode: 0o600 });
    return doc;
}

async function appendJsonl(path, record) {
    await ensureGatewayDir(dirname(path));
    await appendFile(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

export async function appendGatewayMessage(sessionId, record) {
    const paths = sessionPaths(sessionId);
    const message = { ts: now(), ...record };
    await appendJsonl(paths.messages, message);
    return message;
}

async function lastEventSeq(eventsPath) {
    try {
        const raw = await readFile(eventsPath, "utf8");
        const lines = raw.trim().split(/\r?\n/).filter(Boolean);
        if (!lines.length) return 0;
        const last = JSON.parse(lines[lines.length - 1]);
        return Number(last.seq || 0);
    } catch (err) {
        if (err?.code === "ENOENT") return 0;
        throw err;
    }
}

async function appendGatewayEventUnlocked(sessionId, record) {
    const paths = sessionPaths(sessionId);
    const event = {
        seq: await lastEventSeq(paths.events) + 1,
        ts: now(),
        ...record,
    };
    await appendJsonl(paths.events, event);
    return event;
}

export function appendGatewayEvent(sessionId, record) {
    const previous = eventAppendChains.get(sessionId) || Promise.resolve();
    const next = previous.then(() => appendGatewayEventUnlocked(sessionId, record));
    eventAppendChains.set(sessionId, next.catch(() => {}).finally(() => {
        if (eventAppendChains.get(sessionId) === next) eventAppendChains.delete(sessionId);
    }));
    return next;
}

export async function readJsonl(path, { afterSeq = 0, limit = 200 } = {}) {
    try {
        const raw = await readFile(path, "utf8");
        return raw
            .split(/\r?\n/)
            .filter(Boolean)
            .map((line) => JSON.parse(line))
            .filter((record) => !afterSeq || Number(record.seq || 0) > Number(afterSeq))
            .slice(0, Number(limit || 200));
    } catch (err) {
        if (err?.code === "ENOENT") return [];
        throw err;
    }
}

export async function listGatewaySessions() {
    await ensureGatewayDir(GATEWAY_SESSIONS_DIR);
    const entries = await readdir(GATEWAY_SESSIONS_DIR, { withFileTypes: true });
    const sessions = [];
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const doc = await readJsonFile(join(GATEWAY_SESSIONS_DIR, entry.name, "session.json"), null);
        if (doc) sessions.push(doc);
    }
    return sessions.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

export async function getGatewaySession(sessionId) {
    const paths = sessionPaths(sessionId);
    const session = await readJsonFile(paths.session, null);
    if (!session) return null;
    return {
        session,
        messages: await readJsonl(paths.messages, { limit: 500 }),
        events: await readJsonl(paths.events, { limit: 500 }),
    };
}

export async function patchGatewaySession(sessionId, patch = {}) {
    await ensureGatewaySession({ sessionId });
    return await updateGatewaySession(sessionId, {
        ...(patch.cwd ? { cwd: patch.cwd } : {}),
        ...(patch.model !== undefined ? { model: patch.model } : {}),
        ...(patch.name ? { logicalName: String(patch.name) } : {}),
    });
}

export async function resetGatewaySession(sessionId) {
    const existing = await getGatewaySession(sessionId);
    if (!existing) return await ensureGatewaySession({ sessionId });
    const paths = sessionPaths(sessionId);
    await rm(paths.messages, { force: true });
    await rm(paths.events, { force: true });
    return await updateGatewaySession(sessionId, { status: "idle", lastRunId: null });
}

export async function deleteGatewaySession(sessionId) {
    await rm(sessionDir(sessionId), { recursive: true, force: true });
    return { id: safeSessionId(sessionId), deleted: true };
}
