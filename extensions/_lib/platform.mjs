import { homedir } from "node:os";
import { join } from "node:path";

export const HOME = homedir();
export const CLAWPILOT_STATE_DIR = join(HOME, ".clawpilot");
export const COPILOT_BIN = "copilot";
export const IS_WINDOWS = process.platform === "win32";
export const IS_MACOS = process.platform === "darwin";
export const IS_LINUX = process.platform === "linux";

export const statePath = (...parts) => join(CLAWPILOT_STATE_DIR, ...parts);

