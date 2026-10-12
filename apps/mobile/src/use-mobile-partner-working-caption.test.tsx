// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useMobilePartnerWorkingCaption } from "./use-mobile-partner-working-caption";
import type { MobilePartnerWorkingStatus, MobilePartnerWorkingTransport } from "./mobile-partner-working";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { profilePartner } from "./test/mobile-partner-profile";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const initial: MobilePartnerWorkingStatus = { sessionId: "session", targetId: "target", backendId: "backend", generation: 2n,
  runId: "run", attemptId: "attempt", phase: "testing", turnKey: "turn" };
let root: Root | undefined, container: HTMLDivElement;
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; container?.remove(); });
function setup() { container = document.createElement("div"); document.body.append(container); root = createRoot(container); }
function Caption(props: { status?: MobilePartnerWorkingStatus; transport?: MobilePartnerWorkingTransport; locale: MobileSupportedLocale }) {
  return createElement("span", {}, useMobilePartnerWorkingCaption(profilePartner, props.status, props.locale, props.transport));
}
async function render(status?: MobilePartnerWorkingStatus, transport?: MobilePartnerWorkingTransport, locale: MobileSupportedLocale = "en") {
  await act(async () => root!.render(createElement(Caption, { status, transport, locale })));
}

describe("mobile Partner working captions", () => {
  it("keeps factual fallback, attempts only public subjects and uses current language and owner results", async () => {
    setup(); const read = vi.fn(async () => "Reviewing the tests");
    const transport = { ownerKey: "owner", read };
    await render({ ...initial, phase: "thinking" }, transport); expect(read).not.toHaveBeenCalled();
    await render(initial); expect(container.textContent).toBe("Running tests…");
    await render(initial, transport); expect(container.textContent).toBe("Reviewing the tests");
    expect(read).toHaveBeenCalledWith(profilePartner, initial, "en", expect.any(AbortSignal));
    await render(initial, { ...transport }); expect(read).toHaveBeenCalledOnce();
    read.mockResolvedValueOnce("正在測試"); await render(initial, transport, "zh-TW");
    expect(container.textContent).toBe("正在測試");
    read.mockRejectedValueOnce(new Error("unavailable")); await render(initial, { ...transport, ownerKey: "new-owner" });
    expect(container.textContent).toBe("Running tests…");
    await render(initial); expect(container.textContent).toBe("Running tests…");
  });

  it("aborts phase, turn, offline and unmount requests and never adopts their late captions", async () => {
    setup(); const pending: Array<{ signal: AbortSignal; resolve: (text: string) => void }> = [];
    const read = vi.fn(async (_partner, _status, _locale, signal: AbortSignal): Promise<string> => new Promise((resolve) => pending.push({ signal, resolve })));
    const transport = { ownerKey: "owner", read };
    await render(initial, transport);
    await render({ ...initial, phase: "reading-file" }, transport); expect(pending[0]!.signal.aborted).toBe(true);
    await act(async () => pending[0]!.resolve("Old tests")); expect(container.textContent).toBe("Reading files…");
    await render({ ...initial, runId: "next", turnKey: "next-turn" }, transport); expect(pending[1]!.signal.aborted).toBe(true);
    await render(initial); expect(pending[2]!.signal.aborted).toBe(true);
    await act(async () => { pending[1]!.resolve("Old file"); pending[2]!.resolve("Old turn tests"); });
    expect(container.textContent).toBe("Running tests…");
    await render(initial, transport); await render(undefined, transport); expect(pending[3]!.signal.aborted).toBe(true);
    await render(initial, transport); await act(async () => root!.unmount()); root = undefined;
    expect(pending[4]!.signal.aborted).toBe(true);
    await act(async () => pending[4]!.resolve("Unmounted tests")); expect(container.textContent).toBe("");
  });
});
