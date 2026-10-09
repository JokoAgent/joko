import { describe, expect, it } from "vitest";
import { boundNativeSessionPreview } from "./native-session-preview.js";
import { buildPartnerWorkbenchDigest, derivePartnerWorkbenchTaskState, derivePartnerWorkbenchAutomationState, partnerWorkbenchGroup } from "./partner-workbench.js";

describe("workbench task projection", () => {
  it("keeps actual waiting, running, queued and interrupted states separate from judgments", () => {
    expect(derivePartnerWorkbenchTaskState({ waiting: true })).toBe("waiting");
    expect(derivePartnerWorkbenchTaskState({ running: true })).toBe("running");
    expect(derivePartnerWorkbenchTaskState({ queued: true })).toBe("queued");
    expect(derivePartnerWorkbenchTaskState({ interrupted: true })).toBe("stopped");
    expect(derivePartnerWorkbenchTaskState({})).toBe("done");
    expect(partnerWorkbenchGroup("running", "session", "done")).toBe("running");
    expect(partnerWorkbenchGroup("stopped", "session", "idea")).toBe("waiting");
    expect(partnerWorkbenchGroup("done", "external", "unfinished")).toBe("todo");
    expect(partnerWorkbenchGroup("done", "item", "done")).toBe("todo");
    expect(derivePartnerWorkbenchAutomationState({ enabled: true })).toBe("automation");
    expect(derivePartnerWorkbenchAutomationState({ enabled: false })).toBe("stopped");
    expect(derivePartnerWorkbenchAutomationState({ enabled: false, running: true })).toBe("running");
  });

  it("preserves the first user purpose and newest readable text within the transcript budget", () => {
    const head = [{ role: "user" as const, text: "Original purpose", at: 1 }];
    const tail = Array.from({ length: 12 }, (_, index) => ({ role: "assistant" as const, text: `${index}: ${"x".repeat(1_500)}`, at: index + 2 }));
    const preview = boundNativeSessionPreview(head, tail, false);
    expect(preview.truncated).toBe(true);
    expect(preview.messages.reduce((sum, row) => sum + row.text.length, 0)).toBeLessThanOrEqual(4_000);
    expect(preview.messages[0]?.text).toBe("Original purpose");
    expect(preview.messages.at(-1)?.text).toContain("11:");
    const digest = buildPartnerWorkbenchDigest(preview.messages, preview.messages);
    expect(digest.purpose).toBe("Original purpose");
    expect(digest.recent).toHaveLength(3);
    expect(digest.recent.every((row) => row.text.length <= 300)).toBe(true);
  });
});
