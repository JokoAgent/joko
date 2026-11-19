import { generateKeyPairSync } from "node:crypto";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import {
  ApnsMobilePushProvider,
  buildApnsMobilePushPayload,
  classifyApnsResponse
} from "./apns-mobile-push-provider.js";

const { connect } = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("node:http2", () => ({ connect }));

describe("generic APNs mobile push provider", () => {
  it("sends the same bounded collapse identity in the HTTP/2 header and APNs thread payload", async () => {
    const response = new EventEmitter();
    const end = vi.fn(() => { response.emit("response", { ":status": 200 }); response.emit("end"); });
    const stream = Object.assign(response, { end, destroy: vi.fn() });
    const request = vi.fn(() => stream);
    connect.mockReturnValueOnce(Object.assign(new EventEmitter(), { request, close: vi.fn(), destroy: vi.fn() }));
    const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ format: "pem", type: "pkcs8" });
    const provider = new ApnsMobilePushProvider({ teamId: "team", keyId: "key", privateKeyPem: String(key), topic: "app.joko.mobile" });
    const collapseId = "a".repeat(32);
    const input = { environment: "apns_sandbox", token: "fixture-token", locale: "en", kind: "done", intent: "joko://task/session-1", collapseId } as const;
    await expect(provider.send(input, new AbortController().signal)).resolves.toEqual({ outcome: "delivered", code: "APNS_200" });
    expect(request).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ "apns-collapse-id": collapseId }));
    expect(end).toHaveBeenCalledExactlyOnceWith(buildApnsMobilePushPayload(input));
    expect(JSON.parse(buildApnsMobilePushPayload(input).toString("utf8"))).toMatchObject({ aps: { "thread-id": collapseId } });
  });

  it.each([
    ["en", "Task finished", "Task needs your reply", "Task needs attention"],
    ["zh-CN", "任务已完成", "任务需要你的回复", "任务需要处理"],
    ["zh-TW", "任務已完成", "任務需要你的回覆", "任務需要處理"],
    ["ja", "タスクが完了しました", "タスクに返信が必要です", "タスクの確認が必要です"],
    ["ko", "작업이 완료되었습니다", "작업에 답변이 필요합니다", "작업을 확인해야 합니다"]
  ] as const)("builds a bodyless %s alert with only its canonical public intent", (locale, done, awaiting, error) => {
    for (const [kind, title] of Object.entries({ done, awaiting, error }) as Array<[
      "done" | "awaiting" | "error",
      string
    ]>) {
      const payload = JSON.parse(buildApnsMobilePushPayload({
        environment: "apns_production",
        token: "private-device-token",
        locale,
        kind,
        intent: "joko://task/task-1?message=message-1&event=event-1"
      }).toString("utf8")) as Record<string, unknown>;
      expect(payload).toEqual({
        aps: { alert: { title } },
        intent: "joko://task/task-1?message=message-1&event=event-1"
      });
      expect(JSON.stringify(payload)).not.toContain("private-device-token");
      expect(Object.keys(payload)).toEqual(["aps", "intent"]);
    }
  });

  it("retries only definitive transient rejection and never replays ambiguous transport state", () => {
    expect(classifyApnsResponse(200, undefined)).toEqual({ outcome: "delivered", code: "APNS_200" });
    expect(classifyApnsResponse(410, "Unregistered")).toEqual({
      outcome: "invalid_registration",
      code: "APNS_UNREGISTERED"
    });
    expect(classifyApnsResponse(400, "BadDeviceToken")).toEqual({
      outcome: "invalid_registration",
      code: "APNS_BAD_TOKEN"
    });
    expect(classifyApnsResponse(429, "TooManyRequests")).toEqual({ outcome: "retry", code: "APNS_429" });
    expect(classifyApnsResponse(503, "Shutdown")).toEqual({ outcome: "retry", code: "APNS_5XX" });
    expect(classifyApnsResponse(403, "InvalidProviderToken")).toEqual({
      outcome: "failed",
      code: "APNS_REJECTED"
    });
    expect(classifyApnsResponse(0, undefined)).toEqual({
      outcome: "unknown",
      code: "APNS_RESPONSE_UNKNOWN"
    });
  });
});
