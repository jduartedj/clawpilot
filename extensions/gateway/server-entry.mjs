#!/usr/bin/env node
import { appendFile } from "node:fs/promises";
import { ensureDir } from "../_lib/fs.mjs";
import { GATEWAY_LOGS_DIR } from "../_lib/platform.mjs";
import { startGatewayServer } from "../_lib/gateway-server.mjs";

await ensureDir(GATEWAY_LOGS_DIR);

const { runtime } = await startGatewayServer();
await appendFile(`${GATEWAY_LOGS_DIR}/server.log`, `[${new Date().toISOString()}] Gateway listening on http://${runtime.host}:${runtime.port}\n`);
console.log(`PilotClaw gateway listening on http://${runtime.host}:${runtime.port}`);

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
