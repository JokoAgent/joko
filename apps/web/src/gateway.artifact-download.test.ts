import { create } from "@bufbuild/protobuf";
import type { Transport } from "@connectrpc/connect";
import { GetBlobDownloadTicketResponseSchema, GetSnapshotResponseSchema, SnapshotSchema, TransferDirection } from "@joko/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOrchestratorGateway } from "./gateway.js";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("artifact download ownership", () => {
  it("copies through the original authenticated connection and captured native host, rejecting reconnect during ticket acquisition", async () => {
    const ticket = deferred<void>(); let waiting = false; let attempts = 0;
    const original = { capabilities: ["files.copy"], copyFile: vi.fn(async () => ({ status: "copied" })), cancelFileCopy: vi.fn(async () => undefined) };
    const replacement = { ...original, copyFile: vi.fn() };
    vi.stubGlobal("window", { jokoDesktop: original });
    const fetchBlob = vi.fn(async () => new Response("video bytes", { headers: { "content-type": "video/mp4" } })); vi.stubGlobal("fetch", fetchBlob);
    const gateway = await connected(async () => { if (++attempts === 1) { waiting = true; await ticket.promise; } });
    const owner = downloadDocument();
    Object.assign(owner.document.defaultView!, { document: owner.document, crypto: globalThis.crypto });
    const context = { ownerDocument: owner.document, signal: new AbortController().signal };
    const pending = gateway.copyArtifactFile("shared", "video.mp4", 11, context);
    const failed = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(waiting).toBe(true)); await gateway.connect(); ticket.resolve(); await failed;
    expect(fetchBlob).not.toHaveBeenCalled(); expect(original.copyFile).not.toHaveBeenCalled();
    const bytes = deferred<Blob>();
    fetchBlob.mockImplementationOnce(async () => ({ ok: true, blob: () => bytes.promise }) as Response);
    const next = gateway.copyArtifactFile("shared", "video.mp4", 11, context);
    await vi.waitFor(() => expect(fetchBlob).toHaveBeenCalledOnce());
    vi.stubGlobal("window", { jokoDesktop: replacement }); bytes.resolve(new Blob(["video bytes"], { type: "video/mp4" }));
    await expect(next).resolves.toEqual({ status: "copied" });
    expect(original.copyFile).toHaveBeenCalledOnce(); expect(replacement.copyFile).not.toHaveBeenCalled(); expect(owner.anchor.click).not.toHaveBeenCalled(); gateway.disconnect();
  });

  it("does not retrieve file bytes without a native capability or when the authoritative file size exceeds the copy budget", async () => {
    const gateway = await connected(); const owner = downloadDocument(); const context = { ownerDocument: owner.document, signal: new AbortController().signal };
    const fetchBlob = vi.fn(); vi.stubGlobal("fetch", fetchBlob);
    await expect(gateway.copyArtifactFile("shared", "video.mp4", 11, context)).resolves.toEqual({ status: "unavailable" });
    vi.stubGlobal("window", { jokoDesktop: { capabilities: ["files.copy"], copyFile: vi.fn(), cancelFileCopy: vi.fn() } });
    await expect(gateway.copyArtifactFile("shared", "video.mp4", 256 * 1024 * 1024 + 1, context)).resolves.toEqual({ status: "failed", reason: "capacity" });
    expect(fetchBlob).not.toHaveBeenCalled(); gateway.disconnect();
  });
  it("uses the triggering window for browser dispatch and releases its URL exactly once", async () => {
    vi.useFakeTimers();
    const owner = downloadDocument();
    const other = downloadDocument();
    vi.stubGlobal("document", other.document);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("artifact")));
    const gateway = await connected();
    await expect(gateway.downloadArtifact("shared", "notes.txt", { ownerDocument: owner.document, signal: new AbortController().signal })).resolves.toBe("dispatched");
    expect(owner.anchor).toMatchObject({ href: "blob:owned", download: "notes.txt", rel: "noopener" });
    expect(owner.anchor.click).toHaveBeenCalledOnce();
    expect(other.createUrl).not.toHaveBeenCalled();
    owner.events.dispatchEvent(new Event("pagehide"));
    vi.advanceTimersByTime(2_000);
    expect(owner.revokeUrl).toHaveBeenCalledExactlyOnceWith("blob:owned");
    gateway.disconnect();
  });

  it("aborts the old connection before a late ticket can fetch through a new connection", async () => {
    const ticket = deferred<void>();
    const fetchDownload = vi.fn(async () => new Response("artifact"));
    vi.stubGlobal("fetch", fetchDownload);
    let ticketSignal: AbortSignal | undefined;
    let attempts = 0;
    const gateway = await connected(async (signal) => {
      attempts += 1;
      if (attempts === 1) { ticketSignal = signal; await ticket.promise; }
    });
    const owner = downloadDocument();
    const old = gateway.downloadArtifact("shared", "old.txt", { ownerDocument: owner.document, signal: new AbortController().signal });
    const failure = expect(old).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(ticketSignal).toBeDefined());
    await gateway.connect();
    expect(ticketSignal!.aborted).toBe(true);
    ticket.resolve();
    await failure;
    expect(fetchDownload).not.toHaveBeenCalled();
    await expect(gateway.downloadArtifact("shared", "new.txt", { ownerDocument: owner.document, signal: new AbortController().signal })).resolves.toBe("dispatched");
    expect(fetchDownload).toHaveBeenCalledOnce();
    gateway.disconnect();
    owner.events.dispatchEvent(new Event("pagehide"));
  });

  it.each(["fetch", "blob", "bytes"] as const)("does not dispatch a native save when the owner retires during %s", async (stage) => {
    const gate = deferred<void>();
    let reached = false;
    const saveFile = vi.fn(async () => true);
    vi.stubGlobal("window", { jokoDesktop: { saveFile } });
    vi.stubGlobal("fetch", vi.fn(async (_input, init) => {
      if (stage === "fetch") { reached = true; await gate.promise; expect(init.signal.aborted).toBe(true); }
      return { ok: true, blob: async () => {
        if (stage === "blob") { reached = true; await gate.promise; }
        return { type: "text/plain", arrayBuffer: async () => {
          reached = true;
          if (stage === "bytes") await gate.promise;
          return new Uint8Array([1]).buffer;
        } };
      } };
    }));
    const gateway = await connected();
    const request = new AbortController();
    const owner = downloadDocument();
    const pending = gateway.downloadArtifact("shared", "notes.txt", { ownerDocument: owner.document, signal: request.signal });
    const failed = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(reached).toBe(true));
    request.abort();
    gate.resolve();
    await failed;
    expect(saveFile).not.toHaveBeenCalled();
    expect(owner.anchor.click).not.toHaveBeenCalled();
    gateway.disconnect();
  });

  it("preserves native cancellation and an already dispatched save's actual result without retrying unknown failures", async () => {
    const save = deferred<boolean>();
    const saveFile = vi.fn().mockResolvedValueOnce(false).mockImplementationOnce(() => save.promise).mockRejectedValueOnce(new Error("Save acknowledgement lost"));
    const untrustedSave = vi.fn();
    vi.stubGlobal("window", { jokoDesktop: { saveFile } });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("artifact")));
    const owner = downloadDocument();
    Object.assign(owner.document.defaultView!, { jokoDesktop: { saveFile: untrustedSave } });
    const gateway = await connected();
    const context = { ownerDocument: owner.document, signal: new AbortController().signal };
    await expect(gateway.downloadArtifact("shared", "notes.txt", context)).resolves.toBe("cancelled");
    const request = new AbortController();
    const pending = gateway.downloadArtifact("shared", "notes.txt", { ...context, signal: request.signal });
    await vi.waitFor(() => expect(saveFile).toHaveBeenCalledTimes(2));
    request.abort();
    save.resolve(true);
    await expect(pending).resolves.toBe("saved");
    await expect(gateway.downloadArtifact("shared", "notes.txt", context)).rejects.toThrow("Save acknowledgement lost");
    expect(saveFile).toHaveBeenCalledTimes(3);
    expect(untrustedSave).not.toHaveBeenCalled();
    expect(owner.anchor.click).not.toHaveBeenCalled();
    gateway.disconnect();
  });
});

