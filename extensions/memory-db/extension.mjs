// Clawpilot CLI — memory-db extension
// SQLite with JSON columns — NoSQL-style document store with SQL power.
// Auto-captures Copilot session history from events.jsonl.
// Stores events as JSON blobs, queryable via json_extract + FTS5.
import { joinSession } from "@github/copilot-sdk/extension";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, unlink, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const DB_PATH = join(homedir(), ".clawpilot", "memory.db");
const MEMORY_DIR = join(homedir(), "clawd", "memory");
const SESSION_STATE_DIR = join(homedir(), ".copilot", "session-state");
const ROTATE_DAYS = 7;

async function ensureDir(dir) {
    await mkdir(dir, { recursive: true });
}

function sqlite(sql) {
    return new Promise((resolve) => {
        execFile("sqlite3", [DB_PATH, sql], { timeout: 30000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
            resolve({ ok: !err, stdout: stdout?.trim() || "", stderr: stderr?.trim() || "" });
        });
    });
}

function sqliteJson(sql) {
    return new Promise((resolve) => {
        execFile("sqlite3", ["-json", DB_PATH, sql], { timeout: 30000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
            resolve({ ok: !err, stdout: stdout?.trim() || "", stderr: stderr?.trim() || "" });
        });
    });
}

// Pipe SQL via stdin to avoid ARG_MAX limits on large inserts
function sqliteStdin(sql) {
    return new Promise((resolve) => {
        const proc = execFile("sqlite3", [DB_PATH], { timeout: 30000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
            resolve({ ok: !err, stdout: stdout?.trim() || "", stderr: stderr?.trim() || "" });
        });
        proc.stdin.write(sql);
        proc.stdin.end();
    });
}

