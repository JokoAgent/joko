// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MobilePartnerAvatar, MobilePartnerAvatarProvider } from "./MobilePartnerAvatar";
import type { MobilePartnerAvatarIdentity, MobilePartnerAvatarTransport } from "./mobile-partner-avatar";

vi.mock("react-native", async () => {
  const React = await import("react");
  return { View: ({ children }: { children: ReactNode }) => React.createElement("div", {}, children),
    Image: ({ source }: { source: { uri: string } }) => React.createElement("img", { src: source.uri }),
    StyleSheet: { create: <T,>(styles: T) => styles } };
});
const colors = { background: "#fff", surface: "#fff", ink: "#111", muted: "#666", border: "#ddd", accent: "#f90", negative: "#b00", brandBackground: "#ffe" };
const image = { sha256: "a".repeat(64), mimeType: "image/jpeg", byteLength: 4 } as const;
const read = vi.fn(); let root: Root; let container: HTMLDivElement;
function partner(partnerId = "partner"): MobilePartnerAvatarIdentity { return { partnerId, revision: 1n, avatar: image }; }
async function render(partners: readonly MobilePartnerAvatarIdentity[], ownerKey = "owner") {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  if (!root) { container = document.createElement("div"); document.body.append(container); root = createRoot(container); }
  const transport: MobilePartnerAvatarTransport = { ownerKey, read };
  await act(async () => root.render(<MobilePartnerAvatarProvider transport={transport}>
    {partners.map((item) => <MobilePartnerAvatar key={item.partnerId} preset={item.avatar} partner={item} colors={colors} />)}
  </MobilePartnerAvatarProvider>));
}
afterEach(async () => { if (root) await act(async () => root.unmount()); container?.remove(); root = undefined as unknown as Root;
  read.mockReset(); vi.unstubAllGlobals(); });

describe("native Partner image ownership", () => {
  it("retires evicted pending image reads when the node changes and rejects late results", async () => {
    const signals: AbortSignal[] = []; const finish: Array<(uri: string) => void> = [];
    read.mockImplementation((_partner, signal) => { signals.push(signal);
      return new Promise<string>((resolve) => finish.push(resolve)); });
    await render(Array.from({ length: 33 }, (_, index) => partner(`partner-${index}`)));
    expect(signals).toHaveLength(33); await render([], "next-owner");
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    await act(async () => finish.forEach((resolve) => resolve("data:image/jpeg;base64,/9j/2w==")));
    expect(container.querySelector("img")).toBeNull();
  });

  it("recovers a failed read on refreshed profile data while reusing a confirmed image", async () => {
    read.mockRejectedValueOnce(new Error("offline")).mockResolvedValue("data:image/jpeg;base64,/9j/2w==");
    const original = partner(); await render([original]); expect(container.querySelector("img")).toBeNull();
    await render([{ ...original }]); expect(container.querySelector("img")?.getAttribute("src")).toBe("data:image/jpeg;base64,/9j/2w==");
    await render([{ ...original }]); expect(read).toHaveBeenCalledTimes(2);
  });
});
