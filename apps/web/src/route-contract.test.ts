import { describe, expect, it } from "vitest";

import { appRouteHash, newSessionDraftScope, routeFromHash } from "./controller.js";
import { sessionMessageDeepLink } from "./components/Timeline.js";

describe("public route contract", () => {
  it("round-trips route identities and canonical optional focus", () => {
    const routes = [
      { route: { kind: "projects", projectId: "project/one" } as const, hash: "#/projects/project%2Fone" },
      { route: { kind: "schedules", scheduleId: "schedule/one" } as const, hash: "#/schedules?focus=schedule%2Fone" },
      { route: { kind: "schedules" } as const, hash: "#/schedules" },
      { route: { kind: "newSession" } as const, hash: "#/tasks/new" },
      { route: { kind: "newSession", targetId: "project/one" } as const, hash: "#/tasks/new?target=project%2Fone" },
      { route: { kind: "newSession", dialogueBackendId: "agent/one" } as const, hash: "#/tasks/new?dialogue=agent%2Fone" }
    ];
    for (const { route, hash } of routes) {
      expect(appRouteHash(route)).toBe(hash);
      expect(routeFromHash(hash)).toEqual(route);
    }
    expect(routeFromHash("#/schedules?focus=%20")).toEqual({ kind: "schedules" });
    expect(routeFromHash("#/tasks/new?target=project&dialogue=agent")).toEqual({ kind: "newSession", targetId: "project" });
    expect(routeFromHash("#/tasks/session-1")).toEqual({ kind: "session", sessionId: "session-1" });
  });

  it("keeps message focus scoped to a task and strips stale URL state when sharing", () => {
    expect(routeFromHash("#/tasks/task%2Fone?event=event%2F9&message=entry%3A42")).toEqual({
      kind: "session",
      sessionId: "task/one",
      messageEventId: "event/9",
      messageId: "entry:42"
    });
    expect(routeFromHash("#/settings/providers?message=ignored")).toEqual({ kind: "settings" });
    expect(sessionMessageDeepLink(
      "task/one",
      "entry:42",
      "event/9",
      "https://joko.test/app?profile=local#/tasks/old"
    )).toBe("https://joko.test/app?profile=local#/tasks/task%2Fone?event=event%2F9&message=entry%3A42");
  });

  it("partitions delayed-create drafts by owner and connection", () => {
    const base = {
      id: "connection-a",
      deviceId: "device-a",
      name: "Desktop",
      origin: "https://node.example",
      serverId: "owner-a"
    };
    expect(newSessionDraftScope(base)).not.toBe(newSessionDraftScope({ ...base, id: "connection-b" }));
    expect(newSessionDraftScope(base)).not.toBe(newSessionDraftScope({ ...base, serverId: "owner-b" }));
    expect(newSessionDraftScope({ ...base, origin: "HTTPS://NODE.EXAMPLE/" })).toBe("owner-a\u0000connection-a");
  });
});
