import http from "node:http";
import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { URL } from "node:url";
import { readJsonFile } from "./fs.mjs";
import { gatewayRpcEnvelope } from "./gateway-router.mjs";
import { GATEWAY_DIR, GATEWAY_RUNTIME_DIR, GATEWAY_SESSIONS_DIR, HOME } from "./platform.mjs";
import { ensureGatewayDir, sessionPaths, readJsonl } from "./gateway-session.mjs";
import { initializeGatewayNodes, registerGatewayNode, releaseGatewayNodeReservation, reserveGatewayNodeConnect, unregisterGatewayNode } from "./gateway-node-registry.mjs";
import { restrictWindowsFileAccess } from "./taskscheduler.mjs";

export const DEFAULT_GATEWAY_PORT = 18789;

const MAX_PAYLOAD_BYTES = 1024 * 1024;
const OPENCLAW_DEVICE_AUTH_FILE = `${HOME}/.openclaw/identity/device-auth.json`;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

async function readBody(req) {
    let body = "";
    for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > MAX_PAYLOAD_BYTES) {
            const err = new Error("Request body too large.");
            err.code = "payload_too_large";
            throw err;
        }
    }
    return body;
}

function sendJson(res, status, body) {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body, null, 2));
}

function wsAcceptKey(key) {
    return createHash("sha1")
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");
}

function wsFrame(payload) {
    const data = Buffer.from(JSON.stringify(payload));
    let header;
    if (data.length < 126) {
        header = Buffer.from([0x81, data.length]);
    } else if (data.length <= 0xffff) {
        header = Buffer.from([0x81, 126, data.length >> 8, data.length & 0xff]);
    } else if (data.length <= MAX_PAYLOAD_BYTES) {
        header = Buffer.alloc(10);
        header[0] = 0x81;
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(data.length), 2);
    } else {
        throw new Error("WebSocket frame too large.");
    }
    return Buffer.concat([header, data]);
}

function parseWsFrames(buffer) {
    const messages = [];
    let offset = 0;
    while (offset + 2 <= buffer.length) {
        const start = offset;
        const byte1 = buffer[offset++];
        const byte2 = buffer[offset++];
        const opcode = byte1 & 0x0f;
        const masked = Boolean(byte2 & 0x80);
        let length = byte2 & 0x7f;
        if ([0x0, 0x1, 0x2].includes(opcode) && !masked) {
            const err = new Error("Unmasked WebSocket client frame.");
            err.code = "protocol_error";
            throw err;
        }
        if (length === 126) {
            if (offset + 2 > buffer.length) return { messages, rest: buffer.subarray(start) };
            length = buffer.readUInt16BE(offset);
            offset += 2;
        } else if (length === 127) {
            if (offset + 8 > buffer.length) return { messages, rest: buffer.subarray(start) };
            const bigLength = buffer.readBigUInt64BE(offset);
            offset += 8;
            if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Large WebSocket frames are not supported.");
            length = Number(bigLength);
        }
        if (length > MAX_PAYLOAD_BYTES) {
            const err = new Error("WebSocket frame too large.");
            err.code = "payload_too_large";
            throw err;
        }
        let mask = null;
        if (masked) {
            if (offset + 4 > buffer.length) return { messages, rest: buffer.subarray(start) };
            mask = buffer.subarray(offset, offset + 4);
            offset += 4;
        }
        if (offset + length > buffer.length) return { messages, rest: buffer.subarray(start) };
        const payload = Buffer.from(buffer.subarray(offset, offset + length));
        offset += length;
        if (mask) {
            for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        }
        if (opcode === 0x8) messages.push({ close: true });
        if (opcode === 0x1) messages.push({ text: payload.toString("utf8") });
    }
    return { messages, rest: buffer.subarray(offset) };
}

function safeEquals(a, b) {
    const left = Buffer.from(String(a || ""));
    const right = Buffer.from(String(b || ""));
    if (left.length !== right.length) return false;
    return timingSafeEqual(left, right);
}

function base64UrlDecode(value) {
    const raw = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
    return Buffer.from(raw.padEnd(raw.length + ((4 - raw.length % 4) % 4), "="), "base64");
}

function openClawPublicKey(rawPublicKey) {
    const raw = base64UrlDecode(rawPublicKey);
    const der = raw.length === 32 ? Buffer.concat([ED25519_SPKI_PREFIX, raw]) : raw;
    return createPublicKey({ key: der, format: "der", type: "spki" });
}

async function loadOpenClawOperatorToken() {
    const auth = await readJsonFile(OPENCLAW_DEVICE_AUTH_FILE, null);
    return auth?.tokens?.operator?.token || null;
}

