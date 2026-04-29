// PilotClaw CLI — fallback extension
// Automatic retry on model errors with configurable retry count.
import { joinSession } from "@github/copilot-sdk/extension";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const CONFIG_FILE = join(homedir(), ".pilotclaw", "fallback.json");

const DEFAULT_CHAINS = {
    default: ["claude-sonnet-4", "gpt-5.4", "claude-haiku-4.5"],
};

async function loadConfig() {
    try {
        return JSON.parse(await readFile(CONFIG_FILE, "utf-8"));
    } catch {
        return { chains: DEFAULT_CHAINS, maxRetries: 2, enabled: true };
    }
}

let retryCount = 0;
let lastErrorTime = 0;

const session = await joinSession({
    hooks: {
        onErrorOccurred: async (input) => {
            if (!input.recoverable) return;
            if (input.errorContext !== "model_call") return;

            const config = await loadConfig();
            if (!config.enabled) return;

            const now = Date.now();
            // Reset retry count if last error was more than 5 min ago
            if (now - lastErrorTime > 300000) retryCount = 0;
            lastErrorTime = now;

            if (retryCount >= (config.maxRetries || 2)) {
                retryCount = 0;
                return {
                    errorHandling: "abort",
                    userNotification: `[PilotClaw] Model failed after ${config.maxRetries || 2} retries. Error: ${input.error}`,
                };
            }

            retryCount++;
            return {
                errorHandling: "retry",
                retryCount: 1,
            };
        },
    },
    tools: [
        {
            name: "pilotclaw_fallback_status",
            description: "Show current fallback chain configuration and retry status.",
            parameters: { type: "object", properties: {} },
            handler: async () => {
                const config = await loadConfig();
                return JSON.stringify({
                    enabled: config.enabled,
                    chains: config.chains,
                    maxRetries: config.maxRetries || 2,
                    currentRetryCount: retryCount,
                }, null, 2);
            },
        },
    ],
});
