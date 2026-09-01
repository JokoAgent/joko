import { describe, expect, it, vi } from "vitest";
import {
  createPiAutoReviewer,
  type AutoReviewCompletion,
  type AutoReviewControl,
  type AutoReviewRuntimeContext,
  type PiAutoReviewRequest,
} from "./auto-review.js";
import { MANAGED_AUTO_REVIEW_RUNTIME_SOURCE } from "./auto-review-runtime.js";

const workspaceRoot = process.platform === "win32" ? "C:\\work\\repo" : "/work/repo";
const readOnlyRoot = process.platform === "win32" ? "C:\\reference" : "/reference";
const systemTarget = process.platform === "win32" ? "C:\\Windows\\System32\\drivers\\etc\\hosts" : "/etc/hosts";

function completion(value: unknown, usage?: unknown): AutoReviewCompletion {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    stopReason: "stop",
    usage,
  };
}

function fixture(result: AutoReviewCompletion | ((ctx: { signal: AbortSignal }) => Promise<AutoReviewCompletion>) = completion({ verdict: "allow", reason: "Necessary and scoped." })) {
  let control: AutoReviewControl = {
    policyGeneration: 1,
    permissionMode: "auto",
    approvedRoots: [
      { path: workspaceRoot, access: "read_write" },
      { path: readOnlyRoot, access: "read_only" },
    ],
  };
  let intent = "Run the relevant checks for this change.";
  let model = { provider: "fake", id: "current", api: "openai-responses" };
  const complete = vi.fn(async (_model: unknown, _context: unknown, options: { signal: AbortSignal }) =>
    typeof result === "function" ? result(options) : result);
  const ctx: AutoReviewRuntimeContext = {
    cwd: workspaceRoot,
    get model() {
      return model;
    },
    modelRegistry: { complete },
    sessionManager: {
      getBranch: () => [{ type: "message", message: { role: "user", content: [{ type: "text", text: intent }] } }],
    },
  };
  const request = (toolName: string, input: unknown): PiAutoReviewRequest => ({
    ctx,
    event: { toolName, input },
    control,
    workspaceRoot,
    readControl: () => control,
  });
  return {
    ctx,
    complete,
    request,
    setControl(next: AutoReviewControl) {
      control = next;
    },
    setIntent(next: string) {
      intent = next;
    },
    setModel(next: typeof model) {
      model = next;
    },
  };
}

