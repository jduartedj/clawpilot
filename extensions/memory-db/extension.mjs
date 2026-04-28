// Clawpilot CLI — memory-db extension
// SQLite-backed memory with FTS5 full-text search.
// Automatically captures full conversation history (user messages, agent responses,
// tool calls) incrementally to a JSONL file, then finalizes to DB on session end.
// History survives unexpected shutdowns via the JSONL buffer.
import { joinSession } from "@github/copilot-sdk/extension";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, unlink, appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const DB_PATH = join(homedir(), ".clawpilot", "memory.db");
const MEMORY_DIR = join(homedir(), "clawd", "memory");
const HISTORY_DIR = join(homedir(), ".clawpilot", "history");
const ROTATE_DAYS = 7;

// Current session's JSONL buffer file — written incrementally, survives crashes
const SESSION_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const HISTORY_FILE = join(HISTORY_DIR, `${SESSION_ID}.jsonl`);

const sessionMeta = {
    startedAt: new Date().toISOString(),
    cwd: process.cwd(),
    source: null,
    turnCount: 0,
    toolCount: 0,
    premiumRequests: 0,
    codeChanges: 0,
};

async function ensureDir(dir) {
    await mkdir(dir, { recursive: true });
}

// Append a line to the JSONL history file (crash-safe: each write is atomic-ish)
async function appendHistory(entry) {
    try {
        await ensureDir(HISTORY_DIR);
        await appendFile(HISTORY_FILE, JSON.stringify(entry) + "\n");
    } catch { /* best effort */ }
}

function sqlite(sql, dbPath = DB_PATH) {
    return new Promise((resolve) => {
        execFile("sqlite3", [dbPath, sql], { timeout: 15000 }, (err, stdout, stderr) => {
            resolve({ ok: !err, stdout: stdout?.trim() || "", stderr: stderr?.trim() || "" });
        });
    });
}

function sqliteExec(args) {
    return new Promise((resolve) => {
        execFile("sqlite3", args, { timeout: 15000 }, (err, stdout, stderr) => {
            resolve({ ok: !err, stdout: stdout?.trim() || "", stderr: stderr?.trim() || "" });
        });
    });
}

async function ensureSchema() {
    await ensureDir(join(homedir(), ".clawpilot"));
    await sqlite(`
        CREATE TABLE IF NOT EXISTS memories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            date TEXT NOT NULL,
            source TEXT NOT NULL,
            content TEXT NOT NULL,
            tags TEXT DEFAULT '',
            created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS sessions_log (
            id TEXT PRIMARY KEY,
            summary TEXT,
            conversation TEXT,
            tool_calls TEXT,
            started_at TEXT,
            ended_at TEXT,
            cwd TEXT,
            reason TEXT,
            turn_count INTEGER DEFAULT 0,
            tool_count INTEGER DEFAULT 0,
            premium_requests INTEGER DEFAULT 0,
            code_changes INTEGER DEFAULT 0
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
            content, source, date, tags,
            content='memories',
            content_rowid='id'
        );
        CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
            INSERT INTO memory_fts(rowid, content, source, date, tags)
            VALUES (new.id, new.content, new.source, new.date, new.tags);
        END;
        CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
            INSERT INTO memory_fts(memory_fts, rowid, content, source, date, tags)
            VALUES ('delete', old.id, old.content, old.source, old.date, old.tags);
        END;
    `);
}

// Read a JSONL history file and build transcript + tool summary
async function parseHistoryFile(filePath) {
    try {
        const raw = await readFile(filePath, "utf-8");
        const lines = raw.trim().split("\n").filter(Boolean);
        const turns = [];
        const tools = [];
        let meta = {};

        for (const line of lines) {
            try {
                const entry = JSON.parse(line);
                if (entry.type === "turn") turns.push(entry);
                else if (entry.type === "tool") tools.push(entry);
                else if (entry.type === "meta") meta = { ...meta, ...entry };
            } catch { /* skip corrupt lines */ }
        }

        const transcript = turns
            .map((t) => `[${t.ts}] ${t.role}: ${t.content}`)
            .join("\n\n");

        const toolSummary = tools.length > 0
            ? tools.map((t) => `${t.tool}:${t.ok ? "ok" : "fail"}`).join(", ")
            : "";

        const userMessages = turns
            .filter((t) => t.role === "user")
            .map((t) => t.content.slice(0, 200))
            .join(" | ");

        return { transcript, toolSummary, userMessages, turns, tools, meta };
    } catch {
        return null;
    }
}

