import { create } from "@bufbuild/protobuf";
import { BackgroundTaskSchema, EntityVersionSchema, SubagentCapabilitiesSchema, SubagentChildRunSchema, SubagentRunDetailSchema, SubagentRunSchema, SubagentTranscriptEntrySchema } from "@joko/contracts";
import { describe, expect, it, vi } from "vitest";
vi.mock("react-native", () => ({ AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) } }));
import { MobileDelegatedDetailReader, MobileDelegatedTasksReader, type MobileDelegatedControls, type MobileDelegatedReadClient } from "./mobile-delegated-reader";

const controls: MobileDelegatedControls = { authorityKey: "authority", surfaceOwnerKey: "owner", sessionId: "session", generation: 1n,
  canListBackground: true, canListRuns: true, canReadDetail: true, canReadTranscript: true };
const run = create(SubagentRunSchema, { subagentRunId: "run", sessionId: "session", version: { generation: 2n, revision: { value: 4n } },
  capabilities: { viewFullTranscript: true } });
function fixture(): MobileDelegatedReadClient {
  return { taskDelegatedControls: vi.fn(() => controls),
    loadTaskBackgroundTasks: vi.fn(async () => ({ tasks: [], nextPageToken: "" })),
    loadTaskDelegatedRuns: vi.fn(async () => ({ runs: [run], nextPageToken: "" })),
    loadTaskDelegatedDetail: vi.fn(async () => create(SubagentRunDetailSchema, { run })),
    loadTaskDelegatedTranscript: vi.fn(async () => ({ entries: [], nextPageToken: "", tailPageToken: "" })) };
}

describe("mobile delegated read ownership", () => {
  it("collects bounded list pages and retires cancelled or owner-drifted responses", async () => {
    const client = fixture();
    client.loadTaskBackgroundTasks = vi.fn(async (_key, token) => ({ tasks: [create(BackgroundTaskSchema, {
      backgroundTaskId: token ? "task-two" : "task-one", sessionId: "session" })], nextPageToken: token ? "" : "more" }));
    const reader = new MobileDelegatedTasksReader(client); reader.setOwner(controls); await reader.refresh();
    expect(reader.state.phase).toBe("ready"); expect(reader.state.entries).toHaveLength(3);
    expect(client.loadTaskBackgroundTasks).toHaveBeenNthCalledWith(2, "authority", "more", expect.any(AbortSignal));
    let finish!: (page: { runs: typeof run[]; nextPageToken: string }) => void;
    let signal!: AbortSignal;
    client.loadTaskDelegatedRuns = vi.fn((_key, _token, active) => { signal = active!; return new Promise<Awaited<ReturnType<MobileDelegatedReadClient["loadTaskDelegatedRuns"]>>>((resolve) => { finish = resolve; }); });
    const pending = reader.refresh(); reader.setOwner({ ...controls, authorityKey: "new", surfaceOwnerKey: "new-owner" });
    expect(signal.aborted).toBe(true); finish({ runs: [run], nextPageToken: "" }); await pending;
    expect(reader.state).toMatchObject({ ownerKey: "new-owner", phase: "idle", entries: [] });
  });

  it("reports cyclic pagination as a retriable error and keeps the already observed projection", async () => {
    const client = fixture(); const reader = new MobileDelegatedTasksReader(client); reader.setOwner(controls); await reader.refresh();
    client.loadTaskDelegatedRuns = vi.fn(async () => ({ runs: [run], nextPageToken: "cycle" }));
    await reader.refresh(); expect(reader.state.phase).toBe("error"); expect(reader.state.entries[0]?.run).toBe(run);
    client.loadTaskDelegatedRuns = vi.fn(async () => ({ runs: [run], nextPageToken: "" }));
    await reader.refresh(); expect(reader.state.phase).toBe("ready");
  });

  it("reads exact child generations, merges manual pages and uses a durable tail only after completion", async () => {
    const client = fixture(); const first = create(SubagentTranscriptEntrySchema, { entryId: "one", sequence: 1n, content: "First" });
    const second = create(SubagentTranscriptEntrySchema, { entryId: "two", sequence: 2n, content: "Second" });
    client.loadTaskDelegatedDetail = vi.fn(async () => create(SubagentRunDetailSchema, { run, children: [
      create(SubagentChildRunSchema, { childId: "old" }), create(SubagentChildRunSchema, { childId: "new", parentChildId: "old", identityAliases: ["old"] })
    ] }));
    client.loadTaskDelegatedTranscript = vi.fn(async (_key, _run, _child, token) => ({ entries: token ? [first, second] : [first],
      nextPageToken: token ? "" : "more", tailPageToken: "tail" }));
    const reader = new MobileDelegatedDetailReader(client, controls, run); await reader.refresh();
    expect(reader.state.nextPageToken).toBe("more"); await reader.loadMore();
    expect(reader.state.entries.map((entry) => entry.entryId)).toEqual(["one", "two"]);
    await reader.refresh(); expect(client.loadTaskDelegatedTranscript).toHaveBeenLastCalledWith("authority", "run", "", "tail", expect.any(AbortSignal));
    await reader.selectChild("old"); expect(reader.state.childId).toBe("new");
    expect(client.loadTaskDelegatedTranscript).toHaveBeenLastCalledWith("authority", "run", "new", "", expect.any(AbortSignal));
    await expect(reader.selectChild("other")).rejects.toThrow("generation");
  });

  it("enforces returned transcript capability and rejects stale detail while cancellation blocks late content", async () => {
    const client = fixture();
    client.loadTaskDelegatedDetail = vi.fn(async () => create(SubagentRunDetailSchema, { run: create(SubagentRunSchema, { ...run,
      capabilities: create(SubagentCapabilitiesSchema, { viewFullTranscript: false }) }), returnedResult: "Only summary" }));
    const reader = new MobileDelegatedDetailReader(client, controls, run); await reader.refresh();
    expect(reader.state.phase).toBe("ready"); expect(client.loadTaskDelegatedTranscript).not.toHaveBeenCalled();
    client.loadTaskDelegatedDetail = vi.fn(async () => create(SubagentRunDetailSchema, { run: create(SubagentRunSchema, { ...run,
      version: create(EntityVersionSchema, { generation: 1n, revision: { value: 100n } }) }) }));
    await reader.refresh(); expect(reader.state.phase).toBe("error");
    let finish!: (detail: ReturnType<typeof create<typeof SubagentRunDetailSchema>>) => void;
    client.loadTaskDelegatedDetail = vi.fn(() => new Promise<Awaited<ReturnType<MobileDelegatedReadClient["loadTaskDelegatedDetail"]>>>((resolve) => { finish = resolve; }));
    const loading = reader.refresh(); reader.retire(); finish(create(SubagentRunDetailSchema, { run })); await loading;
    expect(reader.state).toMatchObject({ phase: "idle", entries: [] }); expect(client.loadTaskDelegatedTranscript).not.toHaveBeenCalled();
  });
});
