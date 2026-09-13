import { execFile, spawn } from "node:child_process";
import { createHash, createPublicKey, generateKeyPairSync, randomUUID, verify } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  managedSubagentSessionKey,
  reconcileManagedSubagentAuthHomes,
  stopAndRemoveManagedSubagentRuns
} from "./durable-subagent-runs.js";
import {
  MANAGED_SUBAGENT_RUNNER_FILE_NAME,
  MANAGED_SUBAGENT_RUNNER_SOURCE
} from "./managed-subagent-runner-source.js";
import { mkdtemp } from "./test-paths.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 })));
});

describe("managed detached subagent runner", () => {
  it("is valid dependency-free CommonJS", async () => {
    const directory = await temporaryDirectory();
    const runnerPath = join(directory, MANAGED_SUBAGENT_RUNNER_FILE_NAME);
    await writeFile(runnerPath, MANAGED_SUBAGENT_RUNNER_SOURCE, { encoding: "utf8", mode: 0o600 });
    await expect(execFileAsync(process.execPath, ["--check", runnerPath], { windowsHide: true })).resolves.toMatchObject({ stderr: "" });
  });

  it("redacts credential-bearing top-level failures before writing stderr", async () => {
    const directory = await temporaryDirectory();
    const runnerPath = join(directory, MANAGED_SUBAGENT_RUNNER_FILE_NAME);
    const secret = `runner-top-level-${randomUUID()}`;
    const injectedFailureSource = MANAGED_SUBAGENT_RUNNER_SOURCE.replace(
      "main().catch(function (error) {",
      'Promise.reject(new Error(process.env["JOKO_RUNNER_TEST_SECRET"])).catch(function (error) {'
    );
    expect(injectedFailureSource).not.toBe(MANAGED_SUBAGENT_RUNNER_SOURCE);
    await writeFile(runnerPath, injectedFailureSource, { encoding: "utf8", mode: 0o600 });

    let failure: unknown;
    try {
      await execFileAsync(process.execPath, [runnerPath], {
        windowsHide: true,
        env: {
          ...process.env,
          JOKO_PI_SUBAGENT_CREDENTIAL_ENV_NAMES: JSON.stringify(["JOKO_RUNNER_TEST_SECRET"]),
          JOKO_RUNNER_TEST_SECRET: secret
        }
      });
    } catch (error) {
      failure = error;
    }

    const stderr = typeof failure === "object" && failure !== null && "stderr" in failure
      ? String((failure as { readonly stderr?: unknown }).stderr ?? "")
      : "";
    expect(stderr).toContain("[REDACTED]");
    expect(stderr).not.toContain(secret);
  });

  it("continues after its launcher exits, redacts inherited credentials, and publishes a stable native session", { timeout: 20_000 }, async () => {
    const fixture = await createRunnerFixture({ settleDelayMs: 900 });
    const launcherResult = await execFileAsync(process.execPath, [fixture.launcherPath], {
      windowsHide: true,
      timeout: 5_000,
      env: {
        ...process.env,
        JOKO_PI_SUBAGENT_CREDENTIAL_ENV_NAMES: JSON.stringify(["JOKO_RUNNER_TEST_SECRET"]),
        JOKO_PI_SECRET_ENV_NAMES: JSON.stringify(["JOKO_RUNNER_TEST_SECRET"]),
        JOKO_RUNNER_TEST_SECRET: fixture.secret
      }
    });
    const launcherPid = Number.parseInt(launcherResult.stdout.trim(), 10);
    expect(Number.isSafeInteger(launcherPid) && launcherPid > 0).toBe(true);
    const status = await waitForTerminalStatus(fixture.statusPath, 12_000);
    expect(status).toMatchObject({
      state: "completed",
      productSessionId: fixture.productSessionId,
      taskId: fixture.taskId,
      nativeSessionId: fixture.nativeSessionId,
      usage: { totalTokens: 9 },
      toolUses: 2
    });
    expect(String(status.nativeSessionPath)).toContain(fixture.nativeSessionId);
    const claimedConfigText = await readFile(fixture.configPath, "utf8");
    const claimedConfig = JSON.parse(claimedConfigText) as Record<string, unknown>;
    expect(claimedConfig).not.toHaveProperty("initialMessage");
    expect(claimedConfig).not.toHaveProperty("profile");
    expect(claimedConfig).not.toHaveProperty("child");
    const persisted = [
      claimedConfigText,
      await readFile(fixture.statusPath, "utf8"),
      await readFile(join(fixture.runDirectory, "result.json"), "utf8"),
      await readFile(join(fixture.runDirectory, "transcript.jsonl"), "utf8")
    ].join("\n");
    expect(persisted).not.toContain(fixture.secret);
    expect(persisted).toContain("[REDACTED]");
  });

  it("resumes the matching durable session from a prior run in the same product session", { timeout: 20_000 }, async () => {
    const fixture = await createRunnerFixture({ settleDelayMs: 50 });
    const priorRunDirectory = join(dirname(fixture.runDirectory), randomUUID());
    const resumeSessionPath = join(priorRunDirectory, "sessions", `${fixture.nativeSessionId}.jsonl`);
    await mkdir(dirname(resumeSessionPath), { recursive: true, mode: 0o700 });
    await writeFile(resumeSessionPath, "{}\n", { encoding: "utf8", mode: 0o600 });
    await configureResumeFixture(fixture, resumeSessionPath);

    await expect(execFileAsync(process.execPath, [fixture.runnerPath, fixture.configPath], {
      cwd: fixture.runDirectory,
      windowsHide: true,
      timeout: 10_000,
      env: {
        ...process.env,
        JOKO_PI_SUBAGENT_CREDENTIAL_ENV_NAMES: "[]",
        JOKO_PI_SECRET_ENV_NAMES: "[]"
      }
    })).resolves.toMatchObject({ stderr: "" });

    expect(await waitForTerminalStatus(fixture.statusPath, 2_000)).toMatchObject({
      state: "completed",
      nativeSessionId: fixture.nativeSessionId,
      nativeSessionPath: resumeSessionPath
    });

    const chained = await createRunnerFixture({
      settleDelayMs: 50,
      root: fixture.root,
      productSessionId: fixture.productSessionId,
      nativeSessionId: fixture.nativeSessionId
    });
    await configureResumeFixture(chained, resumeSessionPath);
    await expect(runFixtureRunner(chained)).resolves.toMatchObject({ stderr: "" });
    expect(await waitForTerminalStatus(chained.statusPath, 2_000)).toMatchObject({
      state: "completed",
      nativeSessionId: fixture.nativeSessionId,
      nativeSessionPath: resumeSessionPath
    });
  });

  it("rejects escaped and aliased durable resume sessions", async () => {
    const escaped = await createRunnerFixture({ settleDelayMs: 50 });
    const outsideDirectory = await temporaryDirectory();
    const escapedSessionPath = join(outsideDirectory, `${escaped.nativeSessionId}.jsonl`);
    await writeFile(escapedSessionPath, "{}\n", { encoding: "utf8", mode: 0o600 });
    await configureResumeFixture(escaped, escapedSessionPath);

    await expect(runFixtureRunner(escaped)).rejects.toThrow(/resume session identity mismatch/iu);

    const aliased = await createRunnerFixture({ settleDelayMs: 50 });
    const aliasedRunDirectory = join(dirname(aliased.runDirectory), randomUUID());
    const outsideSessions = await temporaryDirectory();
    const aliasedSessionPath = join(aliasedRunDirectory, "sessions", `${aliased.nativeSessionId}.jsonl`);
    await mkdir(aliasedRunDirectory, { recursive: true, mode: 0o700 });
    await writeFile(join(outsideSessions, `${aliased.nativeSessionId}.jsonl`), "{}\n", { encoding: "utf8", mode: 0o600 });
    await symlink(outsideSessions, dirname(aliasedSessionPath), process.platform === "win32" ? "junction" : "dir");
    await configureResumeFixture(aliased, aliasedSessionPath);

    await expect(runFixtureRunner(aliased)).rejects.toThrow(/resume session identity mismatch/iu);
  });

  it("acquires a fenced native credential lease without persisting auth in the durable run", { timeout: 20_000 }, async () => {
    const fixture = await createRunnerFixture({ settleDelayMs: 150, nativeAuthRequired: true });
    const credential = {
      type: "oauth",
      access: `runner-native-access-${randomUUID()}`,
      refresh: `runner-native-refresh-${randomUUID()}`,
      expires: Date.now() + 60_000
    };
    const bridgeToken = `runner-bridge-${randomUUID()}-${randomUUID()}`.replace(/-/gu, "_");
    const recoveryProof = Buffer.from(randomUUID().replace(/-/gu, "").padEnd(32, "0")).toString("base64url").slice(0, 43);
    const privateKeyCanary = fixture.runnerPrivateKey?.export({ format: "der", type: "pkcs8" }).toString("base64url");
    if (privateKeyCanary === undefined) throw new Error("native runner fixture key is unavailable");
    const actions: string[] = [];
    let releasedCredential: unknown;
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        expect(request.headers.authorization).toBe(`Bearer ${bridgeToken}`);
        expect(request.headers["x-joko-pi-generation"]).toBe("1");
        expect(body).toMatchObject({
          generation: 1,
          runnerProductGeneration: 1,
          sessionId: fixture.productSessionId,
          targetId: "target-native",
          providerId: "native-provider",
          catalogGeneration: 7,
          runId: fixture.runId
        });
        expectValidRunnerProof(body, fixture.runnerPublicKey);
        if (body.action === "acquire") {
          expect(body.recovery).toMatchObject({
            runnerPid: expect.any(Number)
          });
          expect(body.recoveryProof).toBeUndefined();
        } else {
          expect(body.recovery).toBeUndefined();
          expect(body.recoveryProof).toBe(recoveryProof);
        }
        actions.push(String(body.action));
        if (body.action === "release") releasedCredential = body.credential;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(body.action === "acquire"
          ? { active: true, validForMs: 15_000, credential, recoveryProof }
          : { active: false }));
      });
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(0, "127.0.0.1", resolveListen);
    });
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("native lease fixture did not bind TCP");
      await startNativeRunner(fixture, bridgeToken, address.port);
      const status = await waitForTerminalStatus(fixture.statusPath, 10_000);
      expect(status).toMatchObject({ state: "completed" });
      expect(actions).toEqual(["acquire", "release"]);
      expect(releasedCredential).toEqual({
        ...credential,
        access: `refreshed-${credential.access}`,
        refresh: `refreshed-${credential.refresh}`
      });
      await expect(readFile(join(fixture.childHome, "auth.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      const persisted = [
        await readFile(fixture.configPath, "utf8"),
        await readFile(fixture.statusPath, "utf8"),
        await readFile(join(fixture.runDirectory, "result.json"), "utf8"),
        await readFile(join(fixture.runDirectory, "transcript.jsonl"), "utf8")
      ].join("\n");
      expect(persisted).not.toContain(credential.access);
      expect(persisted).not.toContain(credential.refresh);
      expect(persisted).not.toContain(`refreshed-${credential.access}`);
      expect(persisted).not.toContain(`refreshed-${credential.refresh}`);
      expect(persisted).not.toContain(bridgeToken);
      expect(persisted).not.toContain(recoveryProof);
      expect(persisted).toContain("[REDACTED]");
      const durableTree = await readTextTree(fixture.runDirectory);
      for (const canary of [credential.access, credential.refresh, `refreshed-${credential.access}`,
        `refreshed-${credential.refresh}`, bridgeToken, recoveryProof, privateKeyCanary]) {
        expect(durableTree).not.toContain(canary);
      }
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

  it("retries an acquire whose committed response was dropped without changing its runner fence", { timeout: 20_000 }, async () => {
    const fixture = await createRunnerFixture({
      settleDelayMs: 150,
      nativeAuthRequired: true,
      refreshNativeAuth: false
    });
    const credential = { type: "oauth", access: `drop-access-${randomUUID()}`, refresh: `drop-refresh-${randomUUID()}` };
    const bridgeToken = `drop-bridge-${randomUUID()}-${randomUUID()}`.replace(/-/gu, "_");
    const recoveryProof = createHash("sha256").update(randomUUID()).digest("base64url");
    const actions: string[] = [];
    let firstAcquire: Record<string, unknown> | undefined;
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        const action = String(body.action);
        actions.push(action);
        if (action === "acquire" && firstAcquire === undefined) {
          firstAcquire = body;
          request.socket.destroy();
          return;
        }
        if (action === "acquire") {
          expect(body).toMatchObject({
            action: firstAcquire!.action,
            generation: firstAcquire!.generation,
            runnerProductGeneration: firstAcquire!.runnerProductGeneration,
            sessionId: firstAcquire!.sessionId,
            targetId: firstAcquire!.targetId,
            providerId: firstAcquire!.providerId,
            catalogGeneration: firstAcquire!.catalogGeneration,
            runId: firstAcquire!.runId,
            runnerFence: firstAcquire!.runnerFence,
            recovery: firstAcquire!.recovery
          });
          expect((body.runnerProof as Record<string, unknown>).reservationId)
            .toBe((firstAcquire!.runnerProof as Record<string, unknown>).reservationId);
          expect((body.runnerProof as Record<string, unknown>).runnerPid)
            .toBe((firstAcquire!.runnerProof as Record<string, unknown>).runnerPid);
          expect(body.runnerProof).not.toEqual(firstAcquire!.runnerProof);
          expect(body.recoveryProof).toBeUndefined();
        } else {
          expect(body.recovery).toBeUndefined();
          expect(body.recoveryProof).toBe(recoveryProof);
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(action === "acquire"
          ? { active: true, validForMs: 15_000, credential, recoveryProof }
          : { active: false }));
      });
    });
    await listen(server, 0);
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("native lease fixture did not bind TCP");
      await startNativeRunner(fixture, bridgeToken, address.port);
      await expect(waitForTerminalStatus(fixture.statusPath, 12_000)).resolves.toMatchObject({ state: "completed" });
      expect(actions).toEqual(["acquire", "acquire", "release"]);
      expect(await readTextTree(fixture.runDirectory)).not.toContain(recoveryProof);
    } finally {
      await closeServer(server);
    }
  });

  it("uses relative lease lifetime across hour-scale service and runner clock skew", { timeout: 20_000 }, async () => {
    for (const clockSkewMs of [-3_600_000, 3_600_000]) {
      const fixture = await createRunnerFixture({
        settleDelayMs: 150,
        nativeAuthRequired: true,
        refreshNativeAuth: false
      });
      const credential = { type: "oauth", access: `skew-access-${randomUUID()}`, refresh: `skew-refresh-${randomUUID()}` };
      const bridgeToken = `skew-bridge-${randomUUID()}-${randomUUID()}`.replace(/-/gu, "_");
      const recoveryProof = createHash("sha256").update(randomUUID()).digest("base64url");
      const server = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        request.on("end", () => {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(body.action === "acquire"
            ? { active: true, validForMs: 15_000, credential, recoveryProof }
            : { active: false }));
        });
      });
      await listen(server, 0);
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("native lease fixture did not bind TCP");
      try {
        await startNativeRunner(fixture, bridgeToken, address.port, clockSkewMs);
        await expect(waitForTerminalStatus(fixture.statusPath, 8_000)).resolves.toMatchObject({ state: "completed" });
      } finally {
        await closeServer(server);
      }
    }
  });

  it("survives transient validate and release outages only within the relative lease lifetime", { timeout: 25_000 }, async () => {
    const fixture = await createRunnerFixture({
      settleDelayMs: 7_000,
      nativeAuthRequired: true,
      refreshNativeAuth: false
    });
    const credential = { type: "oauth", access: `retry-access-${randomUUID()}`, refresh: `retry-refresh-${randomUUID()}` };
    const bridgeToken = `retry-bridge-${randomUUID()}-${randomUUID()}`.replace(/-/gu, "_");
    const recoveryProof = createHash("sha256").update(randomUUID()).digest("base64url");
    let acquiredResolve!: () => void;
    let validatedResolve!: () => void;
    const acquired = new Promise<void>((resolve) => { acquiredResolve = resolve; });
    const validated = new Promise<void>((resolve) => { validatedResolve = resolve; });
    const actions: string[] = [];
    const firstServer = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        actions.push(String(body.action));
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ active: true, validForMs: 15_000, credential, recoveryProof }));
        acquiredResolve();
      });
    });
    await listen(firstServer, 0);
    const address = firstServer.address();
    if (address === null || typeof address === "string") throw new Error("native lease fixture did not bind TCP");
    const port = address.port;
    const validateServer = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        expect(body).toMatchObject({ action: "validate", recoveryProof });
        expect(body.recovery).toBeUndefined();
        actions.push("validate");
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ active: true, validForMs: 15_000 }));
        validatedResolve();
      });
    });
    const releaseServer = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        expect(body).toMatchObject({ action: "release", recoveryProof });
        expect(body.recovery).toBeUndefined();
        expect(body.credential).toBeUndefined();
        actions.push("release");
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ active: false }));
      });
    });
    try {
      await startNativeRunner(fixture, bridgeToken, port);
      await acquired;
      await closeServer(firstServer);
      const restartFlow = (async () => {
        await delay(5_500);
        await listen(validateServer, port);
        await validated;
        await closeServer(validateServer);
        await delay(1_800);
        await listen(releaseServer, port);
      })();
      const status = await waitForTerminalStatus(fixture.statusPath, 18_000);
      await restartFlow;
      expect(status).toMatchObject({ state: "completed" });
      expect(actions).toEqual(["acquire", "validate", "release"]);
    } finally {
      await Promise.all([closeServer(firstServer), closeServer(validateServer), closeServer(releaseServer)]);
    }
  });

  it("stops the child after transient auth failures exhaust the original relative lifetime", { timeout: 20_000 }, async () => {
    const fixture = await createRunnerFixture({
      settleDelayMs: 30_000,
      nativeAuthRequired: true,
      refreshNativeAuth: false
    });
    const credential = { type: "oauth", access: `expiry-access-${randomUUID()}`, refresh: `expiry-refresh-${randomUUID()}` };
    const bridgeToken = `expiry-bridge-${randomUUID()}-${randomUUID()}`.replace(/-/gu, "_");
    const recoveryProof = createHash("sha256").update(randomUUID()).digest("base64url");
    let acquiredResolve!: () => void;
    const acquired = new Promise<void>((resolve) => { acquiredResolve = resolve; });
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ active: true, validForMs: 5_500, credential, recoveryProof }));
        acquiredResolve();
      });
    });
    await listen(server, 0);
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("native lease fixture did not bind TCP");
    try {
      await startNativeRunner(fixture, bridgeToken, address.port);
      await acquired;
      await closeServer(server);
      await expect(waitForTerminalStatus(fixture.statusPath, 12_000)).resolves.toMatchObject({
        state: "failed",
        summary: "native credential lease was revoked"
      });
      await expect(readFile(join(fixture.childHome, "auth.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await closeServer(server);
    }
  });

  it("fails explicitly when a changed credential cannot be released before expiry", { timeout: 15_000 }, async () => {
    const fixture = await createRunnerFixture({ settleDelayMs: 150, nativeAuthRequired: true });
    const credential = { type: "oauth", access: `flush-access-${randomUUID()}`, refresh: `flush-refresh-${randomUUID()}` };
    const bridgeToken = `flush-bridge-${randomUUID()}-${randomUUID()}`.replace(/-/gu, "_");
    const recoveryProof = createHash("sha256").update(randomUUID()).digest("base64url");
    let acquiredResolve!: () => void;
    const acquired = new Promise<void>((resolve) => { acquiredResolve = resolve; });
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ active: true, validForMs: 1_000, credential, recoveryProof }));
        acquiredResolve();
      });
    });
    await listen(server, 0);
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("native lease fixture did not bind TCP");
    try {
      await startNativeRunner(fixture, bridgeToken, address.port);
      await acquired;
      await closeServer(server);
      await expect(waitForTerminalStatus(fixture.statusPath, 8_000)).resolves.toMatchObject({
        state: "failed",
        summary: "native credential lease release failed"
      });
    } finally {
      await closeServer(server);
    }
  });

  it("renews a native credential lease and fails exactly once after revocation", { timeout: 20_000 }, async () => {
    const runnerSource = MANAGED_SUBAGENT_RUNNER_SOURCE.replace(
      "const NATIVE_AUTH_VALIDATE_INTERVAL_MS = 5000;",
      "const NATIVE_AUTH_VALIDATE_INTERVAL_MS = 25;"
    );
    expect(runnerSource).not.toBe(MANAGED_SUBAGENT_RUNNER_SOURCE);
    const fixture = await createRunnerFixture({
      settleDelayMs: 10_000,
      nativeAuthRequired: true,
      runnerSource
    });
    const credential = {
      type: "oauth",
      access: `runner-watchdog-access-${randomUUID()}`,
      refresh: `runner-watchdog-refresh-${randomUUID()}`,
      expires: Date.now() + 60_000
    };
    const bridgeToken = `runner-watchdog-${randomUUID()}-${randomUUID()}`.replace(/-/gu, "_");
    const recoveryProof = Buffer.from(randomUUID().replace(/-/gu, "").padEnd(32, "0")).toString("base64url").slice(0, 43);
    const actions: string[] = [];
    let validateRequests = 0;
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        const action = String(body.action);
        actions.push(action);
        let result: Record<string, unknown>;
        if (action === "acquire") {
          result = { active: true, validForMs: 15_000, credential, recoveryProof };
        } else if (action === "validate") {
          expect(body.recoveryProof).toBe(recoveryProof);
          validateRequests += 1;
          result = validateRequests === 1 ? { active: true, validForMs: 15_000 } : { active: false };
        } else {
          result = { active: false };
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(result));
      });
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(0, "127.0.0.1", resolveListen);
    });
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("native lease watchdog fixture did not bind TCP");
      await startNativeRunner(fixture, bridgeToken, address.port);

      const status = await waitForTerminalStatus(fixture.statusPath, 8_000);
      expect(status).toMatchObject({
        state: "failed",
        summary: "native credential lease was revoked",
        error: "native credential lease was revoked"
      });
      expect(actions).toEqual(["acquire", "validate", "validate", "release"]);
      expect(validateRequests).toBe(2);
      await expect(readFile(join(fixture.childHome, "auth.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

      const trace = (await readFile(fixture.childTracePath, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(trace.filter((entry) => entry.type === "command" && entry.command === "abort")).toHaveLength(1);
      expect(trace.filter((entry) => entry.type === "terminal" && entry.event === "agent_settled")).toHaveLength(1);

      const statusText = await readFile(fixture.statusPath, "utf8");
      const resultText = await readFile(join(fixture.runDirectory, "result.json"), "utf8");
      expect(JSON.parse(resultText)).toMatchObject({ state: "failed", result: "native credential lease was revoked" });
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
      expect(await readFile(fixture.statusPath, "utf8")).toBe(statusText);
      expect(await readFile(join(fixture.runDirectory, "result.json"), "utf8")).toBe(resultText);
      expect(actions).toEqual(["acquire", "validate", "validate", "release"]);
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

  it("reclaims a stale dead runner's exact native auth home after ownership fencing", async () => {
    const fixture = await createRunnerFixture({ settleDelayMs: 10_000 });
    const authPath = join(fixture.childHome, "auth.json");
    await writeFile(authPath, "dead-run-secret\n", { encoding: "utf8", mode: 0o600 });
    await writeRunningRunnerOwnership(fixture, await stoppedProcessId(), 0);

    await expect(reconcileManagedSubagentAuthHomes(fixture.root)).resolves.toBe(1);
    await expect(readFile(authPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(fixture.statusPath, "utf8"))).toMatchObject({ state: "failed" });
  });

  it("claims and idempotently reclaims a stale launch abandoned before runner claim", async () => {
    const fixture = await createRunnerFixture({ settleDelayMs: 10_000 });
    const authPath = join(fixture.childHome, "auth.json");
    const status = JSON.parse(await readFile(fixture.statusPath, "utf8")) as Record<string, unknown>;
    await Promise.all([
      writeFile(authPath, "power-loss-secret\n", { encoding: "utf8", mode: 0o600 }),
      writeFile(fixture.statusPath, `${JSON.stringify({ ...status, heartbeatAt: 0 })}\n`, { encoding: "utf8", mode: 0o600 })
    ]);

    await expect(reconcileManagedSubagentAuthHomes(fixture.root)).resolves.toBe(1);
    await expect(reconcileManagedSubagentAuthHomes(fixture.root)).resolves.toBe(0);
    expect(JSON.parse(await readFile(join(fixture.runDirectory, "runner.claim.json"), "utf8")))
      .toMatchObject({ runId: fixture.runId, runnerPid: 0 });
    await expect(readFile(authPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves the native auth home of a live fenced runner", async () => {
    const fixture = await createRunnerFixture({ settleDelayMs: 10_000 });
    const authPath = join(fixture.childHome, "auth.json");
    await writeFile(authPath, "active-run-secret\n", { encoding: "utf8", mode: 0o600 });
    await writeRunningRunnerOwnership(fixture, process.pid, 0);

    await expect(reconcileManagedSubagentAuthHomes(fixture.root)).resolves.toBe(0);
    await expect(readFile(authPath, "utf8")).resolves.toBe("active-run-secret\n");
    expect(JSON.parse(await readFile(fixture.statusPath, "utf8"))).toMatchObject({ state: "running" });
  });

  it("fails closed when a dead runner's auth Session path aliases another directory", async () => {
    const fixture = await createRunnerFixture({ settleDelayMs: 10_000 });
    await writeRunningRunnerOwnership(fixture, await stoppedProcessId(), 0);
    const authSessionDirectory = dirname(fixture.childHome);
    const outside = await temporaryDirectory();
    await rm(authSessionDirectory, { recursive: true, force: true });
    await symlink(outside, authSessionDirectory, process.platform === "win32" ? "junction" : "dir");

    await expect(reconcileManagedSubagentAuthHomes(fixture.root)).rejects.toThrow(/native auth runtime storage is unsafe/iu);
  });

  it("routes parent deletion through the owned mailbox and removes data only after abort is terminal", { timeout: 20_000 }, async () => {
    const fixture = await createRunnerFixture({ settleDelayMs: 10_000, settleOnAbort: false });
    const launcher = spawn(process.execPath, [fixture.runnerPath, fixture.configPath], {
      cwd: fixture.runDirectory,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: {
        ...process.env,
        JOKO_PI_SUBAGENT_CREDENTIAL_ENV_NAMES: "[]",
        JOKO_PI_SECRET_ENV_NAMES: "[]"
      }
    });
    await new Promise<void>((resolveStarted, rejectStarted) => {
      launcher.once("spawn", resolveStarted);
      launcher.once("error", rejectStarted);
    });
    launcher.unref();
    await waitForState(fixture.statusPath, "running", 5_000);
    await stopAndRemoveManagedSubagentRuns(fixture.root, fixture.productSessionId, 8_000);
    await expect(readFile(fixture.statusPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("persists a safe approval envelope and consumes an exactly fenced durable reply", { timeout: 20_000 }, async () => {
    const fixture = await createRunnerFixture({ settleDelayMs: 10_000, requestApproval: true });
    const runner = spawn(process.execPath, [fixture.runnerPath, fixture.configPath], {
      cwd: fixture.runDirectory,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: {
        ...process.env,
        JOKO_PI_SUBAGENT_CREDENTIAL_ENV_NAMES: JSON.stringify(["JOKO_RUNNER_TEST_SECRET"]),
        JOKO_PI_SECRET_ENV_NAMES: JSON.stringify(["JOKO_RUNNER_TEST_SECRET"]),
        JOKO_RUNNER_TEST_SECRET: fixture.secret
      }
    });
    await new Promise<void>((resolveStarted, rejectStarted) => {
      runner.once("spawn", resolveStarted);
      runner.once("error", rejectStarted);
    });
    runner.unref();
    const pending = await waitForPendingApproval(fixture.statusPath, 5_000);
    expect(pending).toMatchObject({
      id: "fixture-approval",
      childId: `${fixture.taskId}:child`,
      method: "confirm",
      title: "joko:permission:bash"
    });
    expect(JSON.stringify(pending)).not.toContain(fixture.secret);
    expect(JSON.stringify(pending)).toContain("[REDACTED]");
    await writeFile(join(fixture.runDirectory, "approval-control.json"), `${JSON.stringify({
      format: 1,
      requestId: randomUUID(),
      runId: fixture.runId,
      launchToken: fixture.launchToken,
      productSessionId: fixture.productSessionId,
      productGeneration: 1,
      taskId: fixture.taskId,
      childId: `${fixture.taskId}:child`,
      approvalId: "fixture-approval",
      action: "approval",
      confirmed: true,
      requestedAt: Date.now()
    })}\n`, { encoding: "utf8", mode: 0o600 });
    const terminal = await waitForTerminalStatus(fixture.statusPath, 8_000);
    expect(terminal).toMatchObject({ state: "completed" });
    expect(terminal.pendingApproval).toBeUndefined();
    const persisted = [
      await readFile(fixture.statusPath, "utf8"),
      await readFile(join(fixture.runDirectory, "transcript.jsonl"), "utf8"),
      await readFile(join(fixture.runDirectory, "result.json"), "utf8")
    ].join("\n");
    expect(persisted).not.toContain(fixture.secret);
    expect(persisted).not.toContain("Bounded arguments");
  });

  it("reconciles a stale queued launch whose runner never claimed ownership", async () => {
    const fixture = await createRunnerFixture({ settleDelayMs: 10_000 });
    const status = JSON.parse(await readFile(fixture.statusPath, "utf8")) as Record<string, unknown>;
    await writeFile(fixture.statusPath, `${JSON.stringify({
      ...status,
      heartbeatAt: Date.now() - 20_000
    })}\n`, { encoding: "utf8", mode: 0o600 });
    await stopAndRemoveManagedSubagentRuns(fixture.root, fixture.productSessionId, 2_000);
    await expect(readFile(fixture.statusPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("durably queues an eight-task fanout behind four exact child-process slots", { timeout: 25_000 }, async () => {
    const first = await createRunnerFixture({ settleDelayMs: 10_000 });
    const fixtures = [first];
    for (let index = 1; index < 8; index += 1) {
      fixtures.push(await createRunnerFixture({
        settleDelayMs: 10_000,
        root: first.root,
        productSessionId: first.productSessionId
      }));
    }
    for (const fixture of fixtures) {
      const runner = spawn(process.execPath, [fixture.runnerPath, fixture.configPath], {
        cwd: fixture.runDirectory,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: {
          ...process.env,
          JOKO_PI_SUBAGENT_CREDENTIAL_ENV_NAMES: "[]",
          JOKO_PI_SECRET_ENV_NAMES: "[]"
        }
      });
      await new Promise<void>((resolveStarted, rejectStarted) => {
        runner.once("spawn", resolveStarted);
        runner.once("error", rejectStarted);
      });
      runner.unref();
    }

    const states = await waitForStateCounts(fixtures.map((fixture) => fixture.statusPath), 4, 4, 8_000);
    expect(states.filter((state) => state === "running")).toHaveLength(4);
    expect(states.filter((state) => state === "queued")).toHaveLength(4);

    await stopAndRemoveManagedSubagentRuns(first.root, first.productSessionId, 12_000);
    await expect(readFile(first.statusPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

interface RunnerFixture {
  readonly root: string;
  readonly productSessionId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly launchToken: string;
  readonly nativeSessionId: string;
  readonly secret: string;
  readonly runDirectory: string;
  readonly childHome: string;
  readonly runnerPath: string;
  readonly configPath: string;
  readonly statusPath: string;
  readonly launcherPath: string;
  readonly childTracePath: string;
  readonly runnerPrivateKey?: KeyObject;
  readonly runnerPublicKey?: string;
}

async function createRunnerFixture(options: {
  readonly settleDelayMs: number;
  readonly settleOnAbort?: boolean;
  readonly requestApproval?: boolean;
  readonly nativeAuthRequired?: boolean;
  readonly refreshNativeAuth?: boolean;
  readonly runnerSource?: string;
  readonly root?: string;
  readonly productSessionId?: string;
  readonly nativeSessionId?: string;
}): Promise<RunnerFixture> {
  const root = options.root ?? join(await temporaryDirectory(), "subagent-runs");
  const productSessionId = options.productSessionId ?? `product-${randomUUID()}`;
  const taskId = `task-${randomUUID()}`;
  const runId = randomUUID();
  const launchToken = randomUUID();
  const runnerInstanceId = randomUUID();
  const nativeSessionId = options.nativeSessionId ?? randomUUID();
  const secret = `joko-runner-secret-${randomUUID()}`;
  const sessionDirectory = join(root, managedSubagentSessionKey(productSessionId));
  const runDirectory = join(sessionDirectory, runId);
  const slotRoot = join(sessionDirectory, "slots");
  const runtimeDirectory = join(runDirectory, "runtime");
  const temporaryPath = join(runDirectory, "temporary");
  const childHome = join(join(root, "..", "subagent-native-auth"), managedSubagentSessionKey(productSessionId), runId);
  const childSessionDirectory = join(runDirectory, "sessions");
  await Promise.all([root, sessionDirectory, runDirectory, slotRoot, childHome, childSessionDirectory, runtimeDirectory, temporaryPath]
    .map((path) => mkdir(path, { recursive: true, mode: 0o700 })));
  const runnerPath = join(runDirectory, MANAGED_SUBAGENT_RUNNER_FILE_NAME);
  const fakeChildPath = join(runDirectory, "fake-child.cjs");
  const configPath = join(runDirectory, "config.json");
  const statusPath = join(runDirectory, "status.json");
  const transcriptPath = join(runDirectory, "transcript.jsonl");
  const runtimeControlPath = join(runtimeDirectory, "control.json");
  const retryControlPath = join(runtimeDirectory, "retry-control.json");
  const launcherPath = join(runDirectory, "launcher.cjs");
  const childTracePath = join(runDirectory, "fake-child-trace.jsonl");
  const runnerSource = options.runnerSource ?? MANAGED_SUBAGENT_RUNNER_SOURCE;
  const runnerScriptSha256 = createHash("sha256").update(runnerSource).digest("hex");
  const runnerKeys = options.nativeAuthRequired === true ? generateKeyPairSync("ed25519") : undefined;
  const runnerPublicKey = runnerKeys?.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const runnerPublicKeyDigest = runnerPublicKey === undefined
    ? undefined
    : createHash("sha256").update(runnerPublicKey).digest("hex");
  const nativeAuthReservationId = options.nativeAuthRequired === true ? randomUUID() : undefined;
  await Promise.all([
    writeFile(runnerPath, runnerSource, { encoding: "utf8", mode: 0o600 }),
    writeFile(
      fakeChildPath,
      fakeChildSource(options.settleDelayMs, options.settleOnAbort ?? true, options.requestApproval === true,
        options.refreshNativeAuth !== false, childTracePath),
      { encoding: "utf8", mode: 0o600 }
    ),
    writeFile(childTracePath, "", { encoding: "utf8", mode: 0o600 }),
    writeFile(transcriptPath, "", { encoding: "utf8", mode: 0o600 }),
    writeFile(runtimeControlPath, "{}\n", { encoding: "utf8", mode: 0o600 }),
    writeFile(retryControlPath, "{}\n", { encoding: "utf8", mode: 0o600 })
  ]);
  const config = {
    format: 1,
    runId,
    launchToken,
    runDir: runDirectory,
    runnerScript: runnerPath,
    runnerScriptSha256,
    productSessionId,
    parentTaskId: "parent-task",
    taskId,
    childId: `${taskId}:child`,
    agentName: "scout",
    title: "Fixture scout",
    task: "Inspect the fixture",
    model: "fixture/model",
    effort: "off",
    toolClass: "read",
    readOnly: true,
    nativeAuthRequired: options.nativeAuthRequired === true,
    background: true,
    runnerInstanceId,
    ...(options.nativeAuthRequired === true ? {
      route: { provider: "native-provider" },
      nativeAuthReservationId,
      nativeAuthServiceGeneration: 1,
      runnerPublicKey,
      runnerPublicKeyDigest
    } : {}),
    contextMode: "fresh",
    timeoutMs: 15_000,
    turnCount: 1,
    createdAt: Date.now(),
    productGeneration: 1,
    workspaceRoot: runDirectory,
    slotRoot,
    childHome,
    childSessionDir: childSessionDirectory,
    nativeSessionId,
    runtimeControlPath,
    retryControlPath,
    temporaryPath,
    transcriptPath,
    initialMessage: "Inspect the fixture",
    child: { command: process.execPath, args: [fakeChildPath, "--session-dir", childSessionDirectory, "--session-id", nativeSessionId] }
  };
  const owner = {
    format: 1,
    runId,
    launchToken,
    productSessionId,
    taskId,
    runnerScript: runnerPath,
    runnerScriptSha256,
    runnerInstanceId,
    ...(options.nativeAuthRequired === true ? { nativeAuthReservationId, runnerPublicKeyDigest } : {}),
    state: "reserved",
    createdAt: config.createdAt
  };
  const status = {
    format: 1,
    runId,
    launchToken,
    productSessionId,
    parentTaskId: config.parentTaskId,
    taskId,
    childId: config.childId,
    agentName: config.agentName,
    title: config.title,
    task: config.task,
    model: config.model,
    effort: config.effort,
    toolClass: config.toolClass,
    readOnly: true,
    contextMode: config.contextMode,
    background: true,
    state: "queued",
    summary: "queued",
    createdAt: config.createdAt,
    heartbeatAt: config.createdAt,
    runnerPid: 0,
    runnerInstanceId,
    runnerScript: runnerPath,
    runnerScriptSha256,
    ...(options.nativeAuthRequired === true ? { nativeAuthReservationId, runnerPublicKeyDigest } : {}),
    nativeSessionId,
    usage: { totalTokens: 0 },
    toolUses: 0,
    durationMs: 0,
    turnCount: 1,
    pendingMessageCount: 0,
    transcriptPath
  };
  await Promise.all([
    writeFile(configPath, `${JSON.stringify(config)}\n`, { encoding: "utf8", mode: 0o600 }),
    writeFile(join(runDirectory, "owner.json"), `${JSON.stringify(owner)}\n`, { encoding: "utf8", mode: 0o600 }),
    writeFile(statusPath, `${JSON.stringify(status)}\n`, { encoding: "utf8", mode: 0o600 }),
    writeFile(
      launcherPath,
      [
        'const { spawn } = require("node:child_process");',
        `const child = spawn(process.execPath, [${JSON.stringify(runnerPath)}, ${JSON.stringify(configPath)}], {`,
        `  cwd: ${JSON.stringify(runDirectory)}, detached: true, stdio: "ignore", windowsHide: true, env: process.env`,
        "});",
        'child.once("spawn", function () { child.unref(); process.stdout.write(String(process.pid)); });',
        'child.once("error", function (error) { throw error; });'
      ].join("\n"),
      { encoding: "utf8", mode: 0o600 }
    )
  ]);
  for (const path of [runnerPath, fakeChildPath, configPath, statusPath, launcherPath]) await chmod(path, 0o600);
  return {
    root,
    productSessionId,
    taskId,
    runId,
    launchToken,
    nativeSessionId,
    secret,
    runDirectory,
    childHome,
    runnerPath,
    configPath,
    statusPath,
    launcherPath,
    childTracePath,
    runnerPrivateKey: runnerKeys?.privateKey,
    runnerPublicKey
  };
}

async function configureResumeFixture(fixture: RunnerFixture, resumeSessionPath: string): Promise<void> {
  const config = JSON.parse(await readFile(fixture.configPath, "utf8")) as Record<string, unknown>;
  const child = config.child as { args?: unknown } | undefined;
  if (!child || !Array.isArray(child.args)) throw new Error("fixture child launch is unavailable");
  const sessionIdIndex = child.args.indexOf("--session-id");
  if (sessionIdIndex < 0) throw new Error("fixture child session identity is unavailable");
  child.args.splice(sessionIdIndex, 2, "--session", resumeSessionPath);
  config.resumeSessionPath = resumeSessionPath;
  await writeFile(fixture.configPath, `${JSON.stringify(config)}\n`, { encoding: "utf8", mode: 0o600 });
}

async function runFixtureRunner(fixture: RunnerFixture): Promise<unknown> {
  return execFileAsync(process.execPath, [fixture.runnerPath, fixture.configPath], {
    cwd: fixture.runDirectory,
    windowsHide: true,
    timeout: 10_000,
    env: {
      ...process.env,
      JOKO_PI_SUBAGENT_CREDENTIAL_ENV_NAMES: "[]",
      JOKO_PI_SECRET_ENV_NAMES: "[]"
    }
  });
}

async function writeRunningRunnerOwnership(fixture: RunnerFixture, runnerPid: number, heartbeatAt: number): Promise<void> {
  const runnerInstanceId = randomUUID();
  const status = JSON.parse(await readFile(fixture.statusPath, "utf8")) as Record<string, unknown>;
  const ownerPath = join(fixture.runDirectory, "owner.json");
  const owner = JSON.parse(await readFile(ownerPath, "utf8")) as Record<string, unknown>;
  const runnerScriptSha256 = String(status["runnerScriptSha256"]);
  await Promise.all([
    writeFile(fixture.statusPath, `${JSON.stringify({
      ...status,
      state: "running",
      runnerPid,
      runnerInstanceId,
      heartbeatAt
    })}\n`, { encoding: "utf8", mode: 0o600 }),
    writeFile(ownerPath, `${JSON.stringify({
      ...owner,
      state: "running",
      runnerPid,
      runnerInstanceId,
      startedAt: heartbeatAt
    })}\n`, { encoding: "utf8", mode: 0o600 }),
    writeFile(join(fixture.runDirectory, "runner.claim.json"), `${JSON.stringify({
      format: 1,
      runId: fixture.runId,
      launchToken: fixture.launchToken,
      runnerPid,
      runnerInstanceId,
      runnerScriptSha256,
      claimedAt: heartbeatAt
    })}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" })
  ]);
}

async function stoppedProcessId(): Promise<number> {
  const victim = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    windowsHide: true
  });
  const closed = new Promise<void>((resolveClosed) => victim.once("close", () => resolveClosed()));
  await new Promise<void>((resolveStarted, rejectStarted) => {
    victim.once("spawn", resolveStarted);
    victim.once("error", rejectStarted);
  });
  const pid = victim.pid;
  if (!Number.isSafeInteger(pid) || Number(pid) < 1) throw new Error("dead-run fixture did not obtain a process identity");
  victim.kill();
  await closed;
  return Number(pid);
}

function fakeChildSource(
  settleDelayMs: number,
  settleOnAbort: boolean,
  requestApproval: boolean,
  refreshNativeAuth: boolean,
  childTracePath: string
): string {
  return `"use strict";
const fs = require("node:fs");
const path = require("node:path");
const tracePath = ${JSON.stringify(childTracePath)};
const args = process.argv.slice(2);
const valueAfter = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const sessionDir = valueAfter("--session-dir");
const resumePath = valueAfter("--session");
const sessionId = valueAfter("--session-id") || (resumePath ? path.basename(resumePath, ".jsonl") : "fixture-session");
const sessionFile = resumePath || path.join(sessionDir, sessionId + ".jsonl");
let nativeSecret = "";
let refreshedNativeSecret = "";
try {
  const authPath = path.join(process.env.PI_CODING_AGENT_DIR, "auth.json");
  const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
  nativeSecret = auth["native-provider"] && auth["native-provider"].access || "";
  if (nativeSecret && ${JSON.stringify(refreshNativeAuth)}) {
    auth["native-provider"] = Object.assign({}, auth["native-provider"], {
      access: "refreshed-" + auth["native-provider"].access,
      refresh: "refreshed-" + auth["native-provider"].refresh
    });
    refreshedNativeSecret = auth["native-provider"].access;
    fs.writeFileSync(authPath, JSON.stringify(auth) + "\\n", { encoding: "utf8", mode: 0o600 });
  }
} catch {}
fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
if (!fs.existsSync(sessionFile)) fs.writeFileSync(sessionFile, "{}\\n", { mode: 0o600 });
let buffer = "";
let assistant;
function trace(value) { fs.appendFileSync(tracePath, JSON.stringify(value) + "\\n", { encoding: "utf8", mode: 0o600 }); }
function send(value) {
  if (value && value.type === "agent_settled") trace({ type: "terminal", event: value.type });
  process.stdout.write(JSON.stringify(value) + "\\n");
}
function complete(text) {
  const secret = process.env.JOKO_RUNNER_TEST_SECRET || "none";
  assistant = { role: "assistant", content: [{ type: "text", text: text + " " + secret + " " + nativeSecret + " " + refreshedNativeSecret }], stopReason: "stop" };
  send({ type: "message_end", message: assistant });
  send({ type: "agent_settled" });
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += String(chunk);
  for (;;) {
    const newline = buffer.indexOf("\\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const command = JSON.parse(line);
    trace({ type: "command", command: command.type });
    if (command.type === "get_state") send({ type: "response", id: command.id, command: command.type, success: true, data: { sessionId, sessionFile, isStreaming: false, pendingMessageCount: 0, messageCount: assistant ? 2 : 0 } });
    else if (command.type === "get_messages") send({ type: "response", id: command.id, command: command.type, success: true, data: { messages: assistant ? [assistant] : [] } });
    else if (command.type === "get_session_stats") send({ type: "response", id: command.id, command: command.type, success: true, data: { sessionId, tokens: { input: 4, output: 5, total: 9 }, cost: 0.01, toolCalls: 2 } });
    else if (command.type === "prompt") {
      send({ type: "response", id: command.id, command: command.type, success: true, data: {} });
      ${requestApproval
        ? 'send({ type: "extension_ui_request", id: "fixture-approval", method: "confirm", title: "joko:permission:bash", message: "Bounded evidence " + (process.env.JOKO_RUNNER_TEST_SECRET || "none") });'
        : `setTimeout(() => complete("done"), ${settleDelayMs});`}
    } else if (command.type === "extension_ui_response") {
      complete(command.confirmed === true ? "approved" : "denied");
    } else if (command.type === "abort") {
      send({ type: "response", id: command.id, command: command.type, success: true, data: {} });
      ${settleOnAbort ? `assistant = { role: "assistant", content: [], stopReason: "aborted" };
      send({ type: "message_end", message: assistant });
      send({ type: "agent_settled" });` : ""}
    } else if (command.type === "steer" || command.type === "follow_up") {
      send({ type: "response", id: command.id, command: command.type, success: true, data: {} });
      send({ type: "queue_update", steering: command.type === "steer" ? [command.message] : [], followUp: command.type === "follow_up" ? [command.message] : [] });
    }
  }
});
`;
}

async function waitForTerminalStatus(path: string, timeoutMs: number): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    if (["completed", "failed", "aborted"].includes(String(status.state))) return status;
    if (Date.now() >= deadline) throw new Error(`Runner did not reach terminal state: ${JSON.stringify(status)}`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
}

async function waitForState(path: string, state: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    if (status.state === state) return;
    if (Date.now() >= deadline) throw new Error(`Runner did not reach ${state}: ${JSON.stringify(status)}`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
}

async function waitForPendingApproval(path: string, timeoutMs: number): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    const pending = status.pendingApproval;
    if (pending !== null && typeof pending === "object" && !Array.isArray(pending)) {
      return pending as Record<string, unknown>;
    }
    if (Date.now() >= deadline) throw new Error(`Runner did not publish a pending approval: ${JSON.stringify(status)}`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
}

async function waitForStateCounts(
  paths: readonly string[],
  running: number,
  queued: number,
  timeoutMs: number
): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const states = await Promise.all(paths.map(async (path) => {
      const status = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      return String(status.state);
    }));
    if (states.filter((state) => state === "running").length === running
        && states.filter((state) => state === "queued").length === queued) return states;
    if (Date.now() >= deadline) throw new Error(`Runner state distribution did not reach ${running} running/${queued} queued: ${states.join(",")}`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
}

async function listen(server: ReturnType<typeof createServer>, port: number): Promise<void> {
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, "127.0.0.1", resolveListen);
  });
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
}

async function startNativeRunner(
  fixture: RunnerFixture,
  bridgeToken: string,
  port: number,
  clockSkewMs?: number
): Promise<void> {
  if (fixture.runnerPrivateKey === undefined) throw new Error("native runner fixture key is unavailable");
  let nodeOptions: string | undefined;
  if (clockSkewMs !== undefined) {
    const preload = join(fixture.runDirectory, `clock-skew-${clockSkewMs}.cjs`);
    await writeFile(preload, `const original=Date.now;Date.now=()=>original()+(${clockSkewMs});\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    nodeOptions = `--require=${preload}`;
  }
  const runner = spawn(process.execPath, [fixture.runnerPath, fixture.configPath], {
    cwd: fixture.runDirectory,
    detached: true,
    stdio: ["ignore", "ignore", "ignore", "pipe"],
    windowsHide: true,
    env: {
      ...process.env,
      JOKO_PI_SUBAGENT_CREDENTIAL_ENV_NAMES: JSON.stringify(["JOKO_PI_MCP_TOKEN"]),
      JOKO_PI_SECRET_ENV_NAMES: JSON.stringify(["JOKO_PI_MCP_TOKEN"]),
      JOKO_PI_MCP_TOKEN: bridgeToken,
      JOKO_PI_NATIVE_AUTH_ENDPOINT: `http://127.0.0.1:${port}/internal/pi-native-auth`,
      JOKO_PI_NATIVE_AUTH_CATALOG_GENERATION: "7",
      JOKO_PI_NATIVE_AUTH_TARGET_ID: "target-native",
      JOKO_PI_NATIVE_AUTH_PRODUCT_SESSION_ID: fixture.productSessionId,
      JOKO_PI_NATIVE_AUTH_PRODUCT_GENERATION: "1",
      ...(nodeOptions === undefined ? {} : { NODE_OPTIONS: nodeOptions })
    }
  });
  await new Promise<void>((resolveStarted, rejectStarted) => {
    runner.once("spawn", resolveStarted);
    runner.once("error", rejectStarted);
  });
  const keyPipe = runner.stdio[3];
  if (!(keyPipe instanceof Writable)) {
    runner.kill();
    throw new Error("native runner fixture key pipe is unavailable");
  }
  const privateKeyBytes = fixture.runnerPrivateKey.export({ format: "der", type: "pkcs8" });
  await new Promise<void>((resolveWritten, rejectWritten) => {
    keyPipe.once("error", rejectWritten);
    keyPipe.end(privateKeyBytes, () => {
      privateKeyBytes.fill(0);
      resolveWritten();
    });
  }).catch((error) => {
    privateKeyBytes.fill(0);
    runner.kill();
    throw error;
  });
  runner.unref();
}

async function readTextTree(root: string): Promise<string> {
  const values: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) values.push(await readTextTree(path));
    else if (entry.isFile()) values.push(await readFile(path, "utf8"));
  }
  return values.join("\n");
}

function expectValidRunnerProof(body: Record<string, unknown>, publicKey: string | undefined): void {
  if (publicKey === undefined) throw new Error("native runner fixture public key is unavailable");
  const runnerProof = body.runnerProof as Record<string, unknown> | undefined;
  expect(runnerProof).toMatchObject({
    format: 1,
    reservationId: expect.any(String),
    runnerPid: expect.any(Number),
    nonce: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
    signature: expect.stringMatching(/^[A-Za-z0-9_-]{86}$/u)
  });
  if (runnerProof === undefined) throw new Error("native runner proof is unavailable");
  const credentialDigest = createHash("sha256").update(
    body.credential === undefined ? "" : JSON.stringify(body.credential)
  ).digest("hex");
  const message = JSON.stringify([
    "joko.pi-native-auth.runner-proof.v1",
    body.action,
    runnerProof.reservationId,
    body.sessionId,
    body.targetId,
    body.generation,
    body.runnerProductGeneration,
    body.providerId,
    body.catalogGeneration,
    body.runId,
    body.runnerFence,
    runnerProof.runnerPid,
    body.recoveryProof ?? "",
    credentialDigest,
    runnerProof.nonce
  ]);
  const key = createPublicKey({ key: Buffer.from(publicKey, "base64url"), format: "der", type: "spki" });
  expect(verify(null, Buffer.from(message, "utf8"), key, Buffer.from(String(runnerProof.signature), "base64url"))).toBe(true);
}

async function temporaryDirectory(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "joko-managed-runner-"));
  temporaryDirectories.push(value);
  return value;
}
