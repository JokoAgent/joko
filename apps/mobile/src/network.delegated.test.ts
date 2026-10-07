import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  GetSubagentRunRequestSchema, GetSubagentRunResponseSchema, ListBackgroundTasksRequestSchema, ListBackgroundTasksResponseSchema,
  ListSubagentRunsRequestSchema, ListSubagentRunsResponseSchema, ListSubagentTranscriptRequestSchema, ListSubagentTranscriptResponseSchema
} from "@joko/contracts";
import { describe, expect, it, vi } from "vitest";
import { mobileNetwork, type PairedCredential } from "./network";

const credential: PairedCredential = { profileId: "profile", origin: "https://node.example", serverId: "server", connectionId: "connection",
  deviceId: "phone", displayName: "Phone", authKey: "delegated-fixture-key" };
describe("mobile delegated generated RPC boundary", () => {
  it("sends authenticated exact Session/run/child/page requests and preserves durable continuation tokens", async () => {
    const paths: string[] = [];
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname; paths.push(path);
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${credential.authKey}`);
      const binary = new Uint8Array(init!.body as Uint8Array); const headers = { "content-type": "application/proto" };
      if (path.endsWith("/ListBackgroundTasks")) {
        expect(fromBinary(ListBackgroundTasksRequestSchema, binary)).toMatchObject({ sessionId: "session", page: { pageSize: 100, pageToken: "background-more" } });
        return new Response(toBinary(ListBackgroundTasksResponseSchema, create(ListBackgroundTasksResponseSchema, {
          backgroundTasks: [{ backgroundTaskId: "task", sessionId: "session" }], page: { nextPageToken: "background-next" }
        })), { headers });
      }
      if (path.endsWith("/ListSubagentRuns")) {
        expect(fromBinary(ListSubagentRunsRequestSchema, binary)).toMatchObject({ sessionId: "session", page: { pageSize: 100, pageToken: "runs-more" } });
        return new Response(toBinary(ListSubagentRunsResponseSchema, create(ListSubagentRunsResponseSchema, {
          runs: [{ subagentRunId: "run", sessionId: "session" }], page: { nextPageToken: "runs-next" }
        })), { headers });
      }
      if (path.endsWith("/GetSubagentRun")) {
        expect(fromBinary(GetSubagentRunRequestSchema, binary)).toMatchObject({ sessionId: "session", subagentRunId: "run" });
        return new Response(toBinary(GetSubagentRunResponseSchema, create(GetSubagentRunResponseSchema, {
          run: { run: { subagentRunId: "run", sessionId: "session" }, returnedResult: "Result" }
        })), { headers });
      }
      expect(fromBinary(ListSubagentTranscriptRequestSchema, binary)).toMatchObject({ sessionId: "session", subagentRunId: "run", childId: "child",
        page: { pageSize: 200, pageToken: "transcript-more" } });
      return new Response(toBinary(ListSubagentTranscriptResponseSchema, create(ListSubagentTranscriptResponseSchema, {
        entries: [{ entryId: "entry", sequence: 5n, childId: "child", content: "Reply" }], page: { nextPageToken: "transcript-next" }, tailPageToken: "tail"
      })), { headers });
    });
    try {
      expect(await mobileNetwork.listBackgroundTasks(credential, "session", "background-more")).toMatchObject({ nextPageToken: "background-next", tasks: [{ backgroundTaskId: "task" }] });
      expect(await mobileNetwork.listSubagentRuns(credential, "session", "runs-more")).toMatchObject({ nextPageToken: "runs-next", runs: [{ subagentRunId: "run" }] });
      expect(await mobileNetwork.getSubagentRun(credential, "session", "run")).toMatchObject({ returnedResult: "Result" });
      expect(await mobileNetwork.listSubagentTranscript(credential, "session", "run", "child", "transcript-more")).toMatchObject({ tailPageToken: "tail", nextPageToken: "transcript-next" });
      expect(paths).toEqual(["/joko.v1.SessionService/ListBackgroundTasks", "/joko.v1.SubagentService/ListSubagentRuns",
        "/joko.v1.SubagentService/GetSubagentRun", "/joko.v1.SubagentService/ListSubagentTranscript"]);
    } finally { fetcher.mockRestore(); }
  });

  it("rejects a cross-Session response and forwards native caller cancellation", async () => {
    const abort = new AbortController();
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      expect(init?.signal).toBeDefined();
      return new Response(toBinary(ListSubagentRunsResponseSchema, create(ListSubagentRunsResponseSchema, {
        runs: [{ subagentRunId: "run", sessionId: "other" }]
      })), { headers: { "content-type": "application/proto" } });
    });
    try {
      await expect(mobileNetwork.listSubagentRuns(credential, "session", "", abort.signal)).rejects.toThrow("another task");
      abort.abort();
      await expect(mobileNetwork.listSubagentRuns(credential, "session", "", abort.signal)).rejects.toThrow();
      expect(fetcher).toHaveBeenCalledOnce();
    } finally { fetcher.mockRestore(); }
  });
});
