import { mkdir, readFile, writeFile } from "node:fs/promises";

export async function ensureDir(dir) {
    await mkdir(dir, { recursive: true });
}

export function sanitizeName(name) {
    return String(name || "").replace(/[^a-zA-Z0-9_-]/g, "-");
}

export async function readJsonFile(path, fallback) {
    try {
        return JSON.parse(await readFile(path, "utf8"));
    } catch (err) {
        if (err?.code === "ENOENT") return fallback;
        throw err;
    }
}

export async function writeJsonFile(path, value, options = {}) {
    await writeFile(path, JSON.stringify(value, null, 2), options);
}

export async function tailFile(path, lines = 50) {
    try {
        const content = await readFile(path, "utf8");
        return content.split(/\r?\n/).slice(-Number(lines || 50)).join("\n");
    } catch (err) {
        if (err?.code === "ENOENT") return "(no output yet)";
        throw err;
    }
}

