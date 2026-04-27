// Clawpilot CLI — channels extension
// Multi-channel messaging (WhatsApp, Discord, Telegram, etc.)
// Wraps OpenClaw CLI for channel operations when available, falls back to direct APIs.
import { joinSession } from "@github/copilot-sdk/extension";
import { execFile } from "node:child_process";

function exec(cmd, args, opts = {}) {
    return new Promise((resolve) => {
        execFile(cmd, args, { timeout: 30000, ...opts }, (err, stdout, stderr) => {
            resolve({ ok: !err, stdout: stdout?.trim() || "", stderr: stderr?.trim() || "" });
        });
    });
}

async function hasOpenClaw() {
    const r = await exec("which", ["openclaw"]);
    return r.ok;
}

async function openclawSend(channel, target, message) {
    const args = ["message", "send", "--channel", channel, "--target", target, "--message", message, "--json"];
    return exec("openclaw", args);
}

async function openclawRead(channel, target, count) {
    const args = ["message", "read", "--channel", channel];
    if (target) args.push("--target", target);
    if (count) args.push("--count", String(count));
    args.push("--json");
    return exec("openclaw", args);
}

async function openclawStatus() {
    return exec("openclaw", ["status", "--json"]);
}

const session = await joinSession({
    tools: [
        {
            name: "clawpilot_send_message",
            description:
                "Send a message to a chat channel (WhatsApp, Discord, Telegram, Slack, Signal, etc.). " +
                "Requires OpenClaw CLI with configured channels. " +
                "Target format depends on channel: phone number for WhatsApp/Signal, username/channel for Discord/Telegram.",
            parameters: {
                type: "object",
                properties: {
                    channel: {
                        type: "string",
                        description: "Channel to send via: whatsapp, discord, telegram, signal, slack, etc.",
                    },
                    target: {
                        type: "string",
                        description: "Recipient: phone number (E.164), channel name, or user ID depending on platform",
                    },
                    message: {
                        type: "string",
                        description: "Message text to send",
                    },
                },
                required: ["channel", "target", "message"],
            },
            handler: async (args) => {
                if (!(await hasOpenClaw())) {
                    return { textResultForLlm: "OpenClaw CLI not found. Install it for channel support, or configure direct API access.", resultType: "failure" };
                }

                const result = await openclawSend(args.channel, args.target, args.message);
                if (!result.ok) {
                    return { textResultForLlm: `Send failed: ${result.stderr || result.stdout}`, resultType: "failure" };
                }
                return `Message sent via ${args.channel} to ${args.target}.${result.stdout ? "\n" + result.stdout : ""}`;
            },
        },
        {
            name: "clawpilot_read_messages",
            description: "Read recent messages from a chat channel.",
            parameters: {
                type: "object",
                properties: {
                    channel: { type: "string", description: "Channel: whatsapp, discord, telegram, etc." },
                    target: { type: "string", description: "Conversation/channel to read from (optional)" },
                    count: { type: "number", description: "Number of messages to retrieve (default: 10)" },
                },
                required: ["channel"],
            },
            handler: async (args) => {
                if (!(await hasOpenClaw())) {
                    return { textResultForLlm: "OpenClaw CLI not found.", resultType: "failure" };
                }
                const result = await openclawRead(args.channel, args.target, args.count || 10);
                if (!result.ok) {
                    return { textResultForLlm: `Read failed: ${result.stderr || result.stdout}`, resultType: "failure" };
                }
                return result.stdout || "(no messages)";
            },
        },
        {
            name: "clawpilot_channel_status",
            description: "Show status of all configured messaging channels.",
            parameters: { type: "object", properties: {} },
            handler: async () => {
                if (!(await hasOpenClaw())) {
                    return "OpenClaw CLI not found. Channel status unavailable.\n\nTo use channels, install OpenClaw and configure channels via `openclaw channels login`.";
                }
                const result = await openclawStatus();
                return result.stdout || result.stderr || "Unable to fetch channel status.";
            },
        },
    ],
});
