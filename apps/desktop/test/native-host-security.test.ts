import { Code, ConnectError } from "@connectrpc/connect";
import { afterEach, expect, it, vi } from "vitest";
import { EndpointTrustError } from "@joko/connection-transport/trust";
import type { DesktopManagedOrchestratorConnection } from "../src/channels.js";
import type { DesktopPersonalDevelopmentVersions } from "../src/personal-development-native-versions.js";

const runtime = vi.hoisted(() => ({ unary: vi.fn(), factory: vi.fn() }));
vi.mock("electron", () => ({ app: {}, screen: {}, nativeImage: {}, systemPreferences: {} }));
vi.mock("@joko/connection-transport/node", async original => ({ ...await original<typeof import("@joko/connection-transport/node")>(), createConnectTransport: runtime.factory }));
import { DesktopInputHandoffHost } from "../src/input-handoff-native-host.js";
import { DesktopPersonalDevelopmentHost } from "../src/personal-development-native-host.js";

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
const connection: DesktopManagedOrchestratorConnection = { profileId: "native-profile", serverId: "node", deviceId: "device", name: "Local node", origin: "http://127.0.0.1:4318", endpointPublicKey: `ed25519:${"b".repeat(64)}` };

it.each(["input", "development"] as const)("stops the %s host's security-failure loop but retains retry for an ordinary outage", async kind => {
  vi.useFakeTimers();
  runtime.factory.mockImplementation(() => ({ unary: runtime.unary, stream: vi.fn() }));
  const readAuthKey = vi.fn(async () => "a".repeat(43));
  const dependencies = { readAuthKey, readHostKey: vi.fn(async () => "b".repeat(43)), isAuthorityCurrent: () => true };
  const host = kind === "input" ? new DesktopInputHandoffHost({ ...dependencies, platform: "darwin" })
    : new DesktopPersonalDevelopmentHost({ ...dependencies, versions: {} as DesktopPersonalDevelopmentVersions });
  try {
    runtime.unary.mockRejectedValue(new Error("transport wrapper", { cause: new EndpointTrustError() }));
    host.setConnection(connection);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(runtime.factory).toHaveBeenCalledOnce();
    expect(readAuthKey).not.toHaveBeenCalled();
    host.setConnection({ ...connection });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(runtime.factory).toHaveBeenCalledOnce();
    host.setConnection({ ...connection, endpointPublicKey: `ed25519:${"c".repeat(64)}` });
    await vi.advanceTimersByTimeAsync(1);
    expect(runtime.factory).toHaveBeenCalledTimes(2);

    runtime.unary.mockRejectedValue(new ConnectError("offline", Code.Unavailable));
    host.setConnection(undefined); host.setConnection(connection);
    const started = runtime.factory.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(runtime.factory.mock.calls.length).toBeGreaterThan(started);
    expect(readAuthKey).not.toHaveBeenCalled();
  } finally { host.close(); }
});
