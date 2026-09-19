import { create } from "@bufbuild/protobuf";
import { SessionMessageSearchMatchSchema } from "@joko/contracts";
import { describe, expect, it, vi } from "vitest";
import { collectSessionMessageSearchPages } from "./network";

function matches(count: number, offset = 0) {
  return Array.from({ length: count }, (_, index) => create(SessionMessageSearchMatchSchema, {
    sessionId: `session-${offset + index}`,
    eventId: `event-${offset + index}`
  }));
}

describe("mobile message-search paging", () => {
  it("collects every authoritative page in order", async () => {
    const readPage = vi.fn(async (pageToken: string) => pageToken === ""
      ? { matches: matches(100), nextPageToken: "page-2", totalSize: 101n }
      : { matches: matches(1, 100), nextPageToken: "", totalSize: 101n });

    const result = await collectSessionMessageSearchPages(readPage);

    expect(readPage.mock.calls).toEqual([[""], ["page-2"]]);
    expect(result).toHaveLength(101);
    expect(result[100]?.sessionId).toBe("session-100");
  });

  it("rejects repeated cursors instead of looping or accepting partial results", async () => {
    const readPage = vi.fn(async (pageToken: string) => ({
      matches: matches(100, pageToken === "" ? 0 : 100),
      nextPageToken: "repeat",
      totalSize: 201n
    }));

    await expect(collectSessionMessageSearchPages(readPage)).rejects.toThrow("invalid message-search page sequence");
    expect(readPage).toHaveBeenCalledTimes(2);
  });
});
