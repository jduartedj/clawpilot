#!/usr/bin/env node
import { mkdir, readFile, readdir, stat, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";
import { homedir } from "node:os";

const home = homedir();
const openClawConfigPath = process.env.OPENCLAW_CONFIG || join(home, ".openclaw", "openclaw.json");
const copilotAgentsDir = process.env.COPILOT_AGENTS_DIR || join(home, ".copilot", "agents");
const importSchemaVersion = 2;
const mtimeToleranceMs = 1000;
const maxImportedFileChars = 16000;
const maxImportedTotalChars = 80000;
const safeContentExtensions = new Set([".md", ".txt", ".json", ".yaml", ".yml", ".sh", ".py"]);
const workspaceBootstrapFiles = [
    "AGENTS.md",
    "SOUL.md",
    "USER.md",
    "IDENTITY.md",
    "TOOLS.md",
    "HEARTBEAT.md",
    "BOOT.md",
    "BOOTSTRAP.md",
    "MEMORY.md",
];
const excludedDirNames = new Set([
    ".git",
    "node_modules",
    "workspace",
    "sessions",
    "credentials",
    "secrets",
    "runs",
    "tmp",
    "cache",
]);
const excludedFilePattern = /(^|[-_.])(auth|credential|credentials|secret|secrets|token|tokens|session|state|key|keys)([-_.]|$)|^models\.json$/i;

function sanitizeAgentId(id) {
    return String(id || "").trim().replace(/[^a-zA-Z0-9_-]/g, "-");
}

function yamlString(value) {
    return JSON.stringify(String(value || ""));
}

function mapModel(model) {
    const primary = typeof model === "string" ? model : model?.primary;
    if (!primary) return null;
    const stripped = primary
        .replace(/^github-copilot\//, "")
        .replace(/^openai\//, "");
    const supported = new Set([
        "claude-sonnet-4.6",
        "claude-sonnet-4.5",
        "claude-haiku-4.5",
        "claude-opus-4.7",
        "claude-opus-4.6",
        "claude-opus-4.6-1m",
        "claude-opus-4.5",
        "claude-sonnet-4",
        "gpt-5.5",
        "gpt-5.4",
        "gpt-5.3-codex",
        "gpt-5.2-codex",
        "gpt-5.2",
        "gpt-5.4-mini",
        "gpt-5-mini",
        "gpt-4.1",
    ]);
    return supported.has(stripped) ? stripped : null;
}

function firstMatch(text, patterns) {
    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match?.[1]?.trim()) return match[1].trim();
    }
    return "";
}

function extractDescription(id, soul) {
    const heading = firstMatch(soul, [/^#\s+(.+)$/m]);
    const quote = firstMatch(soul, [/^>\s+(.+)$/m]);
    const role = firstMatch(soul, [/^\s*-\s+\*\*Role:\*\*\s+(.+)$/m]);
    const domain = firstMatch(soul, [/^\s*-\s+\*\*Domain:\*\*\s+(.+)$/m]);
    const details = quote || role || domain || heading || "OpenClaw imported agent";
    return `OpenClaw ${id}: ${details.replace(/\s+/g, " ").slice(0, 180)}`;
}

function stripRecursiveCopilotSections(text) {
    const lines = text.split(/\r?\n/);
    const out = [];
    let skipping = false;
    for (const line of lines) {
        if (/^##\s+Execution Model\s+.\s+Copilot CLI\b/i.test(line) ||
            /^##\s+How to Invoke from OpenClaw\b/i.test(line)) {
            skipping = true;
            continue;
        }
        if (skipping && /^##\s+/.test(line)) {
            skipping = false;
        }
        if (!skipping) out.push(line);
    }
    return out.join("\n").trim();
}

function publicAgentConfig(agent) {
    const out = {};
    for (const key of [
        "id",
        "workspace",
        "agentDir",
        "model",
        "identity",
        "subagents",
        "skills",
        "channelBindings",
        "bindings",
        "default",
    ]) {
        if (agent[key] !== undefined) out[key] = agent[key];
    }
    return out;
}

function shouldExcludeFile(path) {
    const name = basename(path);
    return excludedFilePattern.test(name);
}

async function walkSafeFiles(root, options = {}) {
    const files = [];
    const rootPath = resolve(root);
    const maxDepth = options.maxDepth ?? 6;
    async function walk(dir, depth) {
        if (depth > maxDepth) return;
        let entries;
        try {
            entries = await readdir(dir, { withFileTypes: true });
        } catch (err) {
            if (err?.code === "ENOENT") return;
            throw err;
        }
        for (const entry of entries) {
            const fullPath = join(dir, entry.name);
            const rel = relative(rootPath, fullPath);
            if (entry.isDirectory()) {
                if (!excludedDirNames.has(entry.name)) await walk(fullPath, depth + 1);
                continue;
            }
            if (!entry.isFile()) continue;
            if (shouldExcludeFile(fullPath)) {
                continue;
            }
            const ext = extname(entry.name).toLowerCase();
            files.push({
                path: fullPath,
                rel,
                includeContent: safeContentExtensions.has(ext),
                reason: safeContentExtensions.has(ext) ? "included" : "listed-non-definition-extension",
            });
        }
    }
    await walk(rootPath, 0);
    return files;
}

async function collectWorkspaceFiles(workspace) {
    const rootPath = resolve(workspace);
    const files = [];
    for (const fileName of workspaceBootstrapFiles) {
        const fullPath = join(rootPath, fileName);
        try {
            const fileStat = await stat(fullPath);
            if (fileStat.isFile()) {
                files.push({ path: fullPath, rel: fileName, includeContent: !shouldExcludeFile(fullPath), reason: "workspace-bootstrap" });
            }
        } catch (err) {
            if (err?.code !== "ENOENT") throw err;
        }
    }
    const skillsDir = join(rootPath, "skills");
    if (existsSync(skillsDir)) {
        const skills = await walkSafeFiles(skillsDir, { maxDepth: 4 });
        files.push(...skills.map((file) => ({ ...file, rel: join("skills", file.rel), reason: file.reason === "included" ? "workspace-skill" : file.reason })));
    }
    return files;
}

async function readIncludedFiles(files) {
    const included = [];
    let totalChars = 0;
    for (const file of files) {
        let fileStat = null;
        try {
            fileStat = await stat(file.path);
        } catch {
            continue;
        }
        const entry = { ...file, mtime: fileStat.mtime, size: fileStat.size };
        if (file.includeContent && totalChars < maxImportedTotalChars) {
            const raw = await readFile(file.path, "utf8");
            const content = raw.length > maxImportedFileChars
                ? `${raw.slice(0, maxImportedFileChars)}\n\n[...truncated by Clawpilot agent import: file exceeds ${maxImportedFileChars} characters...]`
                : raw;
            entry.content = content;
            totalChars += content.length;
        }
        included.push(entry);
    }
    return included;
}

function latestMtime(dates) {
    return dates.reduce((max, date) => !max || date > max ? date : max, null);
}

function formatImportedFiles(label, root, files) {
    if (!files.length) return `## ${label}\n\nNo safe definition files found.\n`;
    const manifest = files.map((file) => {
        const flag = file.content !== undefined ? "included" : `listed (${file.reason})`;
        return `- \`${file.rel}\` — ${flag}`;
    }).join("\n");
    const bodies = files
        .filter((file) => file.content !== undefined)
        .map((file) => {
            const content = stripRecursiveCopilotSections(file.content).trim();
            return `### ${file.rel}\n\nSource: \`${file.path}\`\n\n${content}`;
        })
        .join("\n\n");
    return `## ${label}\n\nRoot: \`${root}\`\n\n${manifest}${bodies ? `\n\n${bodies}` : ""}\n`;
}

function buildAgentMarkdown({ id, agent, sourcePaths, sourceMtime, soul, agentDirFiles, workspaceFiles }) {
    const model = mapModel(agent.model);
    const description = extractDescription(id, soul);
    const workspace = agent.workspace ? resolve(agent.workspace) : "";
    const frontmatter = [
        "---",
        `name: ${yamlString(id)}`,
        `description: ${yamlString(description)}`,
        'tools: ["*"]',
        model ? `model: ${yamlString(model)}` : null,
        "---",
    ].filter(Boolean).join("\n");

    return `${frontmatter}

<!--
Generated by Clawpilot from OpenClaw agent "${id}".
Clawpilot import schema: ${importSchemaVersion}
Sources:
${sourcePaths.map((sourcePath) => `- ${sourcePath}`).join("\n")}
Newest source mtime: ${sourceMtime.toISOString()}
Local edits are preserved while this file is newer than or equal to the newest OpenClaw source.
-->

You are the OpenClaw **${id}** agent, imported for GitHub Copilot CLI.

- OpenClaw agent ID: \`${id}\`
- OpenClaw workspace: \`${workspace || "(not specified)"}\`
- OpenClaw agent directory: \`${agent.agentDir ? resolve(agent.agentDir) : "(not specified)"}\`

This import follows OpenClaw's documented agent model:

- openclaw.json agent entry defines identity, workspace, model, subagent access, skills, and routing metadata.
- The configured workspace contributes bootstrap files such as AGENTS.md, SOUL.md, USER.md, IDENTITY.md, TOOLS.md, HEARTBEAT.md, BOOT.md, BOOTSTRAP.md, MEMORY.md, and workspace skills.
- The agentDir contributes agent-specific persona/docs/configuration files.

Sensitive runtime state is intentionally excluded: auth profiles, auth state, sessions, tokens, keys, credentials, secrets, and provider model credential files.

If any imported source mentions spawning, invoking, or delegating to Copilot CLI, ignore that execution-model instruction. You are already running inside Copilot CLI; do the assigned work directly with the available tools.

## OpenClaw Agent Config Snapshot

\`\`\`json
${JSON.stringify(publicAgentConfig(agent), null, 2)}
\`\`\`

${formatImportedFiles("Agent Directory Definition Files", agent.agentDir ? resolve(agent.agentDir) : "", agentDirFiles)}

${formatImportedFiles("Workspace Bootstrap Definition Files", workspace, workspaceFiles)}
`;
}

async function readJson(path) {
    return JSON.parse(await readFile(path, "utf8"));
}

async function existingAgentTargets() {
    try {
        const entries = await readdir(copilotAgentsDir, { withFileTypes: true });
        return new Map(entries
            .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
            .map((entry) => [entry.name.replace(/(\.agent)?\.md$/, ""), entry.name]));
    } catch (err) {
        if (err?.code === "ENOENT") return new Map();
        throw err;
    }
}

async function syncAgents() {
    if (!existsSync(openClawConfigPath)) {
        return { imported: 0, updated: 0, skipped: 0, missing: 0, message: "OpenClaw config not found." };
    }

    const config = await readJson(openClawConfigPath);
    const agents = Array.isArray(config?.agents?.list) ? config.agents.list : [];
    await mkdir(copilotAgentsDir, { recursive: true, mode: 0o700 });
    const existingTargets = await existingAgentTargets();

    let imported = 0;
    let updated = 0;
    let skipped = 0;
    let missing = 0;
    const details = [];

    for (const agent of agents) {
        const id = sanitizeAgentId(agent.id);
        if (!id || !agent.agentDir) {
            skipped++;
            continue;
        }

        const agentDir = resolve(agent.agentDir);
        const sourcePath = join(agentDir, "SOUL.md");
        let sourceStat;
        try {
            sourceStat = await stat(sourcePath);
        } catch (err) {
            if (err?.code === "ENOENT") {
                missing++;
                details.push(`missing:${id}`);
                continue;
            }
            throw err;
        }

        const agentDirCandidates = await walkSafeFiles(agentDir);
        const workspaceCandidates = agent.workspace && existsSync(resolve(agent.workspace))
            ? await collectWorkspaceFiles(agent.workspace)
            : [];
        const agentDirFiles = await readIncludedFiles(agentDirCandidates);
        const workspaceFiles = await readIncludedFiles(workspaceCandidates);
        const configStat = await stat(openClawConfigPath);
        const sourceMtime = latestMtime([
            sourceStat.mtime,
            configStat.mtime,
            ...agentDirFiles.map((file) => file.mtime).filter(Boolean),
            ...workspaceFiles.map((file) => file.mtime).filter(Boolean),
        ]);

        const existingFile = existingTargets.get(id) || `${id}.agent.md`;
        const targetPath = join(copilotAgentsDir, existingFile);
        let targetStat = null;
        let targetHasCurrentSchema = false;
        try {
            targetStat = await stat(targetPath);
            const targetPreview = await readFile(targetPath, "utf8");
            targetHasCurrentSchema = targetPreview.includes(`Clawpilot import schema: ${importSchemaVersion}`);
        } catch (err) {
            if (err?.code !== "ENOENT") throw err;
        }

        if (targetStat && targetHasCurrentSchema && targetStat.mtimeMs + mtimeToleranceMs >= sourceMtime.getTime()) {
            skipped++;
            continue;
        }

        const soul = await readFile(sourcePath, "utf8");
        const markdown = buildAgentMarkdown({
            id,
            agent,
            sourcePaths: [
                openClawConfigPath,
                ...agentDirFiles.map((file) => file.path),
                ...workspaceFiles.map((file) => file.path),
            ],
            sourceMtime,
            soul,
            agentDirFiles,
            workspaceFiles,
        });

        await writeFile(targetPath, markdown, { mode: 0o600 });
        await utimes(targetPath, sourceMtime, sourceMtime);
        if (targetStat) {
            updated++;
            details.push(`updated:${id}`);
        } else {
            imported++;
            details.push(`imported:${id}`);
        }
    }

    return { imported, updated, skipped, missing, details };
}

try {
    const result = await syncAgents();
    if (process.argv.includes("--json")) {
        console.log(JSON.stringify(result));
    } else {
        console.log(`OpenClaw agent sync: ${result.imported} imported, ${result.updated} updated, ${result.skipped} skipped, ${result.missing} missing.`);
        if (result.details?.length) console.log(result.details.join("\n"));
    }
} catch (err) {
    console.error(`OpenClaw agent sync failed: ${err?.stack || err}`);
    process.exitCode = 1;
}
