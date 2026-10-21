import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext } from "@connectrpc/connect";
import { OperationalStore, PartnerStore } from "@joko/store";
import { FakeBackendAdapter, PI_LIKE_PROFILE } from "@joko/testkit";
import { ReadPartnerWorkingStatusRequestSchema, ListPartnersRequestSchema, PartnerWorkingPhase } from "@joko/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "./artifact-store.js";
import { OperationalArtifactRepository } from "./artifact-repository.js";
import { SessionHost } from "./session-host.js";
import { PartnerManager } from "./partner-manager.js";
import { PartnerWorkingStatusManager } from "./partner-working-status.js";
import { createPartnerConnectService } from "./partner-connect-service.js";
import type { AuxiliaryTextPlan, AuxiliaryTextRunOptions, AuxiliaryTextRunResult } from "./auxiliary-text-routing.js";
import { validateWorkingStatusCopy } from "./working-status-copy.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe("Partner public working facts and captions", () => {
  it("replays the whole persisted current turn, exposes authenticated facts, and never puts targets or output into captions", async () => {
    const f = await fixture();
    f.tool();
    f.store.transaction(() => {
      for (let i = 0; i < 1002; i++) f.append({ type: "status", key: `tick-${i}`, text: "Private status" });
    });
    expect(f.working.status(f.partner.id)).toMatchObject({ phase: "testing", runId: "run", attemptId: "attempt" });
    const service = createPartnerConnectService(f.partners, () => ({}), undefined, f.working);
    const ctx = { signal: new AbortController().signal } as HandlerContext;
    const listed = await service.listPartners(create(ListPartnersRequestSchema), ctx);
    expect(listed.partners?.[0]?.activity?.workingStatus).toMatchObject({ phase: PartnerWorkingPhase.TESTING, runId: "run" });
    const request = create(ReadPartnerWorkingStatusRequestSchema, { partnerId: f.partner.id, sessionId: f.session.id,
      generation: BigInt(f.session.binding.generation), runId: "run", attemptId: "attempt", phase: PartnerWorkingPhase.TESTING, locale: "en" });
    const result = await service.readPartnerWorkingStatus(request, ctx);
    expect(result.workingStatus?.caption).toBe("Running tests");
    expect(f.infer).toHaveBeenCalledOnce();
    const input = f.infer.mock.calls[0]![1];
    expect(JSON.parse(input.user)).toMatchObject({ language: "en", execution: "Running tests. Test names and results are unknown." });
    expect(input.user).not.toMatch(/private|workspace|package\.json|pnpm|description/iu);
    expect((await service.readPartnerWorkingStatus(create(ReadPartnerWorkingStatusRequestSchema, { ...request, attemptId: "old" }), ctx)).workingStatus)
      .toBeUndefined();
    const denied = createPartnerConnectService(f.partners, () => { throw new ConnectError("Denied", Code.Unauthenticated); }, undefined, f.working);
    await expect(denied.readPartnerWorkingStatus(request, ctx)).rejects.toMatchObject({ code: Code.Unauthenticated });
    expect(f.infer).toHaveBeenCalledOnce();
    f.working.dispose();
    const restarted = new PartnerWorkingStatusManager({ store: f.store, partners: f.partners, auxiliary: f.auxiliary });
    expect(restarted.status(f.partner.id)?.phase).toBe("testing"); restarted.dispose();
  });

  it("shares a phase attempt per language while phase, route, terminal and service retirement cancel obsolete results", async () => {
    const f = await fixture(); f.working.start(); f.tool();
    const pending: Array<{ signal: AbortSignal; resolve: (value: AuxiliaryTextRunResult) => void }> = [];
    f.infer.mockImplementation(async (_plan, options) => new Promise((resolve) => pending.push({ signal: options.signal!, resolve })));
    const first = f.working.status(f.partner.id)!;
    const a = f.working.readCaption(f.partner.id, first, "en"), b = f.working.readCaption(f.partner.id, first, "en");
    const c = f.working.readCaption(f.partner.id, first, "zh-TW");
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending[0]!.resolve({ status: "ok", text: "Running tests" });
    await expect(a).resolves.toMatchObject({ caption: "Running tests" }); await expect(b).resolves.toMatchObject({ caption: "Running tests" });
    expect(pending[1]!.signal.aborted).toBe(false);
    f.append({ type: "tool_result", callId: "call", name: "Bash", isError: true, output: "private failure result" });
    expect(pending[1]!.signal.aborted).toBe(true);
    pending[1]!.resolve({ status: "ok", text: "正在測試" }); await expect(c).resolves.toBeUndefined();
    expect(f.working.status(f.partner.id)?.phase).toBe("reviewing-checks");
    const feedback = f.working.status(f.partner.id)!;
    const late = f.working.readCaption(f.partner.id, feedback, "en");
    await vi.waitFor(() => expect(pending).toHaveLength(3));
    f.reviseRoute(); f.append({ type: "status", key: "route-change" });
    expect(pending[2]!.signal.aborted).toBe(true);
    pending[2]!.resolve({ status: "ok", text: "Reviewing tests" }); await expect(late).resolves.toBeUndefined();
    const ending = f.working.readCaption(f.partner.id, feedback, "en");
    await vi.waitFor(() => expect(pending).toHaveLength(4));
    f.append({ type: "done", outcome: "failed" });
    expect(f.working.status(f.partner.id)).toBeUndefined(); expect(pending[3]!.signal.aborted).toBe(true);
    pending[3]!.resolve({ status: "ok", text: "Reviewing tests" }); await expect(ending).resolves.toBeUndefined();
    f.working.dispose(); expect(f.working.status(f.partner.id)).toBeUndefined();
  });

  it("keeps factual fallback after unavailable or invalid captions and rejects completion, internals and subject invention", async () => {
    const f = await fixture(); f.tool();
    f.infer.mockResolvedValue({ status: "exhausted" });
    const status = f.working.status(f.partner.id)!;
    await expect(f.working.readCaption(f.partner.id, status, "en")).resolves.toMatchObject({ caption: "", phase: "testing" });
    await expect(f.working.readCaption(f.partner.id, status, "en")).resolves.toMatchObject({ caption: "" });
    expect(f.infer).toHaveBeenCalledOnce();
    for (const invalid of ["Tests completed", "测试已完成", "Testing /private/file", "mcp__test tests", "Testing 50 percent", "Working on it",
      "test\nresult", "test API", "Operation feedback for tests", "Tests " + "x".repeat(64)]) expect(validateWorkingStatusCopy(invalid, "testing")).toBeNull();
    expect(validateWorkingStatusCopy("Reviewing tests", "reviewing-checks")).toBe("Reviewing tests");
    expect(validateWorkingStatusCopy("正在查看檔案", "reading-file")).toBe("正在查看檔案");
    expect(validateWorkingStatusCopy("Running tests", "processing")).toBeNull();
  });
});

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "joko-working-"));
  const store = new OperationalStore(join(directory, "operational.db"));
  const partnerStore = new PartnerStore(join(directory, "partners.db"));
  const artifacts = new ArtifactStore({ rootDirectory: join(directory, "artifacts"), repository: new OperationalArtifactRepository(store), ingestRoots: [directory] });
  await artifacts.initialize();
  const profile = { ...PI_LIKE_PROFILE, capabilities: PI_LIKE_PROFILE.capabilities.map((value) => value.key === "permission.modes"
    ? { ...value, options: ["ask", "auto"] } : value) };
  const host = new SessionHost(store, artifacts, [new FakeBackendAdapter(profile)]); await host.initialize();
  const partners = new PartnerManager({ store: partnerStore, operationalStore: store, sessionHost: host,
    workspaceService: { register: async (input) => input, unregister: () => undefined }, homesRoot: join(directory, "partner-homes") });
  const partner = await partners.createPartner({ requestId: "creation-working", expectedDirectoryRevision: 1n,
    displayName: "Ada", avatar: "orbit", identitySource: "Private identity", templateId: "general", usesDirectoryDefaults: false,
    capabilities: { modelChain: [{ backendId: profile.id, providerId: "test", modelId: "text", effort: "medium", fastMode: false }], permissionMode: "ask", planMode: false } });
  const session = store.getSession(partner.canonicalSessionId!).descriptor;
  store.createRun({ id: "run", sessionId: session.id, source: "user", state: "running", createdAt: 100 });
  store.createAttempt({ id: "attempt", runId: "run", ordinal: 1, generation: session.binding.generation, startedAt: 100 });
  let epoch = 1, sequence = 0;
  const infer = vi.fn(async (_plan: AuxiliaryTextPlan, options: AuxiliaryTextRunOptions): Promise<AuxiliaryTextRunResult> => {
    const text = options.validate("Running tests"); return text ? { status: "ok", text } : { status: "exhausted" };
  });
  const auxiliary = { capture: (): AuxiliaryTextPlan => ({ models: [], revision: BigInt(epoch), runtimeRevision: String(epoch) }),
    isCurrent: (plan: AuxiliaryTextPlan) => plan.runtimeRevision === String(epoch), run: infer };
  const working = new PartnerWorkingStatusManager({ store, partners, auxiliary });
  const append = (payload: Parameters<OperationalStore["appendEvent"]>[0]["payload"]) => store.appendEvent({
    id: `fact-${++sequence}`, backendId: session.backendId, targetId: session.targetId, sessionId: session.id,
    runId: "run", attemptId: "attempt", generation: session.binding.generation, emittedAt: 100 + sequence, traceId: "working", payload
  });
  cleanups.push(async () => { working.dispose(); await host.dispose(); partnerStore.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, partners, partner, session, working, infer, auxiliary, append, reviseRoute: () => epoch++,
    tool: () => append({ type: "tool_start", callId: "call", name: "Bash", input: '{"command":"pnpm test /private/workspace/package.json","description":"Private objective"}' }) };
}