async function openClawDeviceAuthorized(params = {}, nonce = "") {
    const token = params.auth?.token || "";
    const expected = await loadOpenClawOperatorToken();
    if (!expected || !safeEquals(token, expected)) return false;
    if (!params.device) return true;
    if (params.device.nonce !== nonce) return false;
    const signedAt = Number(params.device.signedAt || 0);
    if (!Number.isFinite(signedAt) || Math.abs(Date.now() - signedAt) > 10 * 60 * 1000) return false;
    const scopes = Array.isArray(params.scopes) ? params.scopes : [];
    const payloads = [[
        "v2",
        params.device.id,
        params.client?.id || "",
        params.client?.mode || "",
        params.role || "",
        scopes.join(","),
        String(signedAt),
        token,
        nonce,
    ].join("|")];
    if (params.client?.platform || params.device?.platform || params.device?.deviceFamily || params.deviceFamily) {
        payloads.push([
            "v3",
            params.device.id,
            params.client?.id || "",
            params.client?.mode || "",
            params.role || "",
            scopes.join(","),
            String(signedAt),
            token,
            nonce,
            params.client?.platform || params.device?.platform || "",
            params.device?.deviceFamily || params.deviceFamily || "",
        ].join("|"));
    }
    try {
        const key = openClawPublicKey(params.device.publicKey);
        const signature = base64UrlDecode(params.device.signature);
        return payloads.some((payload) => verify(null, Buffer.from(payload, "utf8"), key, signature));
    } catch {
        return false;
    }
}

async function connectAuthorized(params, runtime, nonce) {
    if (safeEquals(params?.auth?.token || "", runtime.token)) return true;
    return await openClawDeviceAuthorized(params, nonce);
}

function isLoopbackHost(host) {
    let value = String(host || "").toLowerCase();
    try {
        value = new URL(`http://${value}`).hostname.toLowerCase();
    } catch {
        value = value.split(":")[0].replace(/^\[|\]$/g, "");
    }
    return ["localhost", "::1", "0:0:0:0:0:0:0:1"].includes(value) || value === "127.0.0.1" || value.startsWith("127.") || value === "::ffff:127.0.0.1";
}

function requestOriginAllowed(req, runtime) {
    const allowPublic = process.env.PILOTCLAW_GATEWAY_ALLOW_PUBLIC === "1";
    if (!allowPublic && (!isLoopbackHost(req.headers.host) || !isLoopbackHost(req.socket.remoteAddress))) return false;
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
        const parsed = new URL(origin);
        return (allowPublic || isLoopbackHost(parsed.host)) && Number(parsed.port || runtime.port) === Number(runtime.port);
    } catch {
        return false;
    }
}

function authorized(req, runtime) {
    if (["/health", "/healthz", "/readyz"].includes(req.url)) return true;
    const expected = runtime?.token;
    if (!expected) return false;
    return safeEquals(req.headers.authorization || "", `Bearer ${expected}`);
}

export async function loadGatewayRuntime() {
    return await readJsonFile(`${GATEWAY_RUNTIME_DIR}/runtime.json`, null);
}

async function writeRuntime(runtime) {
    await mkdir(GATEWAY_RUNTIME_DIR, { recursive: true, mode: 0o700 });
    try { await chmod(GATEWAY_RUNTIME_DIR, 0o700); } catch { /* best effort on Windows */ }
    const runtimeFile = `${GATEWAY_RUNTIME_DIR}/runtime.json`;
    await writeFile(runtimeFile, JSON.stringify(runtime, null, 2), { mode: 0o600 });
    await restrictWindowsFileAccess(GATEWAY_RUNTIME_DIR);
    await restrictWindowsFileAccess(runtimeFile);
}

async function handleEvents(req, res, runtime) {
    if (!authorized(req, runtime)) return sendJson(res, 401, { ok: false, error: { code: "unauthorized", message: "Invalid gateway token." } });
    const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
    const session = url.searchParams.get("session") || "main";
    let cursor = Number(req.headers["last-event-id"] || url.searchParams.get("afterSeq") || 0);
    res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
    });
    const sendEvents = async () => {
        const events = await readJsonl(sessionPaths(session).events, { afterSeq: cursor, limit: 100 });
        for (const event of events) {
            cursor = Number(event.seq || cursor);
            res.write(`id: ${cursor}\n`);
            res.write(`event: ${event.type || "message"}\n`);
            res.write(`data: ${JSON.stringify(event)}\n\n`);
        }
    };
    await sendEvents();
    const timer = setInterval(() => {
        sendEvents().catch((err) => res.write(`event: error\ndata: ${JSON.stringify({ message: err.message })}\n\n`));
    }, 1000);
    req.on("close", () => clearInterval(timer));
}

