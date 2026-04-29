#!/usr/bin/env node
import { watch } from "node:fs";
import { readdir, readFile, rename, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { ensureDir, sanitizeName } from "./fs.mjs";
import { HOME, statePath } from "./platform.mjs";
import { spawnDetachedCopilot } from "./spawn-backend.mjs";

const INBOX_DIR = statePath("inbox");
const PROCESSING_DIR = statePath("processing");
const PROCESSED_DIR = statePath("processed");
const LOGS_DIR = statePath("logs");

async function moveProcessed(path, fileName) {
    await ensureDir(PROCESSED_DIR);
    const stampedName = `${Date.now()}-${fileName}`;
    await rename(path, join(PROCESSED_DIR, stampedName));
}

async function claimFile(fileName) {
    await ensureDir(PROCESSING_DIR);
    const source = join(INBOX_DIR, fileName);
    const claimed = join(PROCESSING_DIR, `${Date.now()}-${fileName}`);
    try {
        await rename(source, claimed);
        return claimed;
    } catch (err) {
        if (err?.code === "ENOENT") return null;
        throw err;
    }
}

export async function processInbox() {
    await ensureDir(INBOX_DIR);
    await ensureDir(PROCESSING_DIR);
    await ensureDir(PROCESSED_DIR);
    await ensureDir(LOGS_DIR);

    const files = (await readdir(INBOX_DIR)).filter((file) => file.endsWith(".json"));
    for (const fileName of files) {
        const path = await claimFile(fileName);
        if (!path) continue;
        let processed = false;
        try {
            let payload;
            payload = JSON.parse(await readFile(path, "utf8"));

            const prompt = String(payload.prompt || "");
            if (!prompt) {
                processed = true;
                await moveProcessed(path, fileName);
                continue;
            }

            const name = sanitizeName(basename(fileName, ".json")) || `task-${Date.now()}`;
            const cwd = payload.cwd || HOME;
            const cwdStat = await stat(cwd);
            if (!cwdStat.isDirectory()) {
                throw new Error(`Daemon task '${fileName}' cwd is not a directory: ${cwd}`);
            }

            spawnDetachedCopilot({
                prompt,
                name: `daemon-${name}`,
                model: payload.model || undefined,
                cwd,
                logPath: join(LOGS_DIR, `daemon-${name}.log`),
            });
        } catch (err) {
            console.error(`Failed to process daemon inbox file ${fileName}:`, err);
        } finally {
            if (!processed) {
                await moveProcessed(path, fileName);
            }
        }
    }
}

export async function watchInboxLoop() {
    await ensureDir(INBOX_DIR);
    await processInbox();

    let timer = null;
    const schedule = () => {
        if (timer) return;
        timer = setTimeout(() => {
            timer = null;
            processInbox().catch((err) => console.error(err));
        }, 500);
    };

    watch(INBOX_DIR, { persistent: true }, schedule);
    setInterval(schedule, 10000);
    console.log(`PilotClaw daemon watching ${INBOX_DIR}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const run = process.argv.includes("--watch") || process.env.PILOTCLAW_DAEMON_WATCH === "1"
        ? watchInboxLoop()
        : processInbox();
    run.catch((err) => {
        console.error(err);
        process.exitCode = 1;
    });
}
