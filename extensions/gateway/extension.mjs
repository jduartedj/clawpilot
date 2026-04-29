// PilotClaw CLI — OpenClaw-compatible gateway extension
import { joinSession } from "@github/copilot-sdk/extension";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { readJsonFile, tailFile } from "../_lib/fs.mjs";
import { ensureGatewayDir } from "../_lib/gateway-session.mjs";
import { HOME, IS_MACOS, IS_WINDOWS, GATEWAY_LOGS_DIR, GATEWAY_RUNTIME_DIR } from "../_lib/platform.mjs";
import { activeStatus, daemonReload, removeUserUnit, stopDisable, writeUserUnit, enableNow } from "../_lib/systemd.mjs";
import { createOnLogonTask, deleteTask, endTask, queryTask, runTask } from "../_lib/taskscheduler.mjs";
import { isProcessRunning, killProcessTree } from "../_lib/spawn-backend.mjs";

const GATEWAY_UNIT = "pilotclaw-gateway";
const WINDOWS_GATEWAY_TASK = "PilotClaw-gateway";
const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = resolve(EXTENSION_DIR, "server-entry.mjs");

function quotePowerShellLiteral(value) {
    return `'${String(value).replace(/'/g, "''")}'`;
}

function quoteWin(value) {
    return `"${String(value).replace(/"/g, '\\"')}"`;
}

function buildGatewayService() {
    return `[Unit]
Description=PilotClaw OpenClaw-compatible gateway

[Service]
Type=simple
ExecStart=${process.execPath} ${SERVER_ENTRY}
Environment=HOME=${HOME}
Environment=PATH=${process.env.PATH}
Restart=on-failure
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
`;
}

function buildWindowsGatewayCommand() {
    const logFile = join(GATEWAY_LOGS_DIR, "server.log");
    const command = [
        "&",
        quotePowerShellLiteral(process.execPath),
        quotePowerShellLiteral(SERVER_ENTRY),
        "*>",
        quotePowerShellLiteral(logFile),
    ].join(" ");
    return [
        "powershell.exe",
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-Command", quoteWin(command),
    ].join(" ");
}

async function runtime() {
    return await readJsonFile(`${GATEWAY_RUNTIME_DIR}/runtime.json`, null);
}

function formatRuntime(doc) {
    if (!doc) return "Runtime: not found";
    const running = doc.pid ? isProcessRunning(doc.pid) : false;
    return [
        `Runtime: ${running ? "running" : "stale/stopped"}`,
        `URL: http://${doc.host}:${doc.port}`,
        `PID: ${doc.pid || "-"}`,
        `Started: ${doc.startedAt || "-"}`,
        `Token: stored in ${GATEWAY_RUNTIME_DIR}/runtime.json`,
    ].join("\n");
}

const session = await joinSession({
    tools: [
        {
            name: "pilotclaw_gateway_start",
            description: "Start the OpenClaw-compatible PilotClaw gateway on localhost.",
            parameters: { type: "object", properties: {} },
            handler: async () => {
                if (IS_MACOS) {
                    return { textResultForLlm: "Gateway lifecycle is parked on macOS. Run server-entry.mjs manually if needed.", resultType: "failure" };
                }
                await ensureGatewayDir(GATEWAY_LOGS_DIR);
                await ensureGatewayDir(GATEWAY_RUNTIME_DIR);
                if (IS_WINDOWS) {
                    const created = await createOnLogonTask({ name: WINDOWS_GATEWAY_TASK, command: buildWindowsGatewayCommand() });
                    if (!created.ok) return { textResultForLlm: created.stderr || created.stdout, resultType: "failure" };
                    const started = await runTask(WINDOWS_GATEWAY_TASK);
                    if (!started.ok) return { textResultForLlm: started.stderr || started.stdout, resultType: "failure" };
                    return `Gateway task installed and started.\nTask: ${WINDOWS_GATEWAY_TASK}\n${formatRuntime(await runtime())}`;
                }
                await writeUserUnit(`${GATEWAY_UNIT}.service`, buildGatewayService());
                await daemonReload();
                const result = await enableNow(`${GATEWAY_UNIT}.service`);
                if (!result.ok) return { textResultForLlm: result.stderr || result.stdout, resultType: "failure" };
                return `Gateway service installed and started.\nUnit: ${GATEWAY_UNIT}.service\n${formatRuntime(await runtime())}`;
            },
        },
        {
            name: "pilotclaw_gateway_status",
            description: "Show PilotClaw gateway status, URL, token, and platform service/task state.",
            parameters: { type: "object", properties: {} },
            handler: async () => {
                const platform = IS_WINDOWS
                    ? await queryTask(WINDOWS_GATEWAY_TASK)
                    : await activeStatus(`${GATEWAY_UNIT}.service`);
                return `${formatRuntime(await runtime())}\n\nPlatform status:\n${platform.stdout || platform.stderr || "not installed"}`;
            },
        },
        {
            name: "pilotclaw_gateway_stop",
            description: "Stop and disable the PilotClaw compatibility gateway.",
            parameters: { type: "object", properties: {} },
            handler: async () => {
                const doc = await runtime();
                if (doc?.pid && isProcessRunning(doc.pid)) await killProcessTree(doc.pid);
                if (IS_WINDOWS) {
                    await endTask(WINDOWS_GATEWAY_TASK);
                    await deleteTask(WINDOWS_GATEWAY_TASK);
                    return "Gateway task stopped and removed.";
                }
                await stopDisable(`${GATEWAY_UNIT}.service`);
                await removeUserUnit(`${GATEWAY_UNIT}.service`);
                await daemonReload();
                return "Gateway service stopped and removed.";
            },
        },
        {
            name: "pilotclaw_gateway_url",
            description: "Return the gateway URL and bearer token for clients.",
            parameters: { type: "object", properties: {} },
            handler: async () => formatRuntime(await runtime()),
        },
        {
            name: "pilotclaw_gateway_logs",
            description: "Show recent PilotClaw gateway logs.",
            parameters: {
                type: "object",
                properties: {
                    lines: { type: "number", description: "Number of lines to show (default 100)" },
                },
            },
            handler: async (args) => await tailFile(join(GATEWAY_LOGS_DIR, "server.log"), args.lines || 100),
        },
    ],
});

await session;
