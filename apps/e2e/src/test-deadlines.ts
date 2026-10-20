// Hosted Windows pays for process startup and durable filesystem operations.
// These are test observation limits; product deadlines and explicit fault limits
// retain their own values.
const hostedWindows = process.platform === "win32" && process.env.GITHUB_ACTIONS === "true";

export const conditionTimeoutMs = hostedWindows ? 15_000 : 5_000;
// Native completion includes cold process activation and durable resume.
export const nativeRunTimeoutMs = hostedWindows ? 30_000 : conditionTimeoutMs;
export const rpcTimeoutMs = hostedWindows ? 30_000 : 10_000;
export const testTimeoutMs = hostedWindows ? 60_000 : 20_000;
