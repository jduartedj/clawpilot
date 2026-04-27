// Clawpilot CLI — memory-db extension
// SQLite-backed memory with FTS5 full-text search.
// Active memory stays in files; rotated/archived memory goes to the DB.
import { joinSession } from "@github/copilot-sdk/extension";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, unlink, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const DB_PATH = join(homedir(), ".clawpilot", "memory.db");
const MEMORY_DIR = join(homedir(), "clawd", "memory");
const ROTATE_DAYS = 7;

async function ensureDir(dir) {
    await mkdir(dir, { recursive: true });
}

function sqlite(sql, dbPath = DB_PATH) {
    return new Promise((resolve) => {
        execFile("sqlite3", [dbPath, sql], { timeout: 15000 }, (err, stdout, stderr) => {
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
            name TEXT,
            summary TEXT,
            started_at TEXT,
            ended_at TEXT,
            model TEXT,
            cwd TEXT
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
                const limit = args.limit || 20;
                const escaped = args.query.replace(/'/g, "''");
                const result = await sqlite(
                    `.mode json\nSELECT m.id, m.date, m.source, substr(m.content, 1, 500) as content, m.tags FROM memories m JOIN memory_fts f ON m.id = f.rowid WHERE memory_fts MATCH '${escaped}' ORDER BY rank LIMIT ${limit};`
                );
                if (!result.ok || !result.stdout) return "No results found.";
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
                        await sqlite(
                            `INSERT INTO memories (date, source, content, tags) VALUES ('${date}', '${f}', '${escaped}', 'daily-memory');`
                        );
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
                const days = args.days || 30;
                const limit = args.limit || 20;
                const result = await sqlite(
                    `.mode json\nSELECT id, date, source, substr(content, 1, 300) as preview, tags FROM memories WHERE date >= date('now', '-${days} days') ORDER BY date DESC LIMIT ${limit};`
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
        onSessionEnd: async (input) => {
            if (!input.finalMessage) return;
            try {
                await ensureSchema();
                const summary = (input.finalMessage || "").slice(0, 2000).replace(/'/g, "''");
                const date = new Date().toISOString().slice(0, 10);
                await sqlite(
                    `INSERT INTO sessions_log (id, summary, ended_at) VALUES ('${Date.now()}', '${summary}', datetime('now'));`
                );
            } catch { /* best effort */ }
        },
    },
});
