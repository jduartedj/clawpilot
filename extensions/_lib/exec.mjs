import { execFile } from "node:child_process";

export function exec(cmd, args, options = {}) {
    return new Promise((resolve) => {
        execFile(cmd, args, { timeout: 15000, ...options }, (err, stdout, stderr) => {
            resolve({
                ok: !err,
                stdout: stdout?.trim() || "",
                stderr: stderr?.trim() || "",
                code: err?.code,
            });
        });
    });
}

