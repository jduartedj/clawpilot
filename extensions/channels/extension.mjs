// PilotClaw CLI — channels extension
// Native multi-channel messaging. Supports Telegram, Discord, Slack directly.
// Zero external dependencies — pure Node.js fetch() calls.
import { joinSession } from "@github/copilot-sdk/extension";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const CONFIG_DIR = join(homedir(), ".pilotclaw", "channels");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

async function ensureDir(dir) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
}

async function loadConfig() {
    try {
        return JSON.parse(await readFile(CONFIG_FILE, "utf-8"));
    } catch {
        return { channels: {}, state: {} };
    }
}

async function saveConfig(config) {
    await ensureDir(CONFIG_DIR);
    const { chmod } = await import("node:fs/promises");
    await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
    try { await chmod(CONFIG_FILE, 0o600); } catch { /* ok */ }
    try { await chmod(CONFIG_DIR, 0o700); } catch { /* ok */ }
}

// --- Telegram ---

async function telegramSend(token, chatId, message, opts = {}) {
    const body = {
        chat_id: chatId,
        text: message,
        parse_mode: "Markdown",
    };
    if (opts.silent) body.disable_notification = true;
    if (opts.replyTo) body.reply_to_message_id = opts.replyTo;

    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.description || "Telegram send failed");
    return data.result;
}

async function telegramRead(token, chatId, limit = 10, config = null) {
    // Use offset to avoid returning same messages repeatedly
    const offset = config?.state?.telegramOffset || 0;
    const url = `https://api.telegram.org/bot${token}/getUpdates?limit=${limit}&allowed_updates=["message"]${offset ? `&offset=${offset}` : ""}`;
    const res = await fetch(url);
    const data = await res.json();
    if (!data.ok) throw new Error(data.description || "Telegram read failed");

    // Advance offset over ALL updates (not just filtered ones) to acknowledge them
    let maxId = offset;
    for (const u of data.result) {
        if (u.update_id >= maxId) maxId = u.update_id + 1;
    }

    const messages = data.result
        .filter((u) => u.message && (!chatId || String(u.message.chat.id) === String(chatId)))
        .map((u) => ({
            id: u.message.message_id,
            from: u.message.from?.first_name || u.message.from?.username || "unknown",
            chat: u.message.chat.title || u.message.chat.id,
            text: u.message.text || "(media)",
            date: new Date(u.message.date * 1000).toISOString(),
        }));

    // Persist offset
    if (config && maxId > offset) {
        if (!config.state) config.state = {};
        config.state.telegramOffset = maxId;
        await saveConfig(config);
    }

    return messages;
}

async function telegramGetMe(token) {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = await res.json();
    if (!data.ok) throw new Error(data.description || "getMe failed");
    return data.result;
}

// --- Discord ---

async function discordSend(token, channelId, message) {
    const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
        method: "POST",
        headers: {
            Authorization: `Bot ${token}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: message }),
    });
    if (!res.ok) {
        const err = await res.text();
        throw new Error(`Discord ${res.status}: ${err}`);
    }
    return await res.json();
}

async function discordRead(token, channelId, limit = 10) {
    const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages?limit=${limit}`, {
        headers: { Authorization: `Bot ${token}` },
    });
    if (!res.ok) {
        const err = await res.text();
        throw new Error(`Discord ${res.status}: ${err}`);
    }
    const messages = await res.json();
    return messages.map((m) => ({
        id: m.id,
        from: m.author?.username || "unknown",
        text: m.content,
        date: m.timestamp,
    }));
}

// --- Slack ---

async function slackSend(token, channel, message) {
    if (token.startsWith("https://hooks.slack.com/")) {
        const res = await fetch(token, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: message, channel }),
        });
        if (!res.ok) throw new Error(`Slack webhook ${res.status}`);
        return { ok: true };
    }

    const res = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ channel, text: message }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Slack send failed");
    return data;
}

