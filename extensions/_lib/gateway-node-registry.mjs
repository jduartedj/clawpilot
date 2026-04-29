import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { readJsonFile, writeJsonFile } from "./fs.mjs";
import { GATEWAY_DIR } from "./platform.mjs";

const NODE_DIR = join(GATEWAY_DIR, "nodes");
const KNOWN_NODES_FILE = join(NODE_DIR, "known.json");
const DEFAULT_INVOKE_TIMEOUT_MS = 30000;
const MAX_PENDING_ACTIONS_PER_NODE = 64;
const nodesById = new Map();
const nodesByConn = new Map();
const registeringNodes = new Map();
const pendingInvokes = new Map();
const pendingActionsByNode = new Map();
const knownNodes = new Map();

function nowMs() {
    return Date.now();
}

function normalize(value) {
    return String(value || "").trim();
}

function normalizeNodeId(connect) {
    return normalize(connect?.device?.id || connect?.client?.instanceId || connect?.client?.id);
}

export function validateGatewayNodeConnect(connect, connId) {
    const nodeId = normalizeNodeId(connect);
    if (!nodeId) {
        const err = new Error("node connect requires device.id or client.id.");
        err.code = "INVALID_REQUEST";
        throw err;
    }
    const previous = nodesById.get(nodeId);
    if (previous?.connId && previous.connId !== connId) {
        const err = new Error(`node already connected: ${nodeId}`);
        err.code = "NODE_ALREADY_CONNECTED";
        throw err;
    }
    const registeringConnId = registeringNodes.get(nodeId);
    if (registeringConnId && registeringConnId !== connId) {
        const err = new Error(`node already connecting: ${nodeId}`);
        err.code = "NODE_ALREADY_CONNECTED";
        throw err;
    }
    return nodeId;
}

export function reserveGatewayNodeConnect(connect, connId) {
    const nodeId = validateGatewayNodeConnect(connect, connId);
    registeringNodes.set(nodeId, connId);
    return nodeId;
}

export function releaseGatewayNodeReservation(connId) {
    for (const [nodeId, reservedConnId] of registeringNodes.entries()) {
        if (reservedConnId === connId) registeringNodes.delete(nodeId);
    }
}

function connectedNodeDoc(node) {
    return {
        nodeId: node.nodeId,
        displayName: node.displayName,
        platform: node.platform,
        version: node.version,
        coreVersion: node.coreVersion,
        uiVersion: node.uiVersion,
        clientId: node.clientId,
        clientMode: node.clientMode,
        remoteIp: node.remoteIp,
        deviceFamily: node.deviceFamily,
        modelIdentifier: node.modelIdentifier,
        pathEnv: node.pathEnv,
        caps: node.caps,
        commands: node.commands,
        permissions: node.permissions,
        paired: true,
        connected: true,
        connectedAtMs: node.connectedAtMs,
        lastSeenAtMs: nowMs(),
        source: "pilotclaw",
    };
}

async function ensureNodeDir() {
    await mkdir(NODE_DIR, { recursive: true, mode: 0o700 });
}

async function loadKnownNodes() {
    const stored = await readJsonFile(KNOWN_NODES_FILE, { nodes: [] });
    knownNodes.clear();
    for (const node of Array.isArray(stored?.nodes) ? stored.nodes : []) {
        if (node?.nodeId) knownNodes.set(node.nodeId, node);
    }
}

async function saveKnownNodes() {
    await ensureNodeDir();
    await writeJsonFile(KNOWN_NODES_FILE, {
        updatedAt: new Date().toISOString(),
        nodes: [...knownNodes.values()].sort((a, b) => String(a.displayName || a.nodeId).localeCompare(String(b.displayName || b.nodeId))),
    }, { mode: 0o600 });
}

export async function initializeGatewayNodes() {
    await ensureNodeDir();
    await loadKnownNodes();
}

