import { homedir } from "node:os";
import { join } from "node:path";

export const HOME = homedir();
export const IS_WINDOWS = process.platform === "win32";
export const IS_MACOS = process.platform === "darwin";
export const IS_LINUX = process.platform === "linux";

export const PILOTCLAW_COMPAT_STATE_DIR = join(HOME, ".pilotclaw");
export const LEGACY_CLAWPILOT_COMPAT_STATE_DIR = join(HOME, ".clawpilot");
export const WINDOWS_LOCALAPPDATA =
    process.env.LOCALAPPDATA || join(HOME, "AppData", "Local");

// Linux keeps state in ~/.pilotclaw. Windows uses the native per-user
// application data location while leaving ~/.pilotclaw available for portable
// launchers/docs and migrated state.
export const PILOTCLAW_STATE_DIR = IS_WINDOWS
    ? join(WINDOWS_LOCALAPPDATA, "PilotClaw")
    : PILOTCLAW_COMPAT_STATE_DIR;
export const LEGACY_CLAWPILOT_STATE_DIR = IS_WINDOWS
    ? join(WINDOWS_LOCALAPPDATA, "Clawpilot")
    : LEGACY_CLAWPILOT_COMPAT_STATE_DIR;

export const PILOTCLAW_LOGS_DIR = join(PILOTCLAW_STATE_DIR, "logs");
export const PILOTCLAW_COMPAT_LOGS_DIR = join(PILOTCLAW_COMPAT_STATE_DIR, "logs");
export const COPILOT_USER_EXTENSIONS_DIR = join(HOME, ".copilot", "extensions");
export const COPILOT_BIN = "copilot";
export const GATEWAY_DIR = join(PILOTCLAW_STATE_DIR, "gateway");
export const GATEWAY_SESSIONS_DIR = join(GATEWAY_DIR, "sessions");
export const GATEWAY_RUNTIME_DIR = join(GATEWAY_DIR, "runtime");
export const GATEWAY_LOCKS_DIR = join(GATEWAY_DIR, "locks");
export const GATEWAY_QUEUES_DIR = join(GATEWAY_DIR, "queues");
export const GATEWAY_LOGS_DIR = join(PILOTCLAW_LOGS_DIR, "gateway");

export const statePath = (...parts) => join(PILOTCLAW_STATE_DIR, ...parts);
export const compatStatePath = (...parts) => join(PILOTCLAW_COMPAT_STATE_DIR, ...parts);
