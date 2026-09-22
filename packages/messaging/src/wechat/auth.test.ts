import { describe, expect, it, vi } from "vitest";

import { WeChatAuthorization } from "./auth.js";
import type { WeChatFetch } from "./api.js";

const qr = { qrcode: "private-qr", qrcode_img_content: "https://ilinkai.weixin.qq.com/qr/visible" };

function fakeFetch(statuses: readonly Record<string, unknown>[]): WeChatFetch {
  let statusIndex = 0;
  return vi.fn(async (input) => {
    const url = new URL(String(input));
    const body = url.pathname.endsWith("get_bot_qrcode") ? qr : statuses[statusIndex++] ?? { status: "wait" };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
}

describe("WeChat short-lived authorization", () => {
  it("keeps QR identity private, refreshes, verifies, and confirms only trusted origins", async () => {
    let now = 1_000;
    const fetch = fakeFetch([
      { status: "scaned" },
      { status: "expired" },
      { status: "need_verifycode" },
      { status: "confirmed", bot_token: "private-token", ilink_bot_id: "bot", ilink_user_id: "owner", baseurl: "https://ilinkai.weixin.qq.com/" }
    ]);
    const auth = new WeChatAuthorization({ fetch, now: () => now });
    const begun = await auth.begin();
    expect(begun).toMatchObject({ status: "waiting", qrCodeUrl: qr.qrcode_img_content, expiresAt: 301_000 });
    expect(JSON.stringify(begun)).not.toContain("private-qr");
    expect(await auth.begin()).toEqual(begun);
    expect(await auth.poll({ attemptId: begun.attemptId })).toMatchObject({ status: "scanned" });
    expect(await auth.poll({ attemptId: begun.attemptId })).toMatchObject({ status: "qr_refreshed" });
    expect(await auth.poll({ attemptId: begun.attemptId })).toMatchObject({ status: "verification_required", retry: false });
    const confirmed = await auth.poll({ attemptId: begun.attemptId, verificationCode: "123456" });
    expect(confirmed).toMatchObject({ status: "confirmed", credentials: { botId: "bot", userId: "owner", token: "private-token" } });
    expect(fetch).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ redirect: "manual" }));
    now = 302_000;
    await expect(auth.poll({ attemptId: begun.attemptId })).rejects.toMatchObject({ code: "cancelled" });
  });

  it("fences a cancelled in-flight confirmation and rejects an untrusted QR URL", async () => {
    let release!: (response: Response) => void;
    const fetch: WeChatFetch = vi.fn(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("get_bot_qrcode")) return new Response(JSON.stringify(qr));
      return await new Promise<Response>((resolve) => { release = resolve; });
    });
    const auth = new WeChatAuthorization({ fetch });
    const begun = await auth.begin();
    const pending = auth.poll({ attemptId: begun.attemptId });
    auth.cancel(begun.attemptId);
    release(new Response(JSON.stringify({ status: "confirmed", bot_token: "token", ilink_bot_id: "bot", ilink_user_id: "owner", baseurl: "https://ilinkai.weixin.qq.com/" })));
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });

    const unsafe = new WeChatAuthorization({ fetch: async () => new Response(JSON.stringify({ qrcode: "private", qrcode_img_content: "https://evil.test/qr" })) });
    await expect(unsafe.begin()).rejects.toMatchObject({ code: "invalid_input" });
  });
});