// Finalize a JSONL history file into the DB
async function finalizeHistory(filePath, reason, finalMessage) {
    const parsed = await parseHistoryFile(filePath);
    if (!parsed || parsed.turns.length === 0) {
        // Nothing to save — clean up the empty file
        try { await unlink(filePath); } catch { /* ok */ }
        return;
    }

    await ensureSchema();
    const escaped = (s) => (s || "").replace(/'/g, "''");
    const date = new Date().toISOString().slice(0, 10);
    const sid = filePath.split("/").pop().replace(".jsonl", "");

    // Save full session
    await sqlite(
        `INSERT OR IGNORE INTO sessions_log (id, summary, conversation, tool_calls, started_at, ended_at, cwd, reason, turn_count, tool_count, premium_requests, code_changes) VALUES (` +
        `'${escaped(sid)}', ` +
        `'${escaped((finalMessage || parsed.userMessages || "").slice(0, 2000))}', ` +
        `'${escaped(parsed.transcript.slice(0, 50000))}', ` +
        `'${escaped(parsed.toolSummary)}', ` +
        `'${escaped(parsed.meta.startedAt || "")}', ` +
        `datetime('now'), ` +
        `'${escaped(parsed.meta.cwd || "")}', ` +
        `'${escaped(reason || "unknown")}', ` +
        `${parsed.turns.length}, ` +
        `${parsed.tools.length}, ` +
        `${parseInt(parsed.meta.premiumRequests, 10) || 0}, ` +
        `${parseInt(parsed.meta.codeChanges, 10) || 0}` +
        `);`
    );

    // Also store as searchable memory
    const summary = `Session (${parsed.turns.length} turns, ${parsed.tools.length} tool calls): ${parsed.userMessages}`;
    await sqlite(
        `INSERT INTO memories (date, source, content, tags) VALUES ('${date}', 'session-auto', '${escaped(summary.slice(0, 5000))}', 'session,auto-capture');`
    );

    // Clean up the JSONL file
    try { await unlink(filePath); } catch { /* ok */ }
}

const session = await joinSession({
    tools: [
        {
            name: "clawpilot_memory_search",
            description: "Search across all archived memories using full-text search. Finds past decisions, events, lessons, and session summaries.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Search query (supports FTS5 syntax: AND, OR, NOT, phrases in quotes)" },
                    limit: { type: "number", description: "Max results (default: 20)" },
                },
                required: ["query"],
            },
            handler: async (args) => {
                await ensureSchema();
                const limit = Math.max(1, Math.min(100, parseInt(args.limit, 10) || 20));
                const escaped = args.query.replace(/'/g, "''");
                const result = await sqliteExec([
                    "-json",
                    DB_PATH,
                    `SELECT m.id, m.date, m.source, substr(m.content, 1, 500) as content, m.tags FROM memories m JOIN memory_fts f ON m.id = f.rowid WHERE memory_fts MATCH '${escaped}' ORDER BY rank LIMIT ${limit};`,
                ]);
                if (!result.ok || !result.stdout) {
                    if (result.stderr) return `Search error: ${result.stderr}`;
                    return "No results found.";
                }
                return result.stdout;
            },
        },
        {
            name: "clawpilot_memory_rotate",
            description: "Rotate old daily memory files (older than 7 days) into the SQLite database. Active memory files stay untouched.",
            parameters: { type: "object", properties: {} },
            handler: async () => {
                await ensureSchema();
                let entries;
                try {
                    entries = await readdir(MEMORY_DIR);
                } catch {
                    return "Memory directory not found.";
                }

                const cutoff = new Date();
                cutoff.setDate(cutoff.getDate() - ROTATE_DAYS);
                const cutoffStr = cutoff.toISOString().slice(0, 10);

                let rotated = 0;
                for (const f of entries) {
                    const match = f.match(/^(\d{4}-\d{2}-\d{2})(.*)?\.md$/);
                    if (!match) continue;
                    const date = match[1];
                    if (date >= cutoffStr) continue;

                    const filePath = join(MEMORY_DIR, f);
                    try {
                        const content = await readFile(filePath, "utf-8");
                        if (!content.trim()) continue;

                        const escaped = content.replace(/'/g, "''");
                        const escapedFile = f.replace(/'/g, "''");
                        const result = await sqlite(
                            `INSERT INTO memories (date, source, content, tags) VALUES ('${date}', '${escapedFile}', '${escaped}', 'daily-memory');`
                        );
                        if (!result.ok) continue;
                        await unlink(filePath);
                        rotated++;
                    } catch { /* skip on error */ }
                }

                return `Rotated ${rotated} memory file(s) into database. Files newer than ${ROTATE_DAYS} days kept in place.`;
            },
        },
        {
            name: "clawpilot_memory_recent",
            description: "Retrieve recent memories from the database.",
            parameters: {
                type: "object",
                properties: {
                    days: { type: "number", description: "Number of days to look back (default: 30)" },
                    limit: { type: "number", description: "Max results (default: 20)" },
                },
            },
            handler: async (args) => {
                await ensureSchema();
                const days = Math.max(1, Math.min(3650, parseInt(args.days, 10) || 30));
                const limit = Math.max(1, Math.min(100, parseInt(args.limit, 10) || 20));
                const result = await sqliteExec([
                    "-json",
                    DB_PATH,
                    `SELECT id, date, source, substr(content, 1, 300) as preview, tags FROM memories WHERE date >= date('now', '-${days} days') ORDER BY date DESC LIMIT ${limit};`,
                ]);
                if (!result.ok || !result.stdout) return "No recent memories found.";
                return result.stdout;
            },
        },
        {
            name: "clawpilot_memory_store",
            description: "Store a memory or important decision in the database for future reference.",
            parameters: {
                type: "object",
                properties: {
                    content: { type: "string", description: "The memory/decision/event to store" },
                    tags: { type: "string", description: "Comma-separated tags for categorization" },
                    date: { type: "string", description: "Date in YYYY-MM-DD format (default: today)" },
                },
                required: ["content"],
            },
            handler: async (args) => {
                await ensureSchema();
                const date = args.date || new Date().toISOString().slice(0, 10);
                if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
                    return { textResultForLlm: "Date must be YYYY-MM-DD format.", resultType: "failure" };
                }
                const escaped = args.content.replace(/'/g, "''");
                const tags = (args.tags || "manual").replace(/'/g, "''");
                const result = await sqlite(
                    `INSERT INTO memories (date, source, content, tags) VALUES ('${date}', 'manual', '${escaped}', '${tags}');`
                );
                if (!result.ok) {
                    return { textResultForLlm: `Failed to store: ${result.stderr}`, resultType: "failure" };
                }
                return `Memory stored (${date}, tags: ${tags}).`;
            },
        },
    ],
    hooks: {
        onSessionStart: async (input) => {
            sessionMeta.source = input.source;
            sessionMeta.cwd = input.cwd || process.cwd();
            sessionMeta.startedAt = new Date().toISOString();

            // Write initial meta to JSONL (crash safety net)
            await appendHistory({ type: "meta", startedAt: sessionMeta.startedAt, cwd: sessionMeta.cwd, source: input.source });

            // Finalize any orphaned history files from crashed sessions
            try {
                await ensureDir(HISTORY_DIR);
                const files = await readdir(HISTORY_DIR);
                for (const f of files) {
                    if (!f.endsWith(".jsonl") || f === `${SESSION_ID}.jsonl`) continue;
                    await finalizeHistory(join(HISTORY_DIR, f), "crash", null);
                }
            } catch { /* ok */ }
        },
        onSessionEnd: async (input) => {
            // On clean exit, prefer Copilot's own events.jsonl (authoritative, complete)
            // Fall back to our JSONL buffer if events.jsonl is unavailable
            const workspace = session.workspacePath;
            const eventsFile = workspace ? join(workspace, "events.jsonl") : null;

            let transcript = "";
            let toolSummary = "";
            let userMessages = "";
            let turnCount = 0;
            let toolCount = 0;

            if (eventsFile) {
                try {
                    const raw = await readFile(eventsFile, "utf-8");
                    const lines = raw.trim().split("\n").filter(Boolean);
                    const turns = [];
                    const tools = [];

                    for (const line of lines) {
                        try {
                            const ev = JSON.parse(line);
                            if (ev.type === "user.message" && ev.data?.content) {
                                turns.push({ role: "user", content: ev.data.content.slice(0, 5000), ts: ev.timestamp || "" });
                            } else if (ev.type === "assistant.message" && ev.data?.content) {
                                turns.push({ role: "assistant", content: ev.data.content.slice(0, 5000), ts: ev.timestamp || "" });
                            } else if (ev.type === "tool.execution_complete") {
                                tools.push({ tool: ev.data?.toolName || "unknown", ok: ev.data?.success ?? true });
                            }
                        } catch { /* skip corrupt lines */ }
                    }

                    transcript = turns.map((t) => `[${t.ts}] ${t.role}: ${t.content}`).join("\n\n");
                    toolSummary = tools.map((t) => `${t.tool}:${t.ok ? "ok" : "fail"}`).join(", ");
                    userMessages = turns.filter((t) => t.role === "user").map((t) => t.content.slice(0, 200)).join(" | ");
                    turnCount = turns.length;
                    toolCount = tools.length;
                } catch {
                    // Fall back to our JSONL buffer
                }
            }

            // If events.jsonl didn't work, use our buffer
            if (turnCount === 0) {
                const parsed = await parseHistoryFile(HISTORY_FILE);
                if (parsed && parsed.turns.length > 0) {
                    transcript = parsed.transcript;
                    toolSummary = parsed.toolSummary;
                    userMessages = parsed.userMessages;
                    turnCount = parsed.turns.length;
                    toolCount = parsed.tools.length;
                }
            }

            // Save to DB
            if (turnCount > 0) {
                try {
                    await ensureSchema();
                    const escaped = (s) => (s || "").replace(/'/g, "''");
                    const date = new Date().toISOString().slice(0, 10);

                    await sqlite(
                        `INSERT OR IGNORE INTO sessions_log (id, summary, conversation, tool_calls, started_at, ended_at, cwd, reason, turn_count, tool_count, premium_requests, code_changes) VALUES (` +
                        `'${escaped(SESSION_ID)}', ` +
                        `'${escaped((input.finalMessage || userMessages || "").slice(0, 2000))}', ` +
                        `'${escaped(transcript.slice(0, 50000))}', ` +
                        `'${escaped(toolSummary)}', ` +
                        `'${escaped(sessionMeta.startedAt)}', ` +
                        `datetime('now'), ` +
                        `'${escaped(sessionMeta.cwd)}', ` +
                        `'${escaped(input.reason)}', ` +
                        `${turnCount}, ${toolCount}, ` +
                        `${sessionMeta.premiumRequests}, ${sessionMeta.codeChanges}` +
                        `);`
                    );

                    // Also store as searchable memory
                    const summary = `Session (${turnCount} turns, ${toolCount} tool calls): ${userMessages}`;
                    await sqlite(
                        `INSERT INTO memories (date, source, content, tags) VALUES ('${date}', 'session-auto', '${escaped(summary.slice(0, 5000))}', 'session,auto-capture');`
                    );
                } catch { /* best effort */ }
            }

            // Clean up our JSONL buffer
            try { await unlink(HISTORY_FILE); } catch { /* ok */ }
        },
    },
});

// --- Event listeners: write each turn/tool call to JSONL immediately (crash safety) ---

session.on("user.message", (event) => {
    const content = event.data?.content || "";
    if (content) {
        sessionMeta.turnCount++;
        appendHistory({ type: "turn", role: "user", content: content.slice(0, 5000), ts: new Date().toISOString() });
    }
});

session.on("assistant.message", (event) => {
    const content = event.data?.content || "";
    if (content) {
        sessionMeta.turnCount++;
        appendHistory({ type: "turn", role: "assistant", content: content.slice(0, 5000), ts: new Date().toISOString() });
    }
});

session.on("tool.execution_complete", (event) => {
    sessionMeta.toolCount++;
    appendHistory({
        type: "tool",
        tool: event.data?.toolName || "unknown",
        ok: event.data?.success ?? true,
        ts: new Date().toISOString(),
    });
});

session.on("session.shutdown", (event) => {
    sessionMeta.premiumRequests = event.data?.totalPremiumRequests || 0;
    sessionMeta.codeChanges = event.data?.codeChanges || 0;
});
