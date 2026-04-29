import { randomUUID } from "node:crypto";
import {
    ackGatewayNodeActions,
    drainGatewayNodeActions,
    drainGatewayNodeActionsForConn,
    enqueueGatewayNodeAction,
    findGatewayNode,
    getGatewayNode,
    handleGatewayNodeInvokeResult,
    invokeGatewayNode,
    listGatewayNodes,
    pullGatewayNodeActions,
} from "./gateway-node-registry.mjs";

function normalize(value) {
    return String(value || "").trim();
}

function nodeRef(params = {}) {
    return normalize(params.nodeId || params.node || params.id || params.name || params.ip);
}

function commandName(params = {}) {
    return normalize(params.command || params.invokeCommand || params.name);
}

function invokeTimeout(params = {}, fallback = 30000) {
    const value = Number(params.timeoutMs || params.invokeTimeoutMs || params.invokeTimeout || fallback);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

function commandParams(params = {}) {
    if (!params.params || typeof params.params !== "object" || Array.isArray(params.params)) return {};
    const clean = { ...params.params };
    delete clean._bridge;
    return clean;
}

function resolveNodeId(params = {}) {
    const ref = nodeRef(params);
    const node = findGatewayNode(ref);
    if (!node) throw new Error(ref ? `Unknown node: ${ref}` : "nodeId is required.");
    return node.nodeId;
}

function normalizePayload(result) {
    if (!result.ok) return result;
    try {
        return {
            ok: true,
            payload: result.payloadJSON ? JSON.parse(result.payloadJSON) : result.payload,
            payloadJSON: result.payloadJSON || null,
        };
    } catch {
        return { ok: false, error: { code: "INVALID_PAYLOAD", message: "Invalid node payloadJSON." } };
    }
}

function throwInvokeError(result) {
    const err = new Error(result.error?.message || "node invoke failed");
    err.code = result.error?.code || "node_invoke_failed";
    err.details = result.error?.details;
    throw err;
}

function autoApproveSystemRunParams(params = {}, timeoutMs) {
    const command = Array.isArray(params.command)
        ? params.command
        : Array.isArray(params.argv)
            ? params.argv
            : typeof params.rawCommand === "string"
                ? params.rawCommand
                : params.commandText;
    if (!command) throw new Error("system.run requires params.command, params.argv, or params.rawCommand.");
    const runId = normalize(params.runId) || `pilotclaw-node-${Date.now()}-${randomUUID().slice(0, 8)}`;
    return {
        command,
        ...(params.rawCommand ? { rawCommand: params.rawCommand } : {}),
        ...(params.cwd ? { cwd: params.cwd } : {}),
        ...(params.env && typeof params.env === "object" ? { env: params.env } : {}),
        timeoutMs,
        agentId: params.agentId || "pilotclaw",
        sessionKey: params.sessionKey || "pilotclaw-node",
        approved: true,
        approvalDecision: "allow-once",
        runId,
        suppressNotifyOnExit: params.suppressNotifyOnExit === false ? false : true,
    };
}

async function runSystemCommand({ nodeId, params, timeoutMs, idempotencyKey }) {
    const command = Array.isArray(params.command)
        ? params.command
        : Array.isArray(params.argv)
            ? params.argv
            : typeof params.rawCommand === "string"
                ? params.rawCommand
                : params.commandText;
    if (!command) throw new Error("system.run requires params.command, params.argv, or params.rawCommand.");
    const prepare = normalizePayload(await invokeGatewayNode({
        nodeId,
        command: "system.run.prepare",
        params: {
            command,
            ...(params.rawCommand ? { rawCommand: params.rawCommand } : {}),
            ...(params.cwd ? { cwd: params.cwd } : {}),
            agentId: params.agentId || "pilotclaw",
            sessionKey: params.sessionKey || "pilotclaw-node",
        },
        timeoutMs: Math.min(timeoutMs, 20000),
        idempotencyKey: randomUUID(),
    }));
    if (!prepare.ok) throwInvokeError(prepare);
    const plan = prepare.payload?.plan;
    if (!plan) throw new Error("Node did not return a system.run approval plan.");
    return normalizePayload(await invokeGatewayNode({
        nodeId,
        command: "system.run",
        params: {
            ...autoApproveSystemRunParams({ ...params, command: plan.argv, rawCommand: plan.commandText }, timeoutMs),
            systemRunPlan: plan,
            ...(plan.cwd ? { cwd: plan.cwd } : {}),
            agentId: plan.agentId || params.agentId || "pilotclaw",
            sessionKey: plan.sessionKey || params.sessionKey || "pilotclaw-node",
        },
        timeoutMs,
        idempotencyKey,
    }));
}

export async function nodeList() {
    return { ts: Date.now(), nodes: listGatewayNodes() };
}

export async function nodeStatus() {
    const nodes = listGatewayNodes();
    return {
        ts: Date.now(),
        nodes,
        known: nodes.length,
        connected: nodes.filter((node) => node.connected === true).length,
    };
}

export async function nodeDescribe(params = {}) {
    const node = getGatewayNode(resolveNodeId(params));
    if (!node) throw new Error("unknown nodeId");
    return { ts: Date.now(), ...node };
}

export async function nodeInvoke(params = {}) {
    const nodeId = resolveNodeId(params);
    const command = commandName(params);
    if (!command) throw new Error("node.invoke requires a command.");
    const timeoutMs = invokeTimeout(params);
    const idempotencyKey = params.idempotencyKey || randomUUID();
    const result = command === "system.run"
        ? await runSystemCommand({ nodeId, params: commandParams(params), timeoutMs, idempotencyKey })
        : normalizePayload(await invokeGatewayNode({
            nodeId,
            command,
            params: commandParams(params),
            timeoutMs,
            idempotencyKey,
        }));
    if (!result.ok) throwInvokeError(result);
    return {
        ok: true,
        nodeId,
        command,
        payload: result.payload,
        payloadJSON: result.payloadJSON,
    };
}

export async function nodeExec(params = {}) {
    const command = params.command || params.rawCommand || params.cmd;
    const argv = Array.isArray(params.argv) ? params.argv : Array.isArray(params.args) && params.cmd ? [params.cmd, ...params.args] : null;
    return await nodeInvoke({
        ...params,
        command: "system.run",
        params: {
            command: argv || command,
            rawCommand: params.rawCommand,
            cwd: params.cwd,
            env: params.env,
            timeoutMs: params.timeoutMs,
            agentId: params.agentId,
            sessionKey: params.sessionKey,
            runId: params.runId,
            suppressNotifyOnExit: params.suppressNotifyOnExit,
        },
    });
}

export function nodeInvokeResult(params = {}, context = {}) {
    if (context.role !== "node") {
        const err = new Error("node.invoke.result is only accepted from node connections.");
        err.code = "INVALID_REQUEST";
        throw err;
    }
    const result = handleGatewayNodeInvokeResult(params, context.connId);
    if (!result.ok) {
        const err = new Error(result.error?.message || "node.invoke.result failed");
        err.code = result.error?.code || "INVALID_REQUEST";
        throw err;
    }
    return result;
}

export function nodeEvent(params = {}, context = {}) {
    if (context.role !== "node") {
        const err = new Error("node.event is only accepted from node connections.");
        err.code = "INVALID_REQUEST";
        throw err;
    }
    return { ok: true, event: params.event || null };
}

export function nodePendingPull(_params = {}, context = {}) {
    const result = pullGatewayNodeActions(context.connId);
    if (!result.ok) {
        const err = new Error(result.error?.message || "node.pending.pull failed");
        err.code = result.error?.code || "INVALID_REQUEST";
        throw err;
    }
    return result;
}

export function nodePendingAck(params = {}, context = {}) {
    const result = ackGatewayNodeActions(context.connId, params.ids);
    if (!result.ok) {
        const err = new Error(result.error?.message || "node.pending.ack failed");
        err.code = result.error?.code || "INVALID_REQUEST";
        throw err;
    }
    return result;
}

export function nodePendingEnqueue(params = {}) {
    const result = enqueueGatewayNodeAction(params);
    if (!result.ok) {
        const err = new Error(result.error?.message || "node.pending.enqueue failed");
        err.code = result.error?.code || "INVALID_REQUEST";
        throw err;
    }
    return result;
}

export function nodePendingDrain(params = {}) {
    const result = params.connId ? drainGatewayNodeActionsForConn(params.connId) : drainGatewayNodeActions(params);
    if (!result.ok) {
        const err = new Error(result.error?.message || "node.pending.drain failed");
        err.code = result.error?.code || "INVALID_REQUEST";
        throw err;
    }
    return result;
}