export async function registerGatewayNode({ connId, connect, remoteIp, sendEvent }) {
    const nodeId = validateGatewayNodeConnect(connect, connId);
    const client = connect?.client || {};
    const node = {
        nodeId,
        connId,
        sendEvent,
        clientId: client.id,
        clientMode: client.mode,
        displayName: client.displayName || client.name || nodeId,
        platform: client.platform || process.platform,
        version: client.version,
        coreVersion: connect.coreVersion,
        uiVersion: connect.uiVersion,
        deviceFamily: client.deviceFamily,
        modelIdentifier: client.modelIdentifier,
        remoteIp,
        caps: Array.isArray(connect?.caps) ? connect.caps : [],
        commands: Array.isArray(connect?.commands) ? connect.commands : [],
        permissions: connect?.permissions && typeof connect.permissions === "object" ? connect.permissions : undefined,
        pathEnv: typeof connect?.pathEnv === "string" ? connect.pathEnv : undefined,
        connectedAtMs: nowMs(),
    };
    const doc = connectedNodeDoc(node);
    const previousKnown = knownNodes.get(nodeId);
    knownNodes.set(nodeId, doc);
    try {
        await saveKnownNodes();
    } catch (err) {
        if (previousKnown) knownNodes.set(nodeId, previousKnown);
        else knownNodes.delete(nodeId);
        throw err;
    }
    nodesById.set(nodeId, node);
    nodesByConn.set(connId, nodeId);
    registeringNodes.delete(nodeId);
    return doc;
}

export async function unregisterGatewayNode(connId) {
    releaseGatewayNodeReservation(connId);
    const nodeId = nodesByConn.get(connId);
    if (!nodeId) return null;
    nodesByConn.delete(connId);
    nodesById.delete(nodeId);
    const known = knownNodes.get(nodeId);
    if (known) {
        knownNodes.set(nodeId, { ...known, connected: false, disconnectedAtMs: nowMs(), lastSeenAtMs: nowMs() });
        await saveKnownNodes();
    }
    for (const [id, pending] of pendingInvokes.entries()) {
        if (pending.nodeId !== nodeId) continue;
        clearTimeout(pending.timer);
        pendingInvokes.delete(id);
        pending.resolve({ ok: false, error: { code: "UNAVAILABLE", message: `node disconnected (${pending.command})` } });
    }
    return nodeId;
}

export function listGatewayNodes() {
    const merged = new Map(knownNodes);
    for (const node of nodesById.values()) merged.set(node.nodeId, connectedNodeDoc(node));
    return [...merged.values()].sort((a, b) => String(a.displayName || a.nodeId).localeCompare(String(b.displayName || b.nodeId)));
}

export function getGatewayNode(nodeId) {
    const connected = nodesById.get(nodeId);
    if (connected) return connectedNodeDoc(connected);
    return knownNodes.get(nodeId) || null;
}

export function findGatewayNode(ref) {
    const value = normalize(ref);
    if (!value) return null;
    const lower = value.toLowerCase();
    const nodes = listGatewayNodes();
    const exact = nodes.find((node) => [node.nodeId, node.id, node.displayName, node.name, node.remoteIp, node.ip]
        .filter(Boolean)
        .map(String)
        .some((candidate) => candidate === value || candidate.toLowerCase() === lower));
    if (exact) return exact;
    return nodes.find((node) => String(node.nodeId || "").startsWith(value)) || null;
}

function liveGatewayNode(ref) {
    const value = normalize(ref);
    if (!value) return null;
    if (nodesById.has(value)) return nodesById.get(value);
    const lower = value.toLowerCase();
    return [...nodesById.values()].find((node) => {
        const candidates = [node.nodeId, node.clientId, node.displayName, node.remoteIp].filter(Boolean).map(String);
        return candidates.some((candidate) => candidate === value || candidate.toLowerCase() === lower || candidate.startsWith(value));
    }) || null;
}

