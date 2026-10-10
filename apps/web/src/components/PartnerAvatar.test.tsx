// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppController } from "../controller.js";
import type { PartnerProfileView } from "../model.js";
import { PartnerAvatar, PartnerAvatarProvider } from "./PartnerAvatar.js";

const image = { sha256: "a".repeat(64), mimeType: "image/jpeg", byteLength: 4 } as const;
let root: Root; let container: HTMLDivElement;
const read = vi.fn();
const controller = { readPartnerAvatar: read } as unknown as AppController;
function partner(id = "partner"): PartnerProfileView {
  return { id, revision: 1n, avatar: image } as PartnerProfileView;
}
async function render(partners: readonly PartnerProfileView[], ownerKey = "owner") {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("IntersectionObserver", undefined);
  if (!root) { container = document.createElement("div"); document.body.append(container); root = createRoot(container); }
  await act(async () => root.render(<PartnerAvatarProvider controller={controller} ownerKey={ownerKey}>
    {partners.map((item) => <PartnerAvatar key={item.id} preset={item.avatar} partner={item} />)}
  </PartnerAvatarProvider>));
}
afterEach(async () => { if (root) await act(async () => root.unmount()); container?.remove(); root = undefined as unknown as Root;
  read.mockReset(); vi.unstubAllGlobals(); });

describe("Partner image ownership", () => {
  it("retires every in-flight request, including evicted entries, and ignores its late image", async () => {
    const signals: AbortSignal[] = []; const finish: Array<(uri: string) => void> = [];
    read.mockImplementation((_id, _revision, _image, signal) => { signals.push(signal);
      return new Promise<string>((resolve) => finish.push(resolve)); });
    await render(Array.from({ length: 33 }, (_, index) => partner(`partner-${index}`)));
    expect(signals).toHaveLength(33); await render([], "next-owner");
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    await act(async () => finish.forEach((resolve) => resolve("data:image/jpeg;base64,/9j/2w==")));
    expect(container.querySelector("img")).toBeNull();
  });

  it("retries a failed image on an explicitly refreshed profile without resending a successful read", async () => {
    read.mockRejectedValueOnce(new Error("offline")).mockResolvedValue("data:image/jpeg;base64,/9j/2w==");
    const original = partner(); await render([original]); expect(container.querySelector("img")).toBeNull();
    await render([{ ...original }]); expect(container.querySelector("img")?.getAttribute("src")).toBe("data:image/jpeg;base64,/9j/2w==");
    await render([{ ...original }]); expect(read).toHaveBeenCalledTimes(2);
  });
});
