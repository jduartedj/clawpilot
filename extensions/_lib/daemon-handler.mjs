#!/usr/bin/env node
import { readdir, readFile, rename, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { ensureDir, sanitizeName } from "./fs.mjs";
import { HOME, statePath } from "./platform.mjs";
import { spawnDetachedCopilot } from "./spawn-backend.mjs";

const INBOX_DIR = statePath("inbox");
const PROCESSED_DIR = statePath("processed");
const LOGS_DIR = statePath("logs");

async function moveProcessed(path, fileName) {
    await ensureDir(PROCESSED_DIR);
    await rename(path, join(PROCESSED_DIR, fileName));
}

export async function processInbox() {
    await ensureDir(INBOX_DIR);
    await ensureDir(PROCESSED_DIR);
    await ensureDir(LOGS_DIR);

    const files = (await readdir(INBOX_DIR)).filter((file) => file.endsWith(".json"));
    for (const fileName of files) {
        const path = join(INBOX_DIR, fileName);
        let payload;
        try {
            payload = JSON.parse(await readFile(path, "utf8"));
        } catch {
            await moveProcessed(path, fileName);
            continue;
        }

        const prompt = String(payload.prompt || "");
        if (!prompt) {
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
        await moveProcessed(path, fileName);
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    processInbox().catch((err) => {
        console.error(err);
        process.exitCode = 1;
    });
}
