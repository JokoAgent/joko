import { describe, expect, it } from "vitest";
import type { SessionView } from "../model.js";
import { sessionsForArchiveView, sessionsForSidebarStatus } from "./Sidebar.js";

describe("sidebar archive search scope", () => {
  it("keeps active and archived sessions in mutually exclusive views", () => {
    const active = session("active", false);
    const archived = session("archived", true);
    expect(sessionsForArchiveView([active, archived], false).map((item) => item.id)).toEqual(["active"]);
    expect(sessionsForArchiveView([active, archived], true).map((item) => item.id)).toEqual(["archived"]);
  });

  it("keeps both active and archived sessions in the all status", () => {
    const active = session("active", false);
    const archived = session("archived", true);
    expect(sessionsForSidebarStatus([active, archived], "all").map((item) => item.id)).toEqual(["active", "archived"]);
  });
});

function session(id: string, archived: boolean): SessionView {
  return {
    id,
    backendId: "pi",
    targetId: "target",
    name: id,
    state: "idle",
    permissionMode: "ask",
    planMode: false,
    fastMode: false,
    pinned: false,
    archived,
    generation: 0n,
    updatedAt: 1
  };
}