async function ensureSchema() {
    await ensureDir(join(homedir(), ".clawpilot"));
    await sqlite(`
        PRAGMA journal_mode=WAL;

        CREATE TABLE IF NOT EXISTS memories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            date TEXT NOT NULL,
            source TEXT NOT NULL,
            content TEXT NOT NULL,
            tags TEXT DEFAULT '',
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            data JSON NOT NULL,
            started_at TEXT,
            ended_at TEXT DEFAULT (datetime('now')),
            cwd TEXT,
            reason TEXT,
            turn_count INTEGER DEFAULT 0,
            tool_count INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            type TEXT NOT NULL,
            data JSON NOT NULL,
            timestamp TEXT,
            FOREIGN KEY (session_id) REFERENCES sessions(id)
        );

        CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
        CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
        CREATE INDEX IF NOT EXISTS idx_sessions_date ON sessions(started_at);

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

// Parse and ingest Copilot's events.jsonl into the DB
async function ingestSession(sessionId, eventsPath, reason) {
    const raw = await readFile(eventsPath, "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);
    if (lines.length === 0) return false;

    await ensureSchema();

    // Parse events
    let startedAt = "", cwd = "";
    let turnCount = 0, toolCount = 0;
    const userMessages = [];
    const sqlStatements = [];

    for (const line of lines) {
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }

        const type = ev.type || "";
        const ts = ev.timestamp || "";
        const escapedData = JSON.stringify(ev.data || {}).replace(/'/g, "''");

        if (type === "session.start") {
            startedAt = ev.data?.startTime || ts;
            cwd = ev.data?.context?.cwd || "";
        }

        // Only store meaningful events (skip streaming deltas, internal noise)
        if (["user.message", "assistant.message", "tool.execution_start", "tool.execution_complete",
             "session.start", "session.shutdown", "session.error"].includes(type)) {
            sqlStatements.push(
                `INSERT INTO events (session_id, type, data, timestamp) VALUES ('${sessionId}', '${type}', '${escapedData}', '${ts}');`
            );
        }

        if (type === "user.message" && ev.data?.content) {
            turnCount++;
            userMessages.push(ev.data.content.slice(0, 200));
        } else if (type === "assistant.message") {
            turnCount++;
        } else if (type === "tool.execution_complete") {
            toolCount++;
        }
    }

    if (turnCount === 0) return false;

    // Build session summary JSON
    const sessionData = {
        userMessages: userMessages.slice(0, 20),
        turnCount,
        toolCount,
        reason,
    };
    const escapedSessionData = JSON.stringify(sessionData).replace(/'/g, "''");
    const escapedCwd = cwd.replace(/'/g, "''");

    // Insert session + all events in one transaction (via stdin to avoid ARG_MAX)
    const fullSql = `BEGIN;\n` +
        `INSERT OR IGNORE INTO sessions (id, data, started_at, cwd, reason, turn_count, tool_count) VALUES ('${sessionId}', '${escapedSessionData}', '${startedAt}', '${escapedCwd}', '${reason}', ${turnCount}, ${toolCount});\n` +
        sqlStatements.join("\n") + "\n" +
        `COMMIT;\n`;

    const result = await sqliteStdin(fullSql);
    if (!result.ok) return false;

    // Also store condensed summary as searchable memory
    const date = startedAt ? startedAt.slice(0, 10) : new Date().toISOString().slice(0, 10);
    const summary = `Session (${turnCount} turns, ${toolCount} tool calls): ${userMessages.join(" | ")}`;
    const escapedSummary = summary.slice(0, 5000).replace(/'/g, "''");
    await sqlite(
        `INSERT INTO memories (date, source, content, tags) VALUES ('${date}', 'session-auto', '${escapedSummary}', 'session,auto-capture');`
    );

    return true;
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
                const result = await sqliteJson(
                    `SELECT m.id, m.date, m.source, substr(m.content, 1, 500) as content, m.tags FROM memories m JOIN memory_fts f ON m.id = f.rowid WHERE memory_fts MATCH '${escaped}' ORDER BY rank LIMIT ${limit};`
                );
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
                try { entries = await readdir(MEMORY_DIR); } catch { return "Memory directory not found."; }

                const cutoff = new Date();
                cutoff.setDate(cutoff.getDate() - ROTATE_DAYS);
                const cutoffStr = cutoff.toISOString().slice(0, 10);

                let rotated = 0;
                for (const f of entries) {
                    const match = f.match(/^(\d{4}-\d{2}-\d{2})(.*)?\.md$/);
                    if (!match) continue;
                    if (match[1] >= cutoffStr) continue;

                    const filePath = join(MEMORY_DIR, f);
                    try {
                        const content = await readFile(filePath, "utf-8");
                        if (!content.trim()) continue;
                        const escaped = content.replace(/'/g, "''");
                        const escapedFile = f.replace(/'/g, "''");
                        const result = await sqlite(
                            `INSERT INTO memories (date, source, content, tags) VALUES ('${match[1]}', '${escapedFile}', '${escaped}', 'daily-memory');`
                        );
                        if (!result.ok) continue;
                        await unlink(filePath);
                        rotated++;
                    } catch { /* skip */ }
                }
                return `Rotated ${rotated} memory file(s) into database.`;
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
                const result = await sqliteJson(
                    `SELECT id, date, source, substr(content, 1, 300) as preview, tags FROM memories WHERE date >= date('now', '-${days} days') ORDER BY date DESC LIMIT ${limit};`
                );
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
                if (!result.ok) return { textResultForLlm: `Failed: ${result.stderr}`, resultType: "failure" };
                return `Memory stored (${date}, tags: ${tags}).`;
            },
        },
    ],
    hooks: {
        onSessionStart: async () => {
            // Ingest un-captured sessions (covers crashes, unexpected exits)
            try {
                await ensureSchema();
                const sessionDirs = await readdir(SESSION_STATE_DIR);
                let ingested = 0;

                for (const sid of sessionDirs) {
                    const eventsPath = join(SESSION_STATE_DIR, sid, "events.jsonl");
                    try { await stat(eventsPath); } catch { continue; }

                    // Skip if already in DB
                    const check = await sqlite(`SELECT count(*) FROM sessions WHERE id = '${sid.replace(/'/g, "''")}';`);
                    if (check.stdout === "1") continue;

                    // Skip active sessions (have lock files)
                    try {
                        const files = await readdir(join(SESSION_STATE_DIR, sid));
                        if (files.some((f) => f.startsWith("inuse."))) continue;
                    } catch { continue; }

                    try {
                        if (await ingestSession(sid, eventsPath, "recovered")) ingested++;
                    } catch { /* skip broken sessions */ }
                }

                if (ingested > 0) {
                    return { additionalContext: `[Clawpilot Memory] Ingested ${ingested} previous session(s) into the database.` };
                }
            } catch { /* best effort */ }
        },
        onSessionEnd: async (input) => {
            const workspace = session.workspacePath;
            if (!workspace) return;
            const eventsPath = join(workspace, "events.jsonl");
            const sid = workspace.split("/").pop();
            try { await ingestSession(sid, eventsPath, input.reason || "complete"); } catch { /* best effort */ }
        },
    },
});
