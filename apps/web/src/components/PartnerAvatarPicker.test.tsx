// @vitest-environment jsdom
import { act, type JSX } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AvatarPicker } from "./PartnerAvatarPicker.js";
import type { Translator } from "./types.js";

let root: Root; let container: HTMLDivElement;
const changed = vi.fn(); const preparing = vi.fn(); const closeBitmap = vi.fn(); const draw = vi.fn();
async function render(ownerKey = "owner") {
  if (!root) { container = document.createElement("div"); document.body.append(container); root = createRoot(container); }
  await act(async () => root.render(<AvatarPicker value="orbit" ownerKey={ownerKey} options={["orbit", "spark"]}
    t={((key: string) => key) as Translator} onChange={changed} onPreparing={preparing} />));
}
async function select(file?: File) {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", { configurable: true, value: file ? [file] : [] });
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
}
function bitmap(): ImageBitmap { return { width: 500, height: 300, close: closeBitmap } as unknown as ImageBitmap; }
function canvas() {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: draw } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/jpeg;base64,/9j/2w==");
}
afterEach(async () => { if (root) await act(async () => root.unmount()); root = undefined as unknown as Root; container?.remove();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); changed.mockReset(); preparing.mockReset(); closeBitmap.mockReset(); draw.mockReset(); });

describe("Partner photo picker", () => {
  it("keeps file-dialog cancellation empty, crops the selected image and synchronously reports preparation", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("createImageBitmap", vi.fn(async () => bitmap())); canvas();
    await render(); await select(); expect(changed).not.toHaveBeenCalled(); expect(preparing).not.toHaveBeenCalled();
    await select(new File(["pixels"], "photo.png", { type: "image/png" }));
    expect(draw).toHaveBeenCalledWith(expect.anything(), 100, 0, 300, 300, 0, 0, 256, 256);
    expect(changed).toHaveBeenCalledWith({ base64: "/9j/2w==" });
    expect(preparing.mock.calls.slice(0, 2)).toEqual([[true], [false]]); expect(closeBitmap).toHaveBeenCalledOnce();
  });

  it("reports invalid files without changing the selected avatar and allows another selection", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); const decode = vi.fn(async () => bitmap()); vi.stubGlobal("createImageBitmap", decode); canvas();
    await render(); await select(new File(["bad"], "photo.svg", { type: "image/svg+xml" }));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("partners.avatarFailed");
    expect(changed).not.toHaveBeenCalled(); expect(decode).not.toHaveBeenCalled();
    await select(new File(["pixels"], "photo.jpg", { type: "image/jpeg" })); expect(changed).toHaveBeenCalledOnce();
  });

  it("retires decoding when the node changes or the document hides and still releases the bitmap", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); let finish!: (image: ImageBitmap) => void;
    vi.stubGlobal("createImageBitmap", vi.fn(() => new Promise<ImageBitmap>((resolve) => { finish = resolve; }))); canvas();
    await render(); await select(new File(["pixels"], "photo.png", { type: "image/png" }));
    await render("other-owner"); await act(async () => finish(bitmap())); expect(changed).not.toHaveBeenCalled(); expect(closeBitmap).toHaveBeenCalledOnce();
    await select(new File(["pixels"], "photo.png", { type: "image/png" }));
    await act(async () => window.dispatchEvent(new Event("pagehide"))); await act(async () => finish(bitmap()));
    expect(changed).not.toHaveBeenCalled(); expect(closeBitmap).toHaveBeenCalledTimes(2);
  });
});
