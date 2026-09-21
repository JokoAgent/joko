import { describe, expect, it } from "vitest";

import {
  buildApnsMobilePushPayload,
  classifyApnsResponse
} from "./apns-mobile-push-provider.js";

describe("generic APNs mobile push provider", () => {
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
