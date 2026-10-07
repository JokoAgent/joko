import { describe, expect, it } from "vitest";
import { isWorkGroup, mobileWorkContains, mobileWorkExpansionKeys, mobileWorkItems, type MobileWorkCandidate } from "./mobile-work-projection";

function row(id: string, kind: string, at: number, extra: Partial<MobileWorkCandidate> = {}): MobileWorkCandidate {
  return { id, kind, eventId: id, sequence: BigInt(at), startedAtMs: at, text: id, completed: true, ownerScope: "owner", runScope: "run", ...extra };
}

describe("mobile work grouping", () => {
  it("folds thinking and tools before the sealed answer while preserving message and tool identities", () => {
    const user = row("user", "user", 1);
    const thought = row("thought", "thinking", 2);
    const tool = row("tool", "tool", 3);
    const progress = row("progress", "assistant", 4);
    const tool2 = row("tool2", "tool", 5);
    const answer = row("answer", "assistant", 6, { turnFinal: true });
    const items = mobileWorkItems([user, thought, tool, progress, tool2, answer], false);
    expect(items.map((item) => item.kind)).toEqual(["user", "work", "assistant"]);
    expect(items[0]).toBe(user);
    expect(items[2]).toBe(answer);
    const group = items[1]!;
    if (!isWorkGroup(group)) throw new Error("Work group is missing.");
    expect(group.children.map((item) => item.kind)).toEqual(["work", "assistant", "work"]);
    const activities = group.children[0]!;
    if (!isWorkGroup(activities)) throw new Error("Activity group is missing.");
    expect(activities.children).toEqual([thought, tool]);
    expect(group.children[1]).toBe(progress);
    expect(group).not.toHaveProperty("durationMs");
    expect(mobileWorkContains(group, (item) => item === tool)).toBe(true);
    expect(mobileWorkExpansionKeys(items, (item) => item === tool)).toEqual([group.id, activities.id]);
    expect(mobileWorkExpansionKeys(items, (item) => item.id === "absent")).toEqual([]);
  });

  it("splits user, compact, history gap and owner boundaries without turning sealed history active", () => {
    const first = row("first", "thinking", 1);
    const gap = row("gap", "thinking", 2_000_000);
    expect(mobileWorkItems([first, gap], false)).toHaveLength(2);
    const compact = row("compact", "status", 2, { compactBoundary: true });
    expect(mobileWorkItems([first, compact, row("next", "tool", 3)], true).map((item) => item.kind)).toEqual(["work", "status", "work"]);
    expect(mobileWorkItems([first, row("other", "thinking", 2, { ownerScope: "other" })], true)).toHaveLength(2);
    const answer = row("answer", "assistant", 2, { turnFinal: true });
    const next = row("next", "thinking", 3);
    const items = mobileWorkItems([first, answer, next], true);
    expect(items.map((item) => item.kind)).toEqual(["work", "assistant", "work"]);
    expect(items[0]?.completed).toBe(true);
  });

  it("leaves typed live-task parent rows inline while completed ordinary work can be archived", () => {
    const thought = row("thinking", "thinking", 1);
    const persistent = row("task-parent", "tool", 2, { persistentTask: true });
    const ordinary = row("ordinary", "tool", 3);
    const answer = row("answer", "assistant", 4, { turnFinal: true });
    const items = mobileWorkItems([thought, persistent, ordinary, answer], false);
    expect(items.map((item) => item.kind)).toEqual(["work", "tool", "work", "assistant"]);
    expect(items[1]).toBe(persistent);
    expect(items[3]).toBe(answer);
  });
});