export async function invokeGatewayNode({ nodeId, command, params, timeoutMs = DEFAULT_INVOKE_TIMEOUT_MS, idempotencyKey }) {
    const node = liveGatewayNode(nodeId);
    if (!node) return { ok: false, error: { code: "UNAVAILABLE", message: "node not connected", details: { code: "NOT_CONNECTED" } } };
    const requestId = randomUUID();
    const payload = {
        id: requestId,
        nodeId,
        command,
        paramsJSON: params === undefined ? null : JSON.stringify(params),
        timeoutMs,
        idempotencyKey,
    };
    const sent = node.sendEvent("node.invoke.request", payload);
    if (!sent) return { ok: false, error: { code: "UNAVAILABLE", message: "failed to send invoke to node" } };
    return await new Promise((resolve) => {
        const timer = setTimeout(() => {
            pendingInvokes.delete(requestId);
            resolve({ ok: false, error: { code: "TIMEOUT", message: "node invoke timed out" } });
        }, Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_INVOKE_TIMEOUT_MS);
        pendingInvokes.set(requestId, { nodeId, command, resolve, timer });
    });
}

export function handleGatewayNodeInvokeResult(params = {}, connId = null) {
    const id = normalize(params.id);
    const nodeId = normalize(params.nodeId);
    if (!id || !nodeId) return { ok: false, error: { code: "INVALID_REQUEST", message: "node.invoke.result requires id and nodeId." } };
    if (connId && nodesByConn.get(connId) !== nodeId) return { ok: false, error: { code: "INVALID_REQUEST", message: "nodeId mismatch." } };
    const pending = pendingInvokes.get(id);
    if (!pending) return { ok: true, ignored: true };
    if (pending.nodeId !== nodeId) return { ok: false, error: { code: "INVALID_REQUEST", message: "nodeId mismatch." } };
    clearTimeout(pending.timer);
    pendingInvokes.delete(id);
    pending.resolve({
        ok: params.ok === true,
        payload: params.payload,
        payloadJSON: typeof params.payloadJSON === "string" ? params.payloadJSON : null,
        error: params.error || null,
    });
    return { ok: true };
}

export function pullGatewayNodeActions(connId) {
    const nodeId = nodesByConn.get(connId);
    if (!nodeId) return { ok: false, error: { code: "INVALID_REQUEST", message: "nodeId required." } };
    const actions = pendingActionsByNode.get(nodeId) || [];
    return { ok: true, nodeId, actions };
}

export function enqueueGatewayNodeAction(params = {}) {
    const nodeId = normalize(params.nodeId);
    const command = normalize(params.command);
    if (!nodeId || !command) return { ok: false, error: { code: "INVALID_REQUEST", message: "nodeId and command required." } };
    const action = {
        id: normalize(params.id) || randomUUID(),
        command,
        paramsJSON: typeof params.paramsJSON === "string" ? params.paramsJSON : params.params === undefined ? null : JSON.stringify(params.params),
        enqueuedAtMs: nowMs(),
        idempotencyKey: normalize(params.idempotencyKey) || null,
    };
    const actions = pendingActionsByNode.get(nodeId) || [];
    actions.push(action);
    while (actions.length > MAX_PENDING_ACTIONS_PER_NODE) actions.shift();
    pendingActionsByNode.set(nodeId, actions);
    return { ok: true, nodeId, action, queued: actions.length };
}

export function drainGatewayNodeActions(params = {}) {
    const nodeId = normalize(params.nodeId);
    if (!nodeId) return { ok: false, error: { code: "INVALID_REQUEST", message: "nodeId required." } };
    const actions = pendingActionsByNode.get(nodeId) || [];
    pendingActionsByNode.delete(nodeId);
    return { ok: true, nodeId, actions };
}

export function drainGatewayNodeActionsForConn(connId) {
    const nodeId = nodesByConn.get(connId);
    if (!nodeId) return { ok: false, error: { code: "INVALID_REQUEST", message: "nodeId required." } };
    return drainGatewayNodeActions({ nodeId });
}

export function ackGatewayNodeActions(connId, ids = []) {
    const nodeId = nodesByConn.get(connId);
    if (!nodeId) return { ok: false, error: { code: "INVALID_REQUEST", message: "nodeId required." } };
    const ackIds = new Set((Array.isArray(ids) ? ids : []).map(normalize).filter(Boolean));
    const remaining = (pendingActionsByNode.get(nodeId) || []).filter((action) => !ackIds.has(action.id));
    pendingActionsByNode.set(nodeId, remaining);
    return { ok: true, nodeId, ackedIds: [...ackIds], remainingCount: remaining.length };
}
