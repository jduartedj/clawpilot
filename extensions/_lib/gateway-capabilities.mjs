import { IS_LINUX, IS_MACOS, IS_WINDOWS } from "./platform.mjs";

export function gatewayCapabilities() {
    return {
        platform: process.platform,
        lifecycle: IS_MACOS ? "manual-only" : "managed",
        chatSend: true,
        events: ["sse", "polling"],
        tokenStreaming: false,
        toolCallRecords: "best-effort",
        schedules: IS_LINUX || IS_WINDOWS,
        openclawCronBridge: "read+trigger-through-pilotclaw",
        heartbeat: true,
        channels: "status+dry-run-send",
        memory: "search-only",
        vault: "names-only",
        nodes: "native-openclaw-compatible",
        nodePermissions: "gateway-auth-full-node-access",
        canvas: "via-node.invoke",
        voice: false,
        multiClientWrites: "serialized-per-session",
        macosGatewayLifecycle: IS_MACOS ? "parked" : "not-applicable",
    };
}

export function unsupportedCapability(feature) {
    return {
        supported: false,
        reason: "parked",
        feature,
    };
}