async function connected(beforeTicket?: (signal: AbortSignal) => Promise<void>) {
  const transport = {
    unary: vi.fn(async (method: any, signal: AbortSignal) => {
      if (method.localName === "getBlobDownloadTicket") await beforeTicket?.(signal);
      const message = method.localName === "getSnapshot"
        ? create(GetSnapshotResponseSchema, { snapshot: create(SnapshotSchema, { generation: 1n, resumeCursor: { generation: 1n, sequence: 0n } }) })
        : create(GetBlobDownloadTicketResponseSchema, { ticket: { ticketId: "ticket", blobId: "shared", direction: TransferDirection.DOWNLOAD, relativeEndpoint: "/blob/shared" } });
      return { stream: false, service: method.parent, method, header: new Headers(), trailer: new Headers(), message };
    }),
    stream: vi.fn(async (method: any) => ({ stream: true, service: method.parent, method, header: new Headers(), trailer: new Headers(), message: idleStream() }))
  } as unknown as Transport;
  const gateway = createOrchestratorGateway({ id: "owner", deviceId: "device", name: "Node", origin: "https://node.example", serverId: "server" }, "test-key", {}, () => transport);
  await gateway.connect();
  return gateway;
}

function downloadDocument() {
  const events = new EventTarget();
  const anchor = { href: "", download: "", rel: "", click: vi.fn() };
  const createUrl = vi.fn(() => "blob:owned");
  const revokeUrl = vi.fn();
  const document = {
    createElement: vi.fn(() => anchor),
    defaultView: { closed: false, URL: { createObjectURL: createUrl, revokeObjectURL: revokeUrl }, setTimeout, clearTimeout, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) }
  } as unknown as Document;
  return { document, events, anchor, createUrl, revokeUrl };
}
async function* idleStream(): AsyncGenerator<never> { await new Promise<void>(() => undefined); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}
