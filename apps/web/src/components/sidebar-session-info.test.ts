import { afterEach, describe, expect, it, vi } from "vitest";

import type { SessionView } from "../model.js";
import {
  compactSidebarTokenCount,
  formatSidebarCost,
  sidebarSessionInfoPieces
} from "./sidebar-session-info.js";

afterEach(() => vi.useRealTimers());

describe("sidebar session information", () => {
  it("projects only available SessionView fields in the user's selected order", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-25T12:00:00.000Z"));
    const session = fixture({
      updatedAt: Date.parse("2026-08-25T11:55:00.000Z"),
      codeHostPullRequests: [{
        key: "code.example/acme/widgets#42",
        host: "code.example",
        repositoryOwner: "acme",
        repositoryName: "widgets",
        number: 42,
        webUrl: "https://code.example/acme/widgets/pull/42"
      }],
      worktree: {
        leaseId: "lease",
        workspaceId: "workspace",
        workingPath: "D:/workspace",
        repositoryRoot: "D:/repository",
        branch: "feature/sidebar",
        sourceRef: "main",
        sourceCommit: "abc",
        sourceStrategy: "explicit",
        sourceRefreshed: false,
        state: "active",
        acquiredAt: 1,
        updatedAt: 1
      },
      usage: {
        inputTokens: 1_000_000,
        outputTokens: 430_000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 1_430_000,
        costMicros: 125_000,
        currencyCode: "USD"
      },
      context: {
        usedTokens: 90_000,
        contextWindow: 2_000_000,
        reservedTokens: 1_910_000,
        utilizationRatio: 0.045
      }
    });

    expect(sidebarSessionInfoPieces(session, ["cost", "time", "pr", "worktree", "tokens"], "en"))
      .toEqual([
        { field: "cost", text: "$0.125" },
        { field: "time", text: "5 minutes ago", dateTime: "2026-08-25T11:55:00.000Z" },
        { field: "pr", text: "" },
        { field: "worktree", text: "" },
        { field: "tokens", text: "1.4M" }
      ]);
  });

  it("omits unavailable optional facts instead of inventing placeholders", () => {
    expect(sidebarSessionInfoPieces(fixture(), ["pr", "worktree", "tokens", "cost"], "en")).toEqual([]);
  });

  it("formats bounded token and currency values compactly", () => {
    expect(compactSidebarTokenCount(999)).toBe("999");
    expect(compactSidebarTokenCount(1_400)).toBe("1.4K");
    expect(compactSidebarTokenCount(5_000_000)).toBe("5M");
    expect(formatSidebarCost(12.5, "CNY", "zh-CN")).toContain("12.5");
    expect(formatSidebarCost(Number.NaN, "not-a-code", "en")).toBeUndefined();
    expect(formatSidebarCost(0, "USD", "en")).toBeUndefined();
  });
});

function fixture(overrides: Partial<SessionView> = {}): SessionView {
  return {
    id: "session",
    backendId: "backend",
    targetId: "target",
    name: "Task",
    state: "idle",
    pinned: false,
    archived: false,
    generation: 0n,
    fastMode: false,
    permissionMode: "ask",
    planMode: false,
    updatedAt: 1,
    ...overrides
  };
}
