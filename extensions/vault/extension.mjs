// PilotClaw CLI — vault extension
// age-encrypted local secrets with rotation tracking.
import { joinSession } from "@github/copilot-sdk/extension";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile, readdir, unlink, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const VAULT_DIR = join(homedir(), ".pilotclaw", "vault");
const KEY_FILE = join(VAULT_DIR, ".age-key");
const ROTATION_LOG = join(VAULT_DIR, ".rotation.json");

async function ensureDir(dir) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const { chmod } = await import("node:fs/promises");
    try { await chmod(dir, 0o700); } catch { /* ok */ }
}

function exec(cmd, args, opts = {}) {
    return new Promise((resolve) => {
        execFile(cmd, args, { timeout: 10000, ...opts }, (err, stdout, stderr) => {
            resolve({ ok: !err, stdout: stdout?.trim() || "", stderr: stderr?.trim() || "" });
        });
    });
}

async function ensureKey() {
    await ensureDir(VAULT_DIR);
    // Check both binaries exist
    const ageCheck = await exec("which", ["age"]);
    const keygenCheck = await exec("which", ["age-keygen"]);
    if (!ageCheck.ok || !keygenCheck.ok) {
        throw new Error("age not installed. Install: sudo apt install age");
    }
    try {
        await stat(KEY_FILE);
        // Enforce permissions on existing key
        const { chmod } = await import("node:fs/promises");
        await chmod(KEY_FILE, 0o600);
    } catch {
        const result = await exec("age-keygen", ["-o", KEY_FILE]);
        if (!result.ok) {
            throw new Error(`Failed to generate age key: ${result.stderr}. Install age: apt install age`);
        }
        const { chmod } = await import("node:fs/promises");
        await chmod(KEY_FILE, 0o600);
    }
}

async function getPublicKey() {
    const keyContent = await readFile(KEY_FILE, "utf-8");
    const match = keyContent.match(/public key: (age1[a-z0-9]+)/);
    return match ? match[1] : null;
}

function secretPath(key) {
    return join(VAULT_DIR, `${key.replace(/[^a-zA-Z0-9_.-]/g, "_")}.age`);
}

async function loadRotationLog() {
    try {
        return JSON.parse(await readFile(ROTATION_LOG, "utf-8"));
    } catch {
        return {};
    }
}

async function saveRotationLog(log) {
    await writeFile(ROTATION_LOG, JSON.stringify(log, null, 2), { mode: 0o600 });
}

const session = await joinSession({
    tools: [
        {
            name: "pilotclaw_vault_set",
            description: "Store a secret in the encrypted vault. The value is encrypted with age before writing to disk.",
            parameters: {
                type: "object",
                properties: {
                    key: { type: "string", description: "Secret name/key (e.g., 'api-key-openai', 'db-password')" },
                    value: { type: "string", description: "Secret value to encrypt and store" },
                },
                required: ["key", "value"],
            },
            handler: async (args) => {
                await ensureKey();
                const pubKey = await getPublicKey();
                if (!pubKey) return { textResultForLlm: "Could not read age public key.", resultType: "failure" };

                const path = secretPath(args.key);

                // Encrypt via stdin
                const result = await new Promise((resolve) => {
                    const proc = execFile("age", ["-r", pubKey, "-o", path], (err, stdout, stderr) => {
                        resolve({ ok: !err, stderr: stderr?.trim() || "" });
                    });
                    proc.stdin.write(args.value);
                    proc.stdin.end();
                });

                if (!result.ok) {
                    return { textResultForLlm: `Encryption failed: ${result.stderr}`, resultType: "failure" };
                }

                const log = await loadRotationLog();
                log[args.key] = { lastSet: new Date().toISOString(), rotations: (log[args.key]?.rotations || 0) + 1 };
                await saveRotationLog(log);

                return `Secret '${args.key}' encrypted and stored.`;
            },
        },
        {
            name: "pilotclaw_vault_get",
            description: "Retrieve and decrypt a secret from the vault.",
            parameters: {
                type: "object",
                properties: {
                    key: { type: "string", description: "Secret name/key to retrieve" },
                },
                required: ["key"],
            },
            handler: async (args) => {
                await ensureKey();
                const path = secretPath(args.key);

                // Use raw exec (no trim) to preserve secret whitespace/newlines
                const result = await new Promise((resolve) => {
                    execFile("age", ["-d", "-i", KEY_FILE, path], { timeout: 10000 }, (err, stdout, stderr) => {
                        resolve({ ok: !err, stdout: stdout || "", stderr: stderr?.trim() || "" });
                    });
                });
                if (!result.ok) {
                    return { textResultForLlm: `Decryption failed: ${result.stderr}. Does '${args.key}' exist?`, resultType: "failure" };
                }
                return result.stdout;
            },
        },
        {
            name: "pilotclaw_vault_list",
            description: "List all secrets stored in the vault (names only, not values).",
            parameters: { type: "object", properties: {} },
            handler: async () => {
                await ensureDir(VAULT_DIR);
                let files;
                try {
                    files = await readdir(VAULT_DIR);
                } catch {
                    return "Vault is empty.";
                }

                const secrets = files.filter((f) => f.endsWith(".age")).map((f) => f.replace(/\.age$/, ""));
                if (secrets.length === 0) return "Vault is empty.";

                const log = await loadRotationLog();
                const lines = secrets.map((s) => {
                    const info = log[s];
                    const age = info?.lastSet ? `(set ${info.lastSet}, ${info.rotations || 1} version(s))` : "";
                    return `• ${s} ${age}`;
                });

                return `Vault contains ${secrets.length} secret(s):\n${lines.join("\n")}`;
            },
        },
        {
            name: "pilotclaw_vault_delete",
            description: "Delete a secret from the vault.",
            parameters: {
                type: "object",
                properties: {
                    key: { type: "string", description: "Secret name/key to delete" },
                },
                required: ["key"],
            },
            handler: async (args) => {
                const path = secretPath(args.key);
                try {
                    await unlink(path);
                } catch {
                    return `Secret '${args.key}' not found.`;
                }

                const log = await loadRotationLog();
                delete log[args.key];
                await saveRotationLog(log);

                return `Secret '${args.key}' deleted.`;
            },
        },
    ],
});
