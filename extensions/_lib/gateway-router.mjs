import { gatewayCapabilities, unsupportedCapability } from "./gateway-capabilities.mjs";
import { abortCopilotTurn, runCopilotTurn } from "./gateway-copilot-turn.mjs";
import { validateGatewayCwd } from "./gateway-cwd.mjs";
import { nodeDescribe, nodeEvent, nodeExec, nodeInvoke, nodeInvokeResult, nodeList, nodePendingAck, nodePendingDrain, nodePendingEnqueue, nodePendingPull, nodeStatus } from "./gateway-nodes.mjs";
import { deleteGatewaySession, ensureGatewaySession, getGatewaySession, listGatewaySessions, patchGatewaySession, readJsonl, resetGatewaySession, sessionPaths } from "./gateway-session.mjs";
import {
    adapterStatus,
    channelSend,
    channelStatus,
    heartbeatAck,
    heartbeatAdd,
    heartbeatList,
    heartbeatRemove,
    memorySearch,
    scheduleCreate,
    scheduleDelete,
    scheduleList,
    scheduleLogs,
    scheduleTrigger,
    vaultListNames,
} from "./gateway-adapters.mjs";

function alias(method) {
    return {
        "health/status": "health.status",
        "health": "health.status",
        "status": "gateway.status",
        "sessions.list": "session.list",
        "sessions.create": "session.create",
        "sessions.get": "session.get",
        "sessions.preview": "session.get",
        "sessions.resolve": "session.get",
        "sessions.events": "session.events",
        "sessions.send": "chat.send",
        "sessions.steer": "chat.send",
        "sessions.abort": "chat.abort",
        "sessions.patch": "session.patch",
        "sessions.reset": "session.reset",
        "sessions.delete": "session.delete",
        "agent": "chat.send",
        "agent.wait": "agent.wait",
        "chat.history": "chat.history",
        "chat.abort": "chat.abort",
        "cron.list": "schedule.list",
        "cron.status": "schedule.list",
        "cron.add": "schedule.create",
        "cron.update": "schedule.create",
        "cron.remove": "schedule.delete",
        "cron.run": "schedule.trigger",
        "schedules.list": "schedule.list",
        "schedules.create": "schedule.create",
        "schedules.trigger": "schedule.trigger",
        "schedules.delete": "schedule.delete",
        "schedules.logs": "schedule.logs",
        "heartbeats.list": "heartbeat.list",
        "heartbeats.status": "heartbeat.status",
        "channels.status": "channel.status",
        "channels.send": "channel.send",
        "vault.list": "vault.listNames",
        "usage.status": "gateway.status",
        "logs.tail": "gateway.logs",
        "send": "channel.send",
        "system-presence": "system.presence",
        "config.get": "config.get",
        "nodes.list": "node.list",
        "nodes.status": "node.status",
        "nodes.describe": "node.describe",
        "node.exec": "node.exec",
        "nodes.invoke": "node.invoke",
    }[method] || method;
}

function formatChatHistory(sessionDoc) {
    if (!sessionDoc) return { messages: [] };
    return {
        session: sessionDoc.session,
        messages: (sessionDoc.messages || []).map((message) => ({
            id: `${message.runId || "msg"}-${message.ts || ""}`,
            role: message.type === "user" ? "user" : message.type === "assistant" ? "assistant" : message.type,
            content: [{ type: "text", text: message.content || "" }],
            ts: message.ts,
            runId: message.runId,
        })),
    };
}

function sessionKey(params = {}) {
    return params.sessionKey || params.key || params.session || params.sessionId || params.name || "main";
}

function nodeRoleAllowed(method) {
    return new Set(["connect", "node.invoke.result", "node.event", "node.pending.pull", "node.pending.ack", "node.pending.drain", "skills.bins"]).has(alias(method));
}

