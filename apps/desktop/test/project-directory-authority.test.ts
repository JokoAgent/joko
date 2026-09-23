import { describe, expect, it } from "vitest";
import { isDesktopProjectDirectoryRequest, type DesktopManagedOrchestratorConnection } from "../src/channels.js";
import { projectDirectoryAuthorityMatches } from "../src/project-directory-authority.js";

const connection: DesktopManagedOrchestratorConnection = {
  profileId: "local-profile", deviceId: "device", serverId: "server", name: "Local service", origin: "http://127.0.0.1:7777"
};
const request = {
  profileId: connection.profileId, deviceId: connection.deviceId,
  serverId: connection.serverId, origin: connection.origin
};

describe("local project directory authority", () => {
  it("accepts only a bounded exact IPC identity", () => {
    expect(isDesktopProjectDirectoryRequest(request)).toBe(true);
    expect(isDesktopProjectDirectoryRequest({ ...request, extra: true })).toBe(false);
    expect(isDesktopProjectDirectoryRequest({ ...request, profileId: "other" })).toBe(true);
    expect(isDesktopProjectDirectoryRequest({ ...request, origin: "remote\0node" })).toBe(false);
    expect(isDesktopProjectDirectoryRequest({ ...request, serverId: "" })).toBe(false);
  });

  it("binds the path to the exact ready local service before and after the native picker", () => {
    const ready = { state: "ready" as const, connection };
    expect(projectDirectoryAuthorityMatches(request, ready, connection, connection, false)).toBe(true);
    expect(projectDirectoryAuthorityMatches(request, ready, connection, connection, true)).toBe(false);
    expect(projectDirectoryAuthorityMatches({ ...request, serverId: "remote" }, ready, connection, connection, false)).toBe(false);
    expect(projectDirectoryAuthorityMatches(request, ready, { ...connection, origin: "http://other" }, connection, false)).toBe(false);
    expect(projectDirectoryAuthorityMatches(request, ready, connection, { ...connection, name: "Replaced" }, false)).toBe(false);
    expect(projectDirectoryAuthorityMatches(request, { state: "starting" }, connection, connection, false)).toBe(false);
  });
});