describe("Pi auto-review deterministic policy", () => {
  it("green-lights scoped reads, workspace writes, and narrow read-only commands", () => {
    const reviewer = createPiAutoReviewer({ platform: process.platform });
    const fx = fixture();
    expect(reviewer.classify(fx.request("read", { path: "src/main.ts" }))).toMatchObject({ tier: "green" });
    expect(reviewer.classify(fx.request("write", { path: "src/main.ts", content: "ok" }))).toMatchObject({ tier: "green" });
    expect(reviewer.classify(fx.request("bash", { command: "git status --short" }))).toMatchObject({ tier: "green" });
    expect(reviewer.classify(fx.request("write", { path: `${readOnlyRoot}/notes.txt`, content: "no" }))).toMatchObject({ tier: "gray" });
  });

  it.each([
    ["credential", "read", { path: `${workspaceRoot}/.env` }],
    ["system path", "write", { path: systemTarget, content: "changed" }],
    ["system path in shell", "bash", { command: process.platform === "win32" ? "type C:\\Windows\\win.ini" : "cat /etc/hosts" }],
    ["system path through shell redirection", "bash", { command: process.platform === "win32" ? "echo x > C:\\Windows\\win.ini" : "printf x > /etc/hosts" }],
    ["macOS canonical system path", "bash", { command: "cat /private/etc/hosts" }],
    ["destruction", "bash", { command: "rm -rf build" }],
    ["PowerShell destruction", "bash", { command: "Remove-Item build -Recurse" }],
    ["destructive tool", "mcp__database__drop_table", { table: "temporary_results" }],
    ["SSRF", "mcp__http__fetch", { url: "http://169.254.169.254/latest/meta-data" }],
    ["bare SSRF host", "mcp__http__fetch", { host: "169.254.169.254" }],
    ["IPv4-mapped IPv6 SSRF host", "mcp__http__fetch", { host: "::ffff:127.0.0.1" }],
    ["secret field", "mcp__cloud__deploy", { api_token: "not-forwarded" }],
    ["Basic-auth URL", "mcp__http__fetch", { url: "https://user:basic-secret@example.com/data" }],
    ["common provider token", "mcp__issues__search", { query: "ghp_abcdefghijklmnopqrstuvwxyz123456" }],
  ])("keeps %s on the deterministic red line", async (_label, toolName, input) => {
    const reviewer = createPiAutoReviewer({ platform: process.platform });
    const fx = fixture();
    const decision = await reviewer.review(fx.request(toolName, input));
    expect(decision).toMatchObject({ verdict: "ask", tier: "red", source: "policy" });
    expect(fx.complete).not.toHaveBeenCalled();
  });

  it("removes the entire credential-bearing argument body before an interaction can be persisted", async () => {
    const reviewer = createPiAutoReviewer({ platform: process.platform });
    const fx = fixture();
    const request = fx.request("write", {
      path: `${workspaceRoot}/.env.local`,
      content: "DATABASE_PASSWORD=unique-credential-value",
    });
    const classification = reviewer.classify(request);
    expect(classification).toMatchObject({ tier: "red" });
    expect(classification.evidence).toContain("REDACTED_CREDENTIAL_BEARING_INPUT");
    expect(classification.evidence).not.toContain("unique-credential-value");
    await expect(reviewer.review(request)).resolves.toMatchObject({ verdict: "ask", source: "policy" });
  });
});

