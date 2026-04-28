import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { HOME } from "./platform.mjs";
import { ensureDir } from "./fs.mjs";
import { exec } from "./exec.mjs";

export const SYSTEMD_USER_DIR = join(HOME, ".config", "systemd", "user");

export function unitName(prefix, name) {
    return `${prefix}-${String(name || "").replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

export async function writeUserUnit(fileName, content) {
    await ensureDir(SYSTEMD_USER_DIR);
    await writeFile(join(SYSTEMD_USER_DIR, fileName), content);
}

export async function removeUserUnit(fileName) {
    try {
        await unlink(join(SYSTEMD_USER_DIR, fileName));
    } catch (err) {
        if (err?.code !== "ENOENT") throw err;
    }
}

export function daemonReload() {
    return exec("systemctl", ["--user", "daemon-reload"]);
}

export function enableNow(unit) {
    return exec("systemctl", ["--user", "enable", "--now", unit]);
}

export async function stopDisable(unit) {
    await exec("systemctl", ["--user", "stop", unit]);
    return exec("systemctl", ["--user", "disable", unit]);
}

export function startUnit(unit) {
    return exec("systemctl", ["--user", "start", unit]);
}

export function statusUnit(unit) {
    return exec("systemctl", ["--user", "status", unit, "--no-pager"]);
}

export function activeStatus(unit) {
    return exec("systemctl", ["--user", "is-active", unit]);
}

export function listTimers(pattern) {
    return exec("systemctl", ["--user", "list-timers", pattern, "--no-pager", "--all"]);
}

export function journalLogs(unit, lines = 100) {
    return exec("journalctl", ["--user", "-u", unit, "--no-pager", "-n", String(lines)]);
}

export function runTransientUnit({ unit, cwd, command }) {
    return exec("systemd-run", [
        "--user",
        "--collect",
        `--unit=${unit}`,
        `--working-directory=${cwd}`,
        "/bin/bash",
        "-lc",
        command,
    ]);
}

