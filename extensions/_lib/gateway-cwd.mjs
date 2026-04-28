import { realpath, stat } from "node:fs/promises";

export async function validateGatewayCwd(cwd) {
    const value = String(cwd || "");
    if (!value) throw new Error("cwd is required.");
    const unsupported = /[\x00-\x1f\x7f\r\n=%]/;
    if (unsupported.test(value) || value.trim().startsWith("[")) {
        throw new Error("cwd contains unsupported control characters.");
    }
    const resolved = await realpath(value);
    if (unsupported.test(resolved) || resolved.trim().startsWith("[")) {
        throw new Error("resolved cwd contains unsupported systemd characters.");
    }
    const info = await stat(resolved);
    if (!info.isDirectory()) throw new Error(`cwd is not a directory: ${value}`);
    return resolved;
}
