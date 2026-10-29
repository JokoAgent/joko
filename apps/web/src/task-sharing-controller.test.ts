import { describe, expect, it, vi } from "vitest";
import type { AppController } from "./controller.js";
import type { OrchestratorGateway } from "./gateway.js";
import type { LocalState } from "./local-state.js";
import { emptySnapshot, type BackendView, type ComposerDraft, type VoiceInputSessionView } from "./model.js";
import { createTaskSharingController } from "./task-sharing-controller.js";
import { canEditSharedQueueItem, guestBackend, taskSourceKey, type TaskSource } from "./task-sharing.js";

const source: Extract<TaskSource, { kind: "joined" }> = {
  kind: "joined", homeProfileId: "home", homeServerId: "home-server", homeOrigin: "https://home.example",
  joinId: "join", remoteServerId: "host", shareId: "share", memberId: "member", sessionId: "same-task",
  generation: 3n, memberGeneration: 4n
};
function fixture() {
  let current = true;
  const snapshot = emptySnapshot(), homeSnapshot = emptySnapshot();
  const home = { state: { snapshot: homeSnapshot, route: { kind: "session", sessionId: "same-task" } },
    send: vi.fn(), sendRichAnswer: vi.fn(), deleteSession: vi.fn(), saveDraft: vi.fn(),
    getVoiceInputCapabilities: vi.fn().mockResolvedValue({ available: true }),
    startVoiceInput: vi.fn().mockResolvedValue({ id: "recording" }),
    appendVoiceAudio: vi.fn().mockResolvedValue({ id: "recording" }),
    getVoiceInputSession: vi.fn().mockResolvedValue({ id: "recording", text: "Recognized" }),
    stopVoiceInput: vi.fn().mockResolvedValue({ id: "recording" }),
    cancelVoiceInput: vi.fn().mockResolvedValue({ id: "recording" })
  } as unknown as AppController;
  const gateway = { send: vi.fn().mockResolvedValue(undefined), sendRichAnswer: vi.fn().mockResolvedValue(true), getArtifactUrl: vi.fn() } as unknown as OrchestratorGateway;
  const local = { readDraft: vi.fn().mockResolvedValue(undefined), saveDraft: vi.fn().mockResolvedValue(undefined) } as unknown as LocalState;
  const access = { role: "guest" as const, memberId: "member", editableQueueItemIds: new Set(["mine"]) };
  const controller = createTaskSharingController({ home: () => home, gateway, source, snapshot: () => snapshot,
    access: () => access, current: () => current, local });
  return { controller, home, gateway, local, snapshot, retire: () => { current = false; }, access };
}
describe("shared task controller authority", () => {
  it("keeps rich-answer sends on the exact shared task and never falls through to Home", async () => {
    const f = fixture();
    expect(await f.controller.sendRichAnswer("same-task", 8n, "answer:button", "Continue")).toBe(true);
    expect(f.gateway.sendRichAnswer).toHaveBeenCalledExactlyOnceWith("same-task", 8n, "answer:button", "Continue");
    expect(f.home.sendRichAnswer).not.toHaveBeenCalled();
    await expect(f.controller.sendRichAnswer("other-task", 8n, "answer:button", "Continue")).rejects.toThrow("outside");
    f.retire();
    await expect(f.controller.sendRichAnswer("same-task", 8n, "answer:button", "Continue")).rejects.toThrow("changed");
    expect(f.gateway.sendRichAnswer).toHaveBeenCalledOnce();
  });
  it("keeps a same-id Home task outside the closed facade and isolates drafts by complete source", async () => {
    const f = fixture();
    await expect(f.controller.deleteSession("same-task", false)).rejects.toThrow("unavailable");
    expect(f.home.deleteSession).not.toHaveBeenCalled();
    await f.controller.send("same-task", { text: "Guest input" } as never, { expectedGeneration: 1n });
    expect(f.gateway.send).toHaveBeenCalledOnce(); expect(f.home.send).not.toHaveBeenCalled();
    await f.controller.saveDraft("same-task", { text: "Guest draft" } as ComposerDraft);
    expect(f.local.saveDraft).toHaveBeenCalledWith("host", `shared:${taskSourceKey(source)}`, "same-task", { text: "Guest draft" });
    expect(f.home.saveDraft).not.toHaveBeenCalled();
    await expect(f.controller.readDraft("different-task")).rejects.toThrow("outside");
    expect(f.controller.getArtifactUrl).toBe(f.controller.getArtifactUrl);
    expect(taskSourceKey({ ...source, memberGeneration: 5n })).not.toBe(taskSourceKey(source));
    expect(taskSourceKey({ ...source, homeServerId: "other-home" })).not.toBe(taskSourceKey(source));
  });
  it("uses only Home-owned voice APIs, fences late results, and retires exact recordings", async () => {
    const f = fixture();
    await f.controller.getVoiceInputCapabilities();
    const recording = await f.controller.startVoiceInput("request", "audio/webm");
    await f.controller.appendVoiceAudio(recording.id, 0n, new Uint8Array([1]), 10, true);
    expect(await f.controller.getVoiceInputSession(recording.id)).toMatchObject({ text: "Recognized" });
    expect(f.gateway.send).not.toHaveBeenCalled();
    expect(() => f.controller.getVoiceInputSession("foreign-recording")).toThrow("another input");
    f.retire(); f.controller.retireTaskSharingInput();
    expect(f.home.cancelVoiceInput).toHaveBeenCalledExactlyOnceWith("recording");
    expect(() => f.controller.getVoiceInputSession("recording")).toThrow("changed");
    expect(f.gateway.send).not.toHaveBeenCalled();
  });
  it("cancels a recording admitted after its source retired without adopting it", async () => {
    const f = fixture(); let resolve!: (value: VoiceInputSessionView) => void;
    vi.mocked(f.home.startVoiceInput).mockImplementation(() => new Promise(value => { resolve = value; }));
    const pending = f.controller.startVoiceInput("request", "audio/webm");
    f.retire(); resolve({ id: "late-recording" } as VoiceInputSessionView);
    await expect(pending).rejects.toThrow("changed");
    expect(f.home.cancelVoiceInput).toHaveBeenCalledExactlyOnceWith("late-recording");
  });
  it("intersects backend capabilities and restricts pending controls to the canonical author", () => {
    const f = fixture();
    const backend = { capabilities: new Map(["input.text", "turn.steer", "turn.abort", "model.switch", "session.delete", "objective.manage"].map(name => [name, { name, supported: true, options: [] }])) } as unknown as BackendView;
    const projected = guestBackend(backend);
    expect(projected.capabilities.get("input.text")?.supported).toBe(true);
    expect(projected.capabilities.get("turn.abort")?.supported).toBe(true);
    expect(projected.capabilities.get("session.delete")?.supported).toBe(false);
    expect(projected.capabilities.get("objective.manage")?.supported).toBe(false);
    expect(canEditSharedQueueItem(f.access, { id: "mine" } as never)).toBe(true);
    expect(canEditSharedQueueItem(f.access, { id: "other" } as never)).toBe(false);
  });
});
