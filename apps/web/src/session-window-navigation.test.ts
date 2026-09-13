import { describe, expect, it } from "vitest";
import { desktopSessionTaskLink, isSessionApplicationWindow, sessionTaskLink, validSessionWindowId } from "./session-window-navigation.js";

describe("session window navigation", () => {
  it("copies only the current entry and safe task hash", () => {
    expect(sessionTaskLink({ href: "https://app.example/client?auth=secret#/settings" } as Location, "task / one"))
      .toBe("https://app.example/client#/tasks/task%20%2F%20one");
  });

  it("builds a Joko-owned Desktop task handoff without the app resource origin", () => {
    expect(desktopSessionTaskLink("task / one", "machine / one"))
      .toBe("joko://task/task%20%2F%20one?profile=machine+%2F+one");
  });

  it("bounds identities before native or browser window dispatch", () => {
    expect(validSessionWindowId("task-1")).toBe(true);
    expect(validSessionWindowId(" task-1")).toBe(false);
    expect(validSessionWindowId("x".repeat(257))).toBe(false);
    expect(validSessionWindowId("task\n1")).toBe(false);
  });

  it("recognizes only the exact secondary-window bootstrap query", () => {
    expect(isSessionApplicationWindow({ search: "?sessionWindow=1&bootSession=task-1" } as Location)).toBe(true);
    expect(isSessionApplicationWindow({ search: "?sessionWindow=1&bootSession=task-1&auth=secret" } as Location)).toBe(false);
    expect(isSessionApplicationWindow({ search: "?sessionWindow=1&bootSession=task-1&bootSession=task-2" } as Location)).toBe(false);
  });
});