export async function startGatewayServer({ host = process.env.PILOTCLAW_GATEWAY_BIND || "127.0.0.1", port = Number(process.env.PILOTCLAW_GATEWAY_PORT || DEFAULT_GATEWAY_PORT) } = {}) {
    if (!isLoopbackHost(host) && process.env.PILOTCLAW_GATEWAY_ALLOW_PUBLIC !== "1") {
        throw new Error("Refusing non-loopback gateway bind without PILOTCLAW_GATEWAY_ALLOW_PUBLIC=1.");
    }
    await ensureGatewayDir(GATEWAY_DIR);
    await ensureGatewayDir(GATEWAY_SESSIONS_DIR);
    await initializeGatewayNodes();
    const envToken = process.env.PILOTCLAW_GATEWAY_TOKEN;
    const token = envToken && envToken.trim() ? envToken : randomBytes(24).toString("hex");
    const runtime = {
        pid: process.pid,
        host,
        port,
        token,
        startedAt: new Date().toISOString(),
        version: "0.1.0",
    };
    const server = http.createServer(async (req, res) => {
        try {
            if (req.method === "GET" && req.url?.startsWith("/events")) {
                if (!requestOriginAllowed(req, runtime)) return sendJson(res, 403, { ok: false, error: { code: "forbidden_origin", message: "Host or Origin is not allowed." } });
                return await handleEvents(req, res, runtime);
            }
            if (req.method === "GET" && ["/health", "/healthz", "/readyz"].includes(req.url)) {
                return sendJson(res, 200, { ok: true, status: req.url === "/healthz" ? "live" : "ready", runtime: { ...runtime, token: undefined } });
            }
            if (req.method === "HEAD" && ["/health", "/healthz", "/readyz"].includes(req.url)) {
                res.writeHead(200);
                return res.end();
            }
            if (!requestOriginAllowed(req, runtime)) {
                return sendJson(res, 403, { ok: false, error: { code: "forbidden_origin", message: "Host or Origin is not allowed." } });
            }
            if (!authorized(req, runtime)) {
                return sendJson(res, 401, { ok: false, error: { code: "unauthorized", message: "Invalid gateway token." } });
            }
            if (req.method !== "POST" || req.url !== "/rpc") {
                return sendJson(res, 404, { ok: false, error: { code: "not_found", message: "Use POST /rpc or GET /events." } });
            }
            let request;
            try {
                request = JSON.parse(await readBody(req));
            } catch {
                return sendJson(res, 400, { ok: false, error: { code: "bad_request", message: "Malformed JSON request body or payload too large." } });
            }
            return sendJson(res, 200, await gatewayRpcEnvelope(request, { runtime: { ...runtime, token: undefined } }));
        } catch (err) {
            return sendJson(res, 500, { ok: false, error: { code: "gateway_error", message: err.message || String(err) } });
        }
    });
    server.on("upgrade", (req, socket) => {
        const key = req.headers["sec-websocket-key"];
        if (!key || !requestOriginAllowed(req, runtime)) {
            socket.destroy();
            return;
        }
        socket.write([
            "HTTP/1.1 101 Switching Protocols",
            "Upgrade: websocket",
            "Connection: Upgrade",
            `Sec-WebSocket-Accept: ${wsAcceptKey(key)}`,
            "",
            "",
        ].join("\r\n"));
        const connId = randomBytes(8).toString("hex");
        let seq = 1;
        let connected = false;
        let role = "operator";
        let wsBuffer = Buffer.alloc(0);
        const send = (message) => {
            if (!socket.destroyed) socket.write(wsFrame(message));
        };
        const event = (name, payload, options = {}) => {
            if (socket.destroyed) return false;
            const message = { type: "event", event: name, payload };
            if (options.seq !== false) message.seq = seq++;
            send(message);
            return true;
        };
        const emitCompatEvents = (request, payload) => {
            const params = request.params || {};
            const sessionKey = params.sessionKey || params.key || params.session || params.sessionId || "main";
            if (["chat.send", "sessions.send", "sessions.steer", "agent"].includes(request.method)) {
                const runId = payload?.run?.id || null;
                const message = payload?.output
                    ? { role: "assistant", content: [{ type: "text", text: payload.output }], timestamp: Date.now() }
                    : null;
                event("chat", {
                    sessionKey,
                    runId,
                    state: "final",
                    message,
                    run: payload?.run || null,
                });
                if (payload?.output) {
                    event("session.message", {
                        sessionKey,
                        message: { ...message, runId },
                    });
                }
                event("sessions.changed", { sessionKey, reason: "chat.send", session: payload?.session || null });
            }
            if (request.method?.startsWith("sessions.") && !request.method.includes("subscribe")) {
                event("sessions.changed", { sessionKey, reason: request.method, payload });
            }
            if (request.method?.startsWith("cron.")) {
                event("cron", { method: request.method, payload });
            }
        };
        event("connect.challenge", { nonce: connId, ts: Date.now() }, { seq: false });
        const tick = setInterval(() => event("tick", { ts: Date.now() }), 30000);
        socket.on("data", async (data) => {
            if (wsBuffer.length + data.length > MAX_PAYLOAD_BYTES) {
                socket.end(wsFrame({ type: "event", event: "shutdown", payload: { reason: "payload_too_large" }, seq: seq++ }));
                return;
            }
            wsBuffer = Buffer.concat([wsBuffer, data]);
            let parsed;
            try {
                parsed = parseWsFrames(wsBuffer);
            } catch (err) {
                socket.end(wsFrame({ type: "event", event: "shutdown", payload: { reason: err.code || "protocol_error" }, seq: seq++ }));
                return;
            }
            wsBuffer = parsed.rest;
            for (const frame of parsed.messages) {
                if (frame.close) {
                    socket.end();
                    return;
                }
                let request;
                try {
                    request = JSON.parse(frame.text);
                } catch {
                    send({ type: "res", id: null, ok: false, error: { code: "INVALID_REQUEST", message: "Malformed JSON frame.", retryable: false } });
                    continue;
                }
                if (request.type !== "req") continue;
                if (connected && request.method === "connect") {
                    send({ type: "res", id: request.id, ok: false, error: { code: "ALREADY_CONNECTED", message: "Cannot reconnect on an established socket.", retryable: false } });
                    continue;
                }
                if (!connected && request.method !== "connect") {
                    send({ type: "res", id: request.id, ok: false, error: { code: "NOT_PAIRED", message: "Call connect before other methods.", retryable: false } });
                    continue;
                }
                if (request.method === "connect" && !(await connectAuthorized(request.params || {}, runtime, connId))) {
                    send({ type: "res", id: request.id, ok: false, error: { code: "NOT_PAIRED", message: "Invalid gateway token.", retryable: false } });
                    continue;
                }
                const requestRole = request.method === "connect" && request.params?.role === "node" ? "node" : role;
                let reservedNodeId = null;
                if (request.method === "connect" && requestRole === "node") {
                    try {
                        reservedNodeId = reserveGatewayNodeConnect(request.params || {}, connId);
                    } catch (err) {
                        send({ type: "res", id: request.id, ok: false, error: { code: err.code || "INVALID_REQUEST", message: err.message, retryable: false } });
                        continue;
                    }
                }
                const envelope = await gatewayRpcEnvelope(request, { runtime: { ...runtime, token: undefined }, connId, role: requestRole });
                if (envelope.ok) {
                    if (request.method === "connect") {
                        connected = true;
                        role = requestRole;
                        send({ type: "res", id: request.id, ok: true, payload: envelope.result });
                        if (role === "node") {
                            try {
                                const node = await registerGatewayNode({
                                    connId,
                                    connect: request.params || {},
                                    remoteIp: req.socket.remoteAddress || null,
                                    sendEvent: (name, payload) => event(name, payload, { seq: false }),
                                });
                                event("node.connected", { nodeId: node.nodeId || reservedNodeId, ts: Date.now() }, { seq: false });
                            } catch (err) {
                                connected = false;
                                role = "operator";
                                releaseGatewayNodeReservation(connId);
                                event("shutdown", { reason: err.code || "node_registration_failed", message: err.message }, { seq: false });
                                socket.end();
                                return;
                            }
                        }
                        continue;
                    }
                    send({ type: "res", id: request.id, ok: true, payload: envelope.result });
                    emitCompatEvents(request, envelope.result);
                } else {
                    if (reservedNodeId) releaseGatewayNodeReservation(connId);
                    send({ type: "res", id: request.id, ok: false, error: { code: envelope.error?.code === "unsupported_method" ? "UNAVAILABLE" : "INVALID_REQUEST", message: envelope.error?.message || "Gateway error", details: envelope.error, retryable: false } });
                }
            }
        });
        socket.on("close", () => {
            clearInterval(tick);
            unregisterGatewayNode(connId).catch(() => {});
        });
        socket.on("error", () => {
            clearInterval(tick);
            unregisterGatewayNode(connId).catch(() => {});
        });
    });
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, resolve);
    });
    await writeRuntime(runtime);
    return { server, runtime };
}