export async function handleGatewayMethod(methodName, params = {}, context = {}) {
    const method = alias(methodName);
    if (context.role === "node" && !nodeRoleAllowed(methodName)) {
        const err = new Error(`Node connections cannot call gateway method: ${methodName}`);
        err.code = "unauthorized_role";
        throw err;
    }
    switch (method) {
        case "connect":
            return {
                type: "hello-ok",
                protocol: 3,
                server: { version: "pilotclaw-openclaw-compat/0.1", connId: context.connId || null },
                features: {
                    methods: [
                        "health", "status", "chat.history", "chat.send", "chat.abort", "agent", "agent.wait",
                        "sessions.list", "sessions.create", "sessions.get", "sessions.preview", "sessions.resolve",
                        "sessions.send", "sessions.steer", "sessions.abort",
                        "sessions.subscribe", "sessions.unsubscribe", "sessions.messages.subscribe", "sessions.messages.unsubscribe",
                        "sessions.patch", "sessions.reset", "sessions.delete",
                        "cron.list", "cron.status", "cron.add", "cron.update", "cron.remove", "cron.run",
                        "node.list", "node.status", "node.describe", "node.invoke", "node.exec",
                        "node.pending.enqueue", "node.pending.drain", "node.pending.pull", "node.pending.ack", "node.invoke.result", "node.event",
                        "nodes.list", "nodes.status", "nodes.describe", "nodes.invoke",
                        "skills.bins",
                        "channels.status", "send", "logs.tail", "usage.status",
                    ],
                    events: ["connect.challenge", "chat", "agent", "sessions.changed", "session.message", "session.tool", "cron", "node.connected", "node.invoke.request", "health", "tick", "shutdown"],
                },
                snapshot: { presence: [], health: { ok: true, backend: "pilotclaw" }, stateVersion: { presence: 1, health: 1 } },
                auth: { role: "operator", scopes: ["operator.read", "operator.write"] },
                policy: { maxPayload: 1048576, maxBufferedBytes: 1048576, tickIntervalMs: 30000 },
                compatibility: gatewayCapabilities(),
            };
        case "health.status":
        case "gateway.status":
            return { ok: true, version: "0.1.0", runtime: context.runtime || null, ...(await adapterStatus()) };
        case "gateway.capabilities":
            return gatewayCapabilities();
        case "system.presence":
            return { presence: [{ id: "pilotclaw", kind: "backend", status: "online", label: "PilotClaw compatibility gateway" }] };
        case "config.get":
            return { backend: "pilotclaw", compatibility: gatewayCapabilities(), config: {} };
        case "chat.send":
            return await runCopilotTurn({
                sessionId: sessionKey(params),
                message: typeof params.message === "string"
                    ? params.message
                    : Array.isArray(params.message?.content)
                        ? params.message.content.map((part) => part.text || "").join("\n")
                        : params.message?.content || params.prompt,
                cwd: params.cwd,
                model: params.model,
                dryRun: params.dryRun === true,
                idempotencyKey: params.idempotencyKey,
                runId: params.runId,
            });
        case "chat.abort":
            return await abortCopilotTurn(sessionKey(params));
        case "agent.wait": {
            const doc = await getGatewaySession(sessionKey(params));
            return {
                session: doc?.session || null,
                runId: params.runId || doc?.session?.lastRunId || null,
                status: doc?.session?.status || "unknown",
                messages: doc?.messages || [],
            };
        }
        case "chat.history":
            return formatChatHistory(await getGatewaySession(sessionKey(params)));
        case "session.list":
            return { sessions: await listGatewaySessions() };
        case "session.create": {
            const cwd = params.cwd ? await validateGatewayCwd(params.cwd) : undefined;
            const session = await ensureGatewaySession({ sessionId: sessionKey(params), cwd, model: params.model });
            return { sessionId: session.id, sessionKey: session.logicalName, session };
        }
        case "session.get":
            return await getGatewaySession(sessionKey(params));
        case "session.events": {
            const paths = sessionPaths(sessionKey(params));
            return { events: await readJsonl(paths.events, { afterSeq: params.afterSeq || 0, limit: params.limit || 200 }) };
        }
        case "sessions.subscribe":
        case "sessions.unsubscribe":
        case "sessions.messages.subscribe":
        case "sessions.messages.unsubscribe":
        case "session.subscribe":
        case "session.unsubscribe":
            return { subscribed: !method.includes("unsubscribe"), noOp: true, compatibility: "websocket-events-best-effort" };
        case "session.patch": {
            const patch = { ...(params.patch || params) };
            if (patch.cwd) patch.cwd = await validateGatewayCwd(patch.cwd);
            return { session: await patchGatewaySession(sessionKey(params), patch) };
        }
        case "session.reset":
            return { session: await resetGatewaySession(sessionKey(params)) };
        case "session.delete":
            return await deleteGatewaySession(sessionKey(params));
        case "schedule.list":
            return await scheduleList();
        case "schedule.create":
            return await scheduleCreate(params);
        case "schedule.delete":
            return await scheduleDelete(params);
        case "schedule.trigger":
            return await scheduleTrigger(params);
        case "schedule.logs":
            return await scheduleLogs(params);
        case "heartbeat.list":
        case "heartbeat.status":
            return await heartbeatList();
        case "heartbeat.add":
            return await heartbeatAdd(params);
        case "heartbeat.remove":
            return await heartbeatRemove(params);
        case "heartbeat.ack":
            return await heartbeatAck(params);
        case "channel.status":
            return await channelStatus();
        case "channel.send":
            return await channelSend(params);
        case "memory.search":
            return await memorySearch(params);
        case "vault.listNames":
            return await vaultListNames();
        case "node.list":
            return await nodeList(params);
        case "node.status":
            return await nodeStatus(params);
        case "node.describe":
            return await nodeDescribe(params);
        case "node.invoke":
            return await nodeInvoke(params);
        case "node.exec":
            return await nodeExec(params);
        case "node.invoke.result":
            return nodeInvokeResult(params, context);
        case "node.event":
            return nodeEvent(params, context);
        case "node.pending.pull":
            return nodePendingPull(params, context);
        case "node.pending.ack":
            return nodePendingAck(params, context);
        case "node.pending.enqueue":
            return nodePendingEnqueue(params);
        case "node.pending.drain":
            return nodePendingDrain(context.role === "node" ? { ...params, connId: context.connId } : params);
        case "skills.bins":
            return { bins: ["node", "npm", "npx", "python", "python3", "pwsh", "powershell", "cmd", "bash", "sh", "git"] };
        case "voice.status":
        case "voice.start":
        case "voice.stop":
        case "canvas.status":
        case "node.canvas.capability.refresh":
            return unsupportedCapability(method);
        default: {
            const err = new Error(`Unsupported gateway method: ${methodName}`);
            err.code = "unsupported_method";
            throw err;
        }
    }
}

export async function gatewayRpcEnvelope(request, context = {}) {
    const requestId = request?.id || request?.requestId || `req_${Date.now()}`;
    const method = request?.method;
    const timestamp = new Date().toISOString();
    if (!method) {
        return { ok: false, requestId, timestamp, error: { code: "missing_method", message: "RPC request requires a method." }, capabilities: gatewayCapabilities() };
    }
    try {
        const result = await handleGatewayMethod(method, request.params || {}, context);
        return { ok: true, method, requestId, timestamp, result, capabilities: gatewayCapabilities() };
    } catch (err) {
        return {
            ok: false,
            method,
            requestId,
            timestamp,
            error: { code: err.code || "gateway_error", message: err.message || String(err) },
            capabilities: gatewayCapabilities(),
        };
    }
}