async function slackRead(token, channel, limit = 10) {
    const res = await fetch(`https://slack.com/api/conversations.history?channel=${channel}&limit=${limit}`, {
        headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Slack read failed");
    return data.messages.map((m) => ({
        id: m.ts,
        from: m.user || "bot",
        text: m.text,
        date: new Date(parseFloat(m.ts) * 1000).toISOString(),
    }));
}

// --- Channel router ---

const SUPPORTED_CHANNELS = new Set(["telegram", "discord", "slack"]);

async function resolveChannel(config, channel) {
    return config.channels?.[channel] || null;
}

const session = await joinSession({
    tools: [
        {
            name: "pilotclaw_send_message",
            description:
                "Send a message to a chat channel (Discord, Telegram, Slack). " +
                "Requires channel to be configured via pilotclaw_channel_setup. " +
                "Target format depends on channel: chat_id for Telegram, channel_id for Discord, channel name for Slack.",
            parameters: {
                type: "object",
                properties: {
                    channel: {
                        type: "string",
                        description: "Channel to send via: telegram, discord, slack",
                    },
                    target: {
                        type: "string",
                        description: "Recipient: Telegram chat_id, Discord channel_id, or Slack channel name/id",
                    },
                    message: {
                        type: "string",
                        description: "Message text to send",
                    },
                },
                required: ["channel", "target", "message"],
            },
            handler: async (args) => {
                const channel = args.channel.toLowerCase();
                if (!SUPPORTED_CHANNELS.has(channel)) {
                    return { textResultForLlm: `Channel '${channel}' not supported. Supported: telegram, discord, slack.`, resultType: "failure" };
                }

                const config = await loadConfig();
                const ch = await resolveChannel(config, channel);
                if (!ch || !ch.token) {
                    return { textResultForLlm: `Channel '${channel}' not configured. Use pilotclaw_channel_setup first.`, resultType: "failure" };
                }

                try {
                    switch (channel) {
                        case "telegram": {
                            const result = await telegramSend(ch.token, args.target, args.message);
                            return `Sent via Telegram (msg_id: ${result.message_id})`;
                        }
                        case "discord": {
                            const result = await discordSend(ch.token, args.target, args.message);
                            return `Sent via Discord (msg_id: ${result.id})`;
                        }
                        case "slack": {
                            await slackSend(ch.token, args.target, args.message);
                            return `Sent via Slack`;
                        }
                    }
                } catch (e) {
                    return { textResultForLlm: `Send failed: ${e.message}`, resultType: "failure" };
                }
            },
        },
        {
            name: "pilotclaw_read_messages",
            description: "Read recent messages from a chat channel.",
            parameters: {
                type: "object",
                properties: {
                    channel: { type: "string", description: "Channel: telegram, discord, slack" },
                    target: { type: "string", description: "Conversation/channel to read from (optional for Telegram, required for Discord/Slack)" },
                    count: { type: "number", description: "Number of messages to retrieve (default: 10)" },
                },
                required: ["channel"],
            },
            handler: async (args) => {
                const channel = args.channel.toLowerCase();
                if (!SUPPORTED_CHANNELS.has(channel)) {
                    return { textResultForLlm: `Channel '${channel}' not supported. Supported: telegram, discord, slack.`, resultType: "failure" };
                }

                const config = await loadConfig();
                const ch = await resolveChannel(config, channel);
                if (!ch || !ch.token) {
                    return { textResultForLlm: `Channel '${channel}' not configured. Use pilotclaw_channel_setup first.`, resultType: "failure" };
                }

                const count = args.count || 10;

                try {
                    let messages;
                    switch (channel) {
                        case "telegram":
                            messages = await telegramRead(ch.token, args.target, count, config);
                            break;
                        case "discord":
                            if (!args.target) return { textResultForLlm: "Discord requires a channel_id as target.", resultType: "failure" };
                            messages = await discordRead(ch.token, args.target, count);
                            break;
                        case "slack":
                            if (!args.target) return { textResultForLlm: "Slack requires a channel ID as target.", resultType: "failure" };
                            messages = await slackRead(ch.token, args.target, count);
                            break;
                    }
                    if (!messages || messages.length === 0) return "(no messages)";
                    return messages
                        .map((m) => `[${m.date}] ${m.from}: ${m.text}`)
                        .join("\n");
                } catch (e) {
                    return { textResultForLlm: `Read failed: ${e.message}`, resultType: "failure" };
                }
            },
        },
        {
            name: "pilotclaw_channel_status",
            description: "Show status of all configured messaging channels.",
            parameters: { type: "object", properties: {} },
            handler: async () => {
                const config = await loadConfig();
                const channels = Object.entries(config.channels || {});

                if (channels.length === 0) {
                    return "No channels configured.\n\nSupported channels: telegram, discord, slack\nUse pilotclaw_channel_setup to add one.";
                }

                let output = "## Configured Channels\n";
                for (const [name, ch] of channels) {
                    let status = "configured";
                    if (name === "telegram" && ch.token) {
                        try {
                            const me = await telegramGetMe(ch.token);
                            status = `connected (@${me.username})`;
                        } catch {
                            status = "token invalid";
                        }
                    } else if (name === "discord" && ch.token) {
                        try {
                            const res = await fetch("https://discord.com/api/v10/users/@me", {
                                headers: { Authorization: `Bot ${ch.token}` },
                            });
                            if (res.ok) {
                                const me = await res.json();
                                status = `connected (${me.username})`;
                            } else {
                                status = "token invalid";
                            }
                        } catch {
                            status = "unreachable";
                        }
                    }
                    output += `• ${name}: ${status}${ch.note ? ` — ${ch.note}` : ""}\n`;
                }

                return output;
            },
        },
        {
            name: "pilotclaw_channel_setup",
            description:
                "Configure a messaging channel. Stores credentials in ~/.pilotclaw/channels/config.json.\n" +
                "Telegram: provide bot token (get from @BotFather).\n" +
                "Discord: provide bot token (from Discord Developer Portal).\n" +
                "Slack: provide bot token or webhook URL.",
            parameters: {
                type: "object",
                properties: {
                    channel: {
                        type: "string",
                        description: "Channel name: telegram, discord, slack",
                    },
                    token: {
                        type: "string",
                        description: "Bot token, API key, or webhook URL for the channel",
                    },
                    note: {
                        type: "string",
                        description: "Optional note (e.g., 'personal bot', 'work server')",
                    },
                },
                required: ["channel", "token"],
            },
            handler: async (args) => {
                const channel = args.channel.toLowerCase().replace(/[^a-z]/g, "");

                if (!SUPPORTED_CHANNELS.has(channel)) {
                    return { textResultForLlm: `Channel '${channel}' not supported. Supported: telegram, discord, slack.`, resultType: "failure" };
                }

                const config = await loadConfig();

                if (channel === "telegram") {
                    try {
                        const me = await telegramGetMe(args.token);
                        config.channels[channel] = {
                            token: args.token,
                            note: args.note || `@${me.username}`,
                            botUsername: me.username,
                            configuredAt: new Date().toISOString(),
                        };
                        await saveConfig(config);
                        return `Telegram configured! Bot: @${me.username} (${me.first_name})\n\nTo send: pilotclaw_send_message(channel: "telegram", target: "<chat_id>", message: "hello")`;
                    } catch (e) {
                        return { textResultForLlm: `Invalid Telegram token: ${e.message}`, resultType: "failure" };
                    }
                }

                if (channel === "discord") {
                    try {
                        const res = await fetch("https://discord.com/api/v10/users/@me", {
                            headers: { Authorization: `Bot ${args.token}` },
                        });
                        if (!res.ok) throw new Error(`HTTP ${res.status}`);
                        const me = await res.json();
                        config.channels[channel] = {
                            token: args.token,
                            note: args.note || `${me.username}`,
                            botUsername: me.username,
                            configuredAt: new Date().toISOString(),
                        };
                        await saveConfig(config);
                        return `Discord configured! Bot: ${me.username}\n\nTo send: pilotclaw_send_message(channel: "discord", target: "<channel_id>", message: "hello")`;
                    } catch (e) {
                        return { textResultForLlm: `Invalid Discord token: ${e.message}`, resultType: "failure" };
                    }
                }

                if (channel === "slack") {
                    config.channels[channel] = {
                        token: args.token,
                        note: args.note || (args.token.startsWith("https://") ? "webhook" : "bot token"),
                        configuredAt: new Date().toISOString(),
                    };
                    await saveConfig(config);
                    return `Slack configured!\n\nTo send: pilotclaw_send_message(channel: "slack", target: "<channel>", message: "hello")`;
                }
            },
        },
        {
            name: "pilotclaw_channel_remove",
            description: "Remove a configured channel.",
            parameters: {
                type: "object",
                properties: {
                    channel: { type: "string", description: "Channel name to remove" },
                },
                required: ["channel"],
            },
            handler: async (args) => {
                const config = await loadConfig();
                const ch = args.channel.toLowerCase();
                if (!config.channels[ch]) return `Channel '${ch}' not found.`;
                delete config.channels[ch];
                await saveConfig(config);
                return `Channel '${ch}' removed.`;
            },
        },
    ],
});
