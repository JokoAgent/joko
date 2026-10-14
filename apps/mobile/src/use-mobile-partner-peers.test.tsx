// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MobilePartnerCatalog, MobilePartnerDirectoryProfile, MobilePartnerDirectoryTransport } from "./mobile-partner-directory";
import { useMobilePartnerPeers } from "./use-mobile-partner-peers";

const peer: MobilePartnerDirectoryProfile = {
  partnerId: "bea", revision: 4n, profileVersion: 3n, displayName: "Bea", description: "", avatar: "leaf",
  identitySource: "Product work", templateId: "general", lifecycle: "active", initializationState: "ready",
  invitationStage: "ready", homeTargetId: "target", canonicalSessionId: "session", usesDirectoryDefaults: true,
  capabilities: { modelChain: [{ backendId: "backend", providerId: "provider", modelId: "model", fastMode: false }],
    permissionMode: "ask", planMode: false }, createdAt: 1_000, updatedAt: 2_000,
  activity: { partnerId: "bea", unreadReplyCount: 0, artifactCount: 0, activeDelegationCount: 0,
    readThroughCursor: 0n, readUpdatedAt: 1_000 }
};
const catalog: MobilePartnerCatalog = { directory: { revision: 1n, activeCount: 1, archivedCount: 0,
  errorCount: 0, updatedAt: 2_000 }, partners: [peer] };
type Source = Pick<MobilePartnerDirectoryTransport, "ownerKey" | "list">;
let root: Root; let container: HTMLDivElement;
let result: ReturnType<typeof useMobilePartnerPeers>;
function Harness({ transport, task, enabled, candidates, retrySequence }: { transport?: Source; task?: string;
  enabled: boolean; candidates: readonly string[]; retrySequence: number }) {
  result = useMobilePartnerPeers(transport, task, candidates.length > 0, enabled, retrySequence);
  return <span>{candidates.map((id) => result.peers.get(id)?.displayName ?? "unknown").join(",")}</span>;
}
async function render(transport: Source | undefined, task = "task", enabled = true,
  candidates: readonly string[] = ["bea"], retrySequence = 0) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  if (!root) { container = document.createElement("div"); document.body.append(container); root = createRoot(container); }
  await act(async () => root.render(<Harness transport={transport} task={task} enabled={enabled}
    candidates={candidates} retrySequence={retrySequence} />));
}
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  container?.remove(); root = undefined as unknown as Root; vi.unstubAllGlobals();
});

describe("native Task private peer lookup", () => {
  it("reads one fresh full directory per Task without a request for every source card", async () => {
    const list = vi.fn(async () => catalog);
    await render({ ownerKey: "node", list }, "task", true, []);
    expect(list).not.toHaveBeenCalled();
    await render({ ownerKey: "node", list });
    expect(result.peers.get("bea")).toBe(peer);
    await render({ ownerKey: "node", list }, "task", true, ["bea", "other", "bea"]);
    expect(list).toHaveBeenCalledOnce(); expect(container.textContent).toBe("Bea,unknown,Bea");
    await render({ ownerKey: "node", list }, "next-task");
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("aborts an owner leaving the Task and rejects its late profiles while disabled", async () => {
    let finish!: (value: MobilePartnerCatalog) => void;
    const list = vi.fn((_signal: AbortSignal) => new Promise<MobilePartnerCatalog>((resolve) => { finish = resolve; }));
    await render({ ownerKey: "old-node", list });
    const signal = list.mock.calls[0]![0]; expect(result.loading).toBe(true);
    const nextList = vi.fn(async () => ({ ...catalog, partners: [{ ...peer, displayName: "Current Bea", revision: 5n }] }));
    await render({ ownerKey: "next-node", list: nextList });
    expect(signal.aborted).toBe(true); expect(container.textContent).toBe("Current Bea");
    await act(async () => finish(catalog));
    expect(container.textContent).toBe("Current Bea");
    await render({ ownerKey: "next-node", list: nextList }, "task", false);
    expect(result.peers.size).toBe(0); expect(container.textContent).toBe("unknown");
    expect(nextList).toHaveBeenCalledOnce();
    await render({ ownerKey: "pending-node", list });
    const pendingSignal = list.mock.calls[1]![0];
    await render({ ownerKey: "pending-node", list }, "task", false);
    expect(pendingSignal.aborted).toBe(true);
    await act(async () => finish(catalog));
    expect(result.peers.size).toBe(0); expect(container.textContent).toBe("unknown");
  });

  it("keeps failed lookups empty and retries explicitly without background or empty-candidate reads", async () => {
    const list = vi.fn<(signal: AbortSignal) => Promise<MobilePartnerCatalog>>()
      .mockRejectedValueOnce(new Error("offline")).mockResolvedValue(catalog);
    await render({ ownerKey: "node", list });
    expect(result.failed).toBe(true); expect(result.loading).toBe(false); expect(result.peers.size).toBe(0);
    await render({ ownerKey: "node", list }, "task", true, ["bea", "other"]);
    expect(list).toHaveBeenCalledOnce();
    await act(async () => result.retry());
    expect(result.failed).toBe(false); expect(result.peers.get("bea")?.revision).toBe(4n);
    expect(list).toHaveBeenCalledTimes(2);
    await render({ ownerKey: "node", list }, "task", false, ["bea"], 1);
    await render({ ownerKey: "node", list }, "task", true, [], 2);
    expect(list).toHaveBeenCalledTimes(2); expect(result.peers.size).toBe(0);
  });
});