describe("Pi current-model gray-zone review", () => {
  it.each([
    [{ verdict: "allow", reason: "The requested check is scoped." }, { verdict: "allow" }],
    [{ verdict: "block", reason: "The command is broader than needed.", safeAlternative: "Run the affected package test only." }, { verdict: "block", safeAlternative: "Run the affected package test only." }],
    [{ verdict: "ask", reason: "This publishes externally." }, { verdict: "ask" }],
  ])("accepts the strict %s schema", async (modelDecision, expected) => {
    const reviewer = createPiAutoReviewer();
    const fx = fixture(completion(modelDecision, {
      input: 12,
      output: 4,
      cacheRead: 2,
      cacheWrite: 0,
      totalTokens: 18,
      secretProviderTrace: "must-not-escape",
    }));
    const decision = await reviewer.review(fx.request("bash", { command: "pnpm --filter @joko/core test" }));
    expect(decision).toMatchObject({ ...expected, tier: "gray", source: "reviewer" });
    expect(decision.usage).toEqual({ input: 12, output: 4, cacheRead: 2, cacheWrite: 0, totalTokens: 18 });
    expect(JSON.stringify(decision)).not.toContain("secretProviderTrace");
  });

  it("sends only latest intent, bounded redacted arguments, and approved roots", async () => {
    const reviewer = createPiAutoReviewer();
    const fx = fixture();
    const oversized = "x".repeat(12_000);
    await reviewer.review(fx.request("mcp__issues__search", { query: oversized, nested: { harmless: "value" } }));
    expect(fx.complete).toHaveBeenCalledOnce();
    const [, modelContext, modelOptions] = fx.complete.mock.calls[0] ?? [];
    const serialized = JSON.stringify(modelContext);
    const reviewPrompt = JSON.parse((modelContext as { messages: [{ content: [{ text: string }] }] }).messages[0].content[0].text) as Record<string, unknown>;
    expect(serialized.length).toBeLessThan(8_000);
    expect(serialized).toContain("Run the relevant checks for this change.");
    expect(serialized).toContain("mcp__issues__search");
    expect(reviewPrompt.workspace).toBe(workspaceRoot);
    expect(serialized).not.toContain(oversized);
    expect(modelOptions).toMatchObject({ maxTokens: 256, cacheRetention: "none" });
  });

  it("preserves long POSIX roots without treating path separators as high-entropy content", async () => {
    const reviewer = createPiAutoReviewer({ platform: "darwin" });
    const fx = fixture();
    const longWorkspace = "/private/var/folders/df/djsxfhc17x95674wsm_g8s980000gn/T/joko-auto-review-workspace-bswErK";
    fx.setControl({
      policyGeneration: 1,
      permissionMode: "auto",
      approvedRoots: [{ path: longWorkspace, access: "read_write" }],
    });

    await reviewer.review({
      ...fx.request("mcp__issues__search", { query: "x".repeat(64) }),
      workspaceRoot: longWorkspace,
    });

    const [, modelContext] = fx.complete.mock.calls[0] ?? [];
    const reviewPrompt = JSON.parse((modelContext as { messages: [{ content: [{ text: string }] }] }).messages[0].content[0].text) as {
      boundedArguments: { arguments?: { query?: string } };
      workspace: string;
      roots: Array<{ path: string; access: string }>;
    };
    expect(reviewPrompt.workspace).toBe(longWorkspace);
    expect(reviewPrompt.roots).toEqual([{ path: longWorkspace, access: "read_write" }]);
    expect(reviewPrompt.boundedArguments.arguments?.query).toBe("[REDACTED_HIGH_ENTROPY_VALUE]");
  });

  it("sends every approved root to the reviewer instead of dropping roots after a fixed window", async () => {
    const reviewer = createPiAutoReviewer();
    const fx = fixture();
    const approvedRoots = Array.from({ length: 40 }, (_, index) => ({
      path: `${workspaceRoot}${process.platform === "win32" ? "\\" : "/"}root-${index}`,
      access: index % 2 === 0 ? "read_write" as const : "read_only" as const
    }));
    fx.setControl({ policyGeneration: 1, permissionMode: "auto", approvedRoots });

    await reviewer.review(fx.request("mcp__issues__search", { query: "find the scoped issue" }));

    const [, modelContext] = fx.complete.mock.calls[0] ?? [];
    const reviewPrompt = JSON.parse((modelContext as { messages: [{ content: [{ text: string }] }] }).messages[0].content[0].text) as {
      roots: Array<{ path: string; access: string }>;
    };
    expect(reviewPrompt.roots).toHaveLength(40);
    expect(reviewPrompt.roots.at(-1)).toEqual(approvedRoots.at(-1));
  });

  it("rejects malformed, extra-key, and unsafe block responses", async () => {
    for (const response of [
      { content: [{ type: "text", text: "allow" }], stopReason: "stop" },
      completion({ verdict: "allow", reason: "ok", confidence: 1 }),
      completion({ verdict: "block", reason: "no alternative" }),
    ]) {
      const reviewer = createPiAutoReviewer();
      const fx = fixture(response);
      await expect(reviewer.review(fx.request("bash", { command: "pnpm test" }))).resolves.toMatchObject({
        verdict: "ask",
        unavailable: true,
        source: "system",
      });
    }
  });

  it("uses a bounded policy/model/intent/action cache and invalidates on state changes", async () => {
    const reviewer = createPiAutoReviewer({ cacheSize: 2 });
    const fx = fixture();
    const first = fx.request("bash", { command: "pnpm test" });
    expect((await reviewer.review(first)).source).toBe("reviewer");
    expect((await reviewer.review(first)).source).toBe("cache");
    expect(fx.complete).toHaveBeenCalledTimes(1);

    fx.setIntent("Run a different check.");
    expect((await reviewer.review(fx.request("bash", { command: "pnpm test" }))).source).toBe("reviewer");
    fx.setModel({ provider: "fake", id: "replacement", api: "openai-responses" });
    expect((await reviewer.review(fx.request("bash", { command: "pnpm test" }))).source).toBe("reviewer");
    fx.setControl({ ...first.control, policyGeneration: 2 });
    expect((await reviewer.review(fx.request("bash", { command: "pnpm test" }))).source).toBe("reviewer");
    expect(fx.complete).toHaveBeenCalledTimes(4);
    expect(reviewer.cacheSize).toBeLessThanOrEqual(2);
  });

  it("keys cache entries with a full secure argument digest, not bounded reviewer evidence", async () => {
    const reviewer = createPiAutoReviewer();
    const fx = fixture();
    const base = Object.fromEntries(Array.from({ length: 50 }, (_unused, index) => [`field_${String(index).padStart(2, "0")}`, "same"]));
    const first = { ...base, field_49: "alpha" };
    const second = { ...base, field_49: "beta" };
    expect(reviewer.classify(fx.request("mcp__catalog__lookup", first)).evidence)
      .toBe(reviewer.classify(fx.request("mcp__catalog__lookup", second)).evidence);
    await reviewer.review(fx.request("mcp__catalog__lookup", first));
    await reviewer.review(fx.request("mcp__catalog__lookup", second));
    expect(fx.complete).toHaveBeenCalledTimes(2);
  });

  it("discards a pending result after the authoritative policy changes", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const fx = fixture(async () => {
      await pending;
      return completion({ verdict: "allow", reason: "Would otherwise allow." });
    });
    const reviewer = createPiAutoReviewer();
    const review = reviewer.review(fx.request("bash", { command: "pnpm test" }));
    fx.setControl({
      policyGeneration: 2,
      permissionMode: "ask",
      approvedRoots: [{ path: workspaceRoot, access: "read_write" }],
    });
    release();
    await expect(review).resolves.toMatchObject({ verdict: "block", code: "policy_changed", source: "system" });
  });

  it("fails closed on abort and hands timeout/unavailability to manual confirmation with one notice", async () => {
    const timeoutFx = fixture(({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const notify = vi.fn();
    const reviewer = createPiAutoReviewer({ timeoutMs: 5 });
    const timedRequest = { ...timeoutFx.request("bash", { command: "pnpm test" }), notifyUnavailable: notify };
    await expect(reviewer.review(timedRequest)).resolves.toMatchObject({ verdict: "ask", code: "reviewer_timeout", unavailable: true });
    await expect(reviewer.review(timedRequest)).resolves.toMatchObject({ verdict: "ask", unavailable: true });
    expect(notify).toHaveBeenCalledTimes(1);

    const controller = new AbortController();
    const abortFx = fixture(({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const aborted = reviewer.review({ ...abortFx.request("bash", { command: "pnpm test" }), ctx: { ...abortFx.ctx, signal: controller.signal } });
    controller.abort();
    await expect(aborted).resolves.toMatchObject({ verdict: "block", code: "reviewer_aborted", source: "system" });
  });

  it("does not label reviewer failure as a user denial", async () => {
    const notify = vi.fn();
    const fx = fixture(async () => { throw new Error("provider secret diagnostic"); });
    const decision = await createPiAutoReviewer().review({
      ...fx.request("bash", { command: "pnpm test" }),
      notifyUnavailable: notify,
    });
    expect(decision).toMatchObject({ verdict: "ask", code: "reviewer_unavailable", unavailable: true });
    expect(decision.reason.toLowerCase()).not.toContain("denied");
    expect(JSON.stringify(decision)).not.toContain("provider secret diagnostic");
    expect(notify).toHaveBeenCalledWith("Auto-review is unavailable; this action requires manual confirmation.");
  });
});

describe("provisioned auto-review runtime", () => {
  it("loads as standalone ESM and calls a fake provider through the latest Pi context shape", async () => {
    const url = `data:text/javascript;base64,${Buffer.from(MANAGED_AUTO_REVIEW_RUNTIME_SOURCE).toString("base64")}`;
    const runtime = await import(url) as { createPiAutoReviewer: typeof createPiAutoReviewer };
    const reviewer = runtime.createPiAutoReviewer();
    const fx = fixture(completion({ verdict: "allow", reason: "Fake provider approved the scoped check." }));
    const decision = await reviewer.review(fx.request("bash", { command: "pnpm test" }));
    expect(decision).toMatchObject({ verdict: "allow", source: "reviewer", tier: "gray" });
    expect(fx.complete).toHaveBeenCalledOnce();
  });
});
