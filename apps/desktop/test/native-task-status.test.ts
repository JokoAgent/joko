import { describe, expect, it } from "vitest";

import type {
  DesktopNativeTaskStatusSettings,
  DesktopNativeTaskStatusSnapshot
} from "../src/channels.js";
import {
  defaultDesktopNativeTaskStatusSettings,
  isNativeTaskStatusAvailable,
  isNativeTaskStatusSupported,
  parseDesktopNativeTaskStatusSettings,
  parseDesktopNativeTaskStatusSnapshot,
  parseDesktopNativeTaskStatusVisibleSessionIds,
  projectDesktopNativeTaskStatusSurface
} from "../src/native-task-status.js";

describe("native task-status contract", () => {
  it("declares support only for macOS 14 and newer Darwin hosts", () => {
    expect(isNativeTaskStatusSupported("darwin", "23.0.0")).toBe(true);
    expect(isNativeTaskStatusSupported("darwin", "22.6.0")).toBe(false);
    expect(isNativeTaskStatusSupported("win32", "23.0.0")).toBe(false);
    expect(isNativeTaskStatusSupported("linux", "24.0.0")).toBe(false);
    expect(isNativeTaskStatusSupported("darwin", "unknown")).toBe(false);
  });

  it("keeps the feature opt-in and validates every display, layout, and sound field", () => {
    expect(defaultDesktopNativeTaskStatusSettings()).toEqual({
      enabled: false,
      display: { mode: "all" },
      layout: "normal",
      sounds: {
        enabled: true,
        sounds: {
          start: { type: "builtin", id: "startup-chime" },
          attention: { type: "builtin", id: "secret-chime" },
          complete: { type: "builtin", id: "gem-collect" },
          error: { type: "builtin", id: "error-buzz" },
          select: { type: "builtin", id: "none" }
        }
      }
    });
    const settings: DesktopNativeTaskStatusSettings = {
      enabled: true,
      display: {
        mode: "display",
        displayId: 42,
        displayName: "Studio Display",
        displayIndex: 1,
        displayBounds: { x: 1440, y: 0, width: 1920, height: 1080 }
      },
      layout: "compact",
      sounds: {
        enabled: false,
        sounds: {
          start: { type: "builtin", id: "none" },
          attention: { type: "builtin", id: "secret-chime" },
          complete: { type: "custom", path: "/tmp/done.m4a", name: "done.m4a" },
          error: { type: "builtin", id: "error-buzz" },
          select: { type: "builtin", id: "item-found" }
        }
      }
    };
    expect(parseDesktopNativeTaskStatusSettings(settings)).toEqual(settings);
    expect(() => parseDesktopNativeTaskStatusSettings({ ...settings, extra: true })).toThrow(TypeError);
    expect(() => parseDesktopNativeTaskStatusSettings({ ...settings, sounds: { ...settings.sounds, sounds: { ...settings.sounds.sounds, error: "yes" } } })).toThrow(TypeError);
  });

  it("projects interaction, terminal, and running tasks with deterministic expansion priority", () => {
    const snapshot = parseDesktopNativeTaskStatusSnapshot({
      ownerId: "owner",
      revision: "9",
      locale: "en",
      sessions: [
        session("run", "running", 30),
        session("done", "completed", 40),
        session("error", "error", 20),
        {
          ...session("ask", "interaction", 10),
          permission: { interactionId: "permission", generation: "4", allow: true, allowForSession: true, deny: true }
        }
      ]
    });
    expect(projectDesktopNativeTaskStatusSurface(snapshot)).toMatchObject({
      mode: "expanded",
      policy: "blocking",
      current: { sessionId: "ask" },
      counts: { total: 4, running: 1, interaction: 1, completed: 1, error: 1 }
    });
    expect(projectDesktopNativeTaskStatusSurface(snapshot, { manualExpanded: true })).toMatchObject({
      policy: "manual",
      sessions: [
        { sessionId: "ask" }, { sessionId: "error" }, { sessionId: "done" }, { sessionId: "run" }
      ]
    });
    const terminals = { ...snapshot, sessions: snapshot.sessions.filter((value) => value.phase !== "interaction") };
    expect(projectDesktopNativeTaskStatusSurface(terminals)).toMatchObject({ policy: "transient", current: { sessionId: "error" } });
    expect(projectDesktopNativeTaskStatusSurface(terminals, { suppressTransient: true })).toMatchObject({ policy: "peek", mode: "compact" });
  });

  it("rejects duplicate identities, malformed fences, and permission data on non-interaction tasks", () => {
    const base = {
      ownerId: "owner", revision: "1", locale: "en",
      sessions: [session("same", "running", 1)]
    };
    expect(() => parseDesktopNativeTaskStatusSnapshot({ ...base, revision: "01" })).toThrow(TypeError);
    expect(() => parseDesktopNativeTaskStatusSnapshot({ ...base, sessions: [...base.sessions, ...base.sessions] })).toThrow(TypeError);
    expect(() => parseDesktopNativeTaskStatusSnapshot({
      ...base,
      sessions: [{ ...base.sessions[0], permission: { interactionId: "p", generation: "1", allow: true, allowForSession: false, deny: true } }]
    })).toThrow(TypeError);
  });

  it("allows a cross-platform preview only in an unpackaged development process", () => {
    expect(isNativeTaskStatusAvailable({
      platform: "win32",
      osRelease: "10.0.0",
      packaged: false,
      developmentPreviewRequested: true
    })).toBe(true);
    expect(isNativeTaskStatusAvailable({
      platform: "linux",
      osRelease: "6.8.0",
      packaged: true,
      developmentPreviewRequested: true
    })).toBe(false);
    expect(isNativeTaskStatusAvailable({
      platform: "darwin",
      osRelease: "23.0.0",
      packaged: true,
      developmentPreviewRequested: false
    })).toBe(true);
  });

  it("validates a bounded unique visibility report independently from task snapshots", () => {
    expect(parseDesktopNativeTaskStatusVisibleSessionIds(["first", "second"])).toEqual(["first", "second"]);
    expect(() => parseDesktopNativeTaskStatusVisibleSessionIds(["same", "same"])).toThrow(TypeError);
    expect(() => parseDesktopNativeTaskStatusVisibleSessionIds(Array.from({ length: 9 }, (_, index) => `task-${index}`)))
      .toThrow(TypeError);
  });
});

function session(
  sessionId: string,
  phase: DesktopNativeTaskStatusSnapshot["sessions"][number]["phase"],
  updatedAt: number
): DesktopNativeTaskStatusSnapshot["sessions"][number] {
  return { sessionId, title: sessionId, detail: "", phase, activityLines: [], updatedAt };
}
