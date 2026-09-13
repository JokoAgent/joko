import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { link, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { mkdtemp } from "./test-paths.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { managedSubagentRunRoot, managedSubagentSessionKey } from "@joko/adapter-pi";
import { afterEach, describe, expect, it } from "vitest";

import {
  NativeAuthRecoveryStore,
  recoveryBindingDigest,
  type NativeAuthRecoveryDescriptor,
  type NativeAuthRecoveryIssueInput
} from "./native-auth-recovery.js";

const temporaryDirectories: string[] = [];
const testProcesses = new Map<number, {
  readonly runnerScript: string;
  readonly configPath: string;
  readonly processIdentity: string;
}>();

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 })));
  testProcesses.clear();
});

describe("NativeAuthRecoveryStore", () => {
  it("atomically revokes every active lease and unused reservation in one exact Session scope", async () => {
    const now = 2_000;
    const fixture = await recoveryFixture();
    const store = recoveryStore(fixture, () => now);
    await store.initialize();
    const issued = await store.issue(issueInput(fixture, `revoke-account-${randomUUID()}`, now + 15_000));
    const keys = generateKeyPairSync("ed25519");
    const publicKey = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
    await store.reserve({
      ...scope(fixture),
      runId: randomUUID(),
      runnerFence: randomUUID(),
      publicKey,
      expiresAt: now + 15_000
    });
    const catalogPath = join(fixture.stateRoot, "leases.json");
    const before = await readFile(catalogPath, "utf8");
    await expect(store.revokeScope({ sessionId: fixture.sessionId, targetId: "other-target" })).resolves.toBe(0);
    expect(await readFile(catalogPath, "utf8")).toBe(before);

    await expect(store.revokeScope({ sessionId: fixture.sessionId, targetId: fixture.targetId })).resolves.toBe(2);
    expect(JSON.parse(await readFile(catalogPath, "utf8"))).toMatchObject({
      records: [],
      transitions: [],
      reservations: []
    });
    await expect(store.recover({
      ...scope(fixture),
      action: "validate",
      proof: issued.proof,
      descriptor: descriptor("unavailable")
    })).resolves.toBeUndefined();
  });

  it("recovers a signed runner without an OS process API and atomically reissues a lost acquire proof", async () => {
    let now = 5_000;
    const fixture = await recoveryFixture();
    const accountId = `signed-account-${randomUUID()}`;
    const credentialCanary = `signed-credential-${randomUUID()}`;
    const store = recoveryStore(fixture, () => now, new Map());
    await store.initialize();
    const reservation = await reserveSignedRunner(store, fixture, now + 15_000);
    const acquireEvidence = signedRunnerEvidence(store, fixture, reservation, "acquire");
    const issued = await store.issue({
      ...issueInput(fixture, accountId, now + 15_000),
      runnerEvidence: acquireEvidence
    });

    const privateKeyCanary = reservation.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url");
    const catalogPath = join(fixture.stateRoot, "leases.json");
    const persisted = await readFile(catalogPath, "utf8");
    for (const canary of [accountId, credentialCanary, issued.proof, reservation.lastNonce, privateKeyCanary]) {
      expect(persisted).not.toContain(canary);
    }
    expect(persisted).toContain(reservation.publicKey);
    expect(persisted).toContain(reservation.publicKeyDigest);

    // The acquire committed but its response was lost, then the service
    // restarted. Exact signed scope can rotate a fresh proof without storing
    // or reconstructing the original raw proof.
    const restarted = recoveryStore(fixture, () => now, new Map());
    await restarted.initialize();
    const reissueEvidence = signedRunnerEvidence(restarted, fixture, reservation, "acquire");
    const reissued = await restarted.reissue({
      ...scope(fixture),
      bearerDigest: "f".repeat(64),
      descriptor: descriptor(accountId),
      runnerEvidence: reissueEvidence
    });
    expect(reissued?.proof).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(reissued?.proof).not.toBe(issued.proof);
    await expect(restarted.recover({
      ...scope(fixture),
      action: "validate",
      proof: issued.proof,
      descriptor: descriptor(accountId),
      runnerEvidence: signedRunnerEvidence(restarted, fixture, reservation, "validate", issued.proof)
    })).resolves.toBeUndefined();

    if (reissued === undefined) throw new Error("signed proof reissue fixture failed");
    const validateEvidence = signedRunnerEvidence(restarted, fixture, reservation, "validate", reissued.proof);
    await expect(restarted.recover({
      ...scope(fixture),
      action: "validate",
      proof: reissued.proof,
      descriptor: descriptor(accountId),
      runnerEvidence: validateEvidence
    })).resolves.toMatchObject({ released: false, recoveryId: reissued.snapshot.recoveryId });
    const afterValidate = await readFile(catalogPath, "utf8");
    const replayRestart = recoveryStore(fixture, () => now, new Map());
    await replayRestart.initialize();
    await expect(replayRestart.recover({
      ...scope(fixture),
      action: "validate",
      proof: reissued.proof,
      descriptor: descriptor(accountId),
      runnerEvidence: validateEvidence
    })).rejects.toThrow(/replayed/iu);
    expect(await readFile(catalogPath, "utf8")).toBe(afterValidate);

    const tamperedProof = signedProof(fixture, reservation, "release", reissued.proof);
    await expect(() => restarted.verifyRunnerProof({
      ...scope(fixture),
      serviceGeneration: fixture.serviceGeneration + 1,
      action: "release",
      proof: tamperedProof,
      recoveryProof: reissued.proof,
      credentialDigest: createHash("sha256").update("").digest("hex"),
      location: "local"
    })).toThrow(/scope|signature/iu);

    const releaseEvidence = signedRunnerEvidence(restarted, fixture, reservation, "release", reissued.proof);
    await expect(restarted.recover({
      ...scope(fixture),
      action: "release",
      proof: reissued.proof,
      descriptor: descriptor(accountId),
      runnerEvidence: releaseEvidence
    })).resolves.toMatchObject({ released: false });
    await restarted.complete(reissued.snapshot.recoveryId, now + 15_000);
    await expect(restarted.recover({
      ...scope(fixture),
      action: "release",
      proof: reissued.proof,
      descriptor: descriptor(accountId),
      runnerEvidence: signedRunnerEvidence(restarted, fixture, reservation, "release", reissued.proof)
    })).resolves.toMatchObject({ released: true });

    now += 15_001;
    const expired = recoveryStore(fixture, () => now, new Map());
    await expired.initialize();
    await expect(expired.recover({
      ...scope(fixture),
      action: "release",
      proof: reissued.proof,
      descriptor: descriptor(accountId)
    })).resolves.toBeUndefined();
  });

  it("keeps signed remote depth evidence bound across a recovery restart", async () => {
    const now = 7_000;
    const fixture = await recoveryFixture();
    const accountId = `signed-remote-account-${randomUUID()}`;
    const store = recoveryStore(fixture, () => now, new Map());
    await store.initialize();
    const reservation = await reserveSignedRunner(store, fixture, now + 15_000);
    const acquired = await store.issue({
      ...issueInput(fixture, accountId, now + 15_000),
      runnerEvidence: signedRemoteRunnerEvidence(store, fixture, reservation, "acquire")
    });

    const restarted = recoveryStore(fixture, () => now, new Map());
    await restarted.initialize();
    await expect(restarted.recover({
      ...scope(fixture),
      action: "validate",
      proof: acquired.proof,
      descriptor: descriptor(accountId),
      runnerEvidence: signedRemoteRunnerEvidence(restarted, fixture, reservation, "validate", acquired.proof)
    })).resolves.toMatchObject({ released: false, recoveryId: acquired.snapshot.recoveryId });
  });

  it("restores only the exact live native-auth runner without persisting raw authority", async () => {
    let now = 10_000;
    const fixture = await recoveryFixture();
    const accountId = `raw-account-${randomUUID()}`;
    const bridgeToken = `bridge-token-${randomUUID()}-${randomUUID()}`;
    const credentialCanary = `credential-${randomUUID()}`;
    const store = recoveryStore(fixture, () => now);
    await store.initialize();
    const issued = await store.issue(issueInput(fixture, accountId, now + 15_000));

    const catalog = await readFile(join(fixture.stateRoot, "leases.json"), "utf8");
    expect(catalog).not.toContain(accountId);
    expect(catalog).not.toContain(issued.proof);
    expect(catalog).not.toContain(bridgeToken);
    expect(catalog).not.toContain(credentialCanary);
    expect(catalog).not.toContain('"accountId"');
    expect(catalog).toContain('"accountDigest"');

    const restarted = recoveryStore(fixture, () => now);
    await restarted.initialize();
    const recovered = await restarted.recover({
      ...scope(fixture),
      action: "validate",
      proof: issued.proof,
      descriptor: descriptor(accountId)
    });
    expect(recovered).toMatchObject({
      recoveryId: issued.snapshot.recoveryId,
      released: false,
      refreshSuperseded: false,
      expiresAt: now + 15_000
    });
    expect(recovered).not.toHaveProperty("accountId");

    now += 1_000;
    await restarted.renew({
      recoveryId: issued.snapshot.recoveryId,
      expiresAt: now + 15_000,
      authGeneration: "auth-1",
      sourceCatalogGeneration: 7,
      refreshSuperseded: false
    });
    await restarted.complete(issued.snapshot.recoveryId, now + 15_000);
    await expect(restarted.recover({
      ...scope(fixture),
      action: "release",
      proof: issued.proof,
      descriptor: descriptor(accountId)
    })).resolves.toMatchObject({ released: true });
    await expect(restarted.recover({
      ...scope(fixture),
      action: "validate",
      proof: issued.proof,
      descriptor: descriptor(accountId)
    })).rejects.toThrow(/released/iu);
  });

  it("fails closed for catalog tampering, PID reuse, old auth generation, expiry, and symlinked state", async () => {
    let now = 20_000;
    const accountId = `tamper-account-${randomUUID()}`;

    const oldGenerationFixture = await recoveryFixture();
    const oldGenerationStore = recoveryStore(oldGenerationFixture, () => now);
    await oldGenerationStore.initialize();
    const oldGenerationProof = await oldGenerationStore.issue(issueInput(oldGenerationFixture, accountId, now + 15_000));
    await expect(oldGenerationStore.recover({
      ...scope(oldGenerationFixture),
      runnerProductGeneration: oldGenerationFixture.runnerProductGeneration + 1,
      action: "validate",
      proof: oldGenerationProof.proof,
      descriptor: descriptor(accountId)
    })).rejects.toThrow(/lineage/iu);
    await expect(oldGenerationStore.recover({
      ...scope(oldGenerationFixture),
      action: "validate",
      proof: oldGenerationProof.proof,
      descriptor: { ...descriptor(accountId), authGeneration: "auth-stale" }
    })).rejects.toThrow(/generation changed/iu);

    const forgedProcessFixture = await recoveryFixture();
    const forgedProcess = testProcesses.get(forgedProcessFixture.runnerPid)!;
    testProcesses.set(forgedProcessFixture.runnerPid, {
      ...forgedProcess,
      runnerScript: forgedProcessFixture.configPath
    });
    const forgedProcessStore = recoveryStore(forgedProcessFixture, () => now);
    await forgedProcessStore.initialize();
    await expect(forgedProcessStore.issue(issueInput(forgedProcessFixture, accountId, now + 15_000)))
      .rejects.toThrow(/process command/iu);
    testProcesses.set(forgedProcessFixture.runnerPid, forgedProcess);

    const forgedScriptStore = new NativeAuthRecoveryStore({
      runRoot: forgedProcessFixture.runRoot,
      stateRoot: join(forgedProcessFixture.agentHome, "forged-script-recovery"),
      now: () => now,
      trustedRunnerScriptSha256: "0".repeat(64),
      trustedNodeExecutable: forgedProcessFixture.trustedNodeExecutable,
      inspectRunnerProcess: async () => ({
        executablePath: forgedProcessFixture.trustedNodeExecutable,
        argv: [forgedProcessFixture.trustedNodeExecutable, forgedProcessFixture.runnerScript, forgedProcessFixture.configPath],
        processIdentity: forgedProcessFixture.processIdentity
      })
    });
    await forgedScriptStore.initialize();
    await expect(forgedScriptStore.issue(issueInput(forgedProcessFixture, accountId, now + 15_000)))
      .rejects.toThrow(/runner identity|content|fence/iu);

    const pidFixture = await recoveryFixture();
    const pidStore = recoveryStore(pidFixture, () => now);
    await pidStore.initialize();
    const pidProof = await pidStore.issue(issueInput(pidFixture, accountId, now + 15_000));
    const reusedPidStore = recoveryStore(pidFixture, () => now, "b".repeat(64));
    await reusedPidStore.initialize();
    await expect(reusedPidStore.recover({
      ...scope(pidFixture),
      action: "validate",
      proof: pidProof.proof,
      descriptor: descriptor(accountId)
    })).resolves.toBeUndefined();

    const tamperedFixture = await recoveryFixture();
    const tamperedStore = recoveryStore(tamperedFixture, () => now);
    await tamperedStore.initialize();
    const tamperedProof = await tamperedStore.issue(issueInput(tamperedFixture, accountId, now + 15_000));
    const catalogPath = join(tamperedFixture.stateRoot, "leases.json");
    const catalog = JSON.parse(await readFile(catalogPath, "utf8")) as { records: Array<Record<string, unknown>> };
    catalog.records[0]!["runnerScriptSha256"] = "c".repeat(64);
    await writeFile(catalogPath, `${JSON.stringify(catalog)}\n`, { encoding: "utf8", mode: 0o600 });
    const tamperedRestart = recoveryStore(tamperedFixture, () => now);
    await tamperedRestart.initialize();
    await expect(tamperedRestart.recover({
      ...scope(tamperedFixture),
      action: "validate",
      proof: tamperedProof.proof,
      descriptor: descriptor(accountId)
    })).resolves.toBeUndefined();

    const expiredFixture = await recoveryFixture();
    const expiringStore = recoveryStore(expiredFixture, () => now);
    await expiringStore.initialize();
    const expiredProof = await expiringStore.issue(issueInput(expiredFixture, accountId, now + 15_000));
    now += 15_001;
    const expiredRestart = recoveryStore(expiredFixture, () => now);
    await expiredRestart.initialize();
    await expect(expiredRestart.recover({
      ...scope(expiredFixture),
      action: "validate",
      proof: expiredProof.proof,
      descriptor: descriptor(accountId)
    })).resolves.toBeUndefined();

    const linkedFixture = await recoveryFixture();
    const outside = join(linkedFixture.agentHome, "outside-state");
    await mkdir(outside, { mode: 0o700 });
    await symlink(outside, linkedFixture.stateRoot, process.platform === "win32" ? "junction" : "dir");
    await expect(recoveryStore(linkedFixture, () => now).initialize()).rejects.toThrow(/unsafe/iu);

    const aliasedRunFixture = await recoveryFixture();
    const aliasedRunDirectory = join(
      aliasedRunFixture.runRoot,
      managedSubagentSessionKey(aliasedRunFixture.sessionId),
      aliasedRunFixture.runId
    );
    const outsideRunDirectory = join(aliasedRunFixture.agentHome, "outside-run");
    await rename(aliasedRunDirectory, outsideRunDirectory);
    await symlink(outsideRunDirectory, aliasedRunDirectory, process.platform === "win32" ? "junction" : "dir");
    const aliasedRunStore = recoveryStore(aliasedRunFixture, () => now);
    await aliasedRunStore.initialize();
    await expect(aliasedRunStore.issue(issueInput(aliasedRunFixture, accountId, now + 15_000)))
      .rejects.toThrow(/aliased|unsafe/iu);

    const hardlinkedFixture = await recoveryFixture();
    const statusPath = join(hardlinkedFixture.runRoot, managedSubagentSessionKey(hardlinkedFixture.sessionId),
      hardlinkedFixture.runId, "status.json");
    await link(statusPath, join(hardlinkedFixture.agentHome, "status-hardlink.json"));
    const hardlinkedStore = recoveryStore(hardlinkedFixture, () => now);
    await hardlinkedStore.initialize();
    await expect(hardlinkedStore.issue(issueInput(hardlinkedFixture, accountId, now + 15_000)))
      .rejects.toThrow(/linked|unsafe|status/iu);
  });

  it("atomically reconciles every same-account sibling after a persisted refresh crashes before commit", async () => {
    const now = 40_000;
    const accountId = `shared-account-${randomUUID()}`;
    const first = await recoveryFixture();
    const second = await addRun(first, { runnerPid: 42_002 });
    const identities = new Map([[first.runnerPid, first.processIdentity], [second.runnerPid, second.processIdentity]]);
    const store = recoveryStore(first, () => now, identities);
    await store.initialize();
    const firstProof = await store.issue(issueInput(first, accountId, now + 15_000));
    const secondProof = await store.issue(issueInput(second, accountId, now + 15_000));
    const transitionId = await store.beginTransition({
      recoveryId: firstProof.snapshot.recoveryId,
      providerId: first.providerId,
      accountId,
      authGeneration: "auth-1",
      sourceCatalogGeneration: 7
    });
    expect(transitionId).toMatch(/^[0-9a-f-]{36}$/iu);
    const afterRefresh = descriptor(accountId, "auth-2", 8);
    const catalogBeforeWrongRunner = await readFile(join(first.stateRoot, "leases.json"), "utf8");
    identities.set(second.runnerPid, "f".repeat(64));
    await expect(store.recover({
      ...scope(second),
      action: "validate",
      proof: secondProof.proof,
      descriptor: afterRefresh
    })).rejects.toThrow(/runner identity changed/iu);
    expect(await readFile(join(first.stateRoot, "leases.json"), "utf8")).toBe(catalogBeforeWrongRunner);
    identities.set(second.runnerPid, second.processIdentity);

    // The Provider write committed, then the service stopped before it could
    // atomically publish the new generation into the recovery catalog.
    const restarted = recoveryStore(first, () => now, identities);
    await restarted.initialize();
    await expect(restarted.recover({
      ...scope(second),
      action: "validate",
      proof: secondProof.proof,
      descriptor: afterRefresh
    })).resolves.toMatchObject({ authGeneration: "auth-2", sourceCatalogGeneration: 8, refreshSuperseded: true });
    await expect(restarted.recover({
      ...scope(first),
      action: "validate",
      proof: firstProof.proof,
      descriptor: afterRefresh
    })).resolves.toMatchObject({ authGeneration: "auth-2", sourceCatalogGeneration: 8, refreshSuperseded: true });
    const catalog = await readFile(join(first.stateRoot, "leases.json"), "utf8");
    expect(catalog).not.toContain(accountId);
    expect(JSON.parse(catalog)).toMatchObject({ transitions: [] });

    const deadSource = await recoveryFixture();
    const liveSibling = await addRun(deadSource, { runnerPid: 42_003 });
    const deadSourceStore = recoveryStore(deadSource, () => now, new Map([
      [deadSource.runnerPid, deadSource.processIdentity],
      [liveSibling.runnerPid, liveSibling.processIdentity]
    ]));
    await deadSourceStore.initialize();
    const deadSourceProof = await deadSourceStore.issue(issueInput(deadSource, accountId, now + 15_000));
    const liveSiblingProof = await deadSourceStore.issue(issueInput(liveSibling, accountId, now + 15_000));
    await deadSourceStore.beginTransition({
      recoveryId: deadSourceProof.snapshot.recoveryId,
      providerId: deadSource.providerId,
      accountId,
      authGeneration: "auth-1",
      sourceCatalogGeneration: 7
    });
    const deadStatusPath = join(deadSource.runRoot, managedSubagentSessionKey(deadSource.sessionId), deadSource.runId, "status.json");
    const deadStatus = JSON.parse(await readFile(deadStatusPath, "utf8")) as Record<string, unknown>;
    await writeFile(deadStatusPath, `${JSON.stringify({ ...deadStatus, state: "failed" })}\n`, { encoding: "utf8", mode: 0o600 });
    const afterSourceExit = recoveryStore(deadSource, () => now, new Map([
      [liveSibling.runnerPid, liveSibling.processIdentity]
    ]));
    await afterSourceExit.initialize();
    await expect(afterSourceExit.recover({
      ...scope(liveSibling),
      action: "validate",
      proof: liveSiblingProof.proof,
      descriptor: afterRefresh
    })).rejects.toThrow(/generation changed/iu);
    await expect(afterSourceExit.recover({
      ...scope(deadSource),
      action: "release",
      proof: deadSourceProof.proof,
      descriptor: afterRefresh
    })).resolves.toBeUndefined();

    const aborted = await recoveryFixture();
    const abortedStore = recoveryStore(aborted, () => now);
    await abortedStore.initialize();
    const abortedProof = await abortedStore.issue(issueInput(aborted, accountId, now + 15_000));
    const abortedTransitionInput = {
      recoveryId: abortedProof.snapshot.recoveryId,
      providerId: aborted.providerId,
      accountId,
      authGeneration: "auth-1",
      sourceCatalogGeneration: 7
    } as const;
    const firstAbortedTransition = await abortedStore.beginTransition(abortedTransitionInput);
    const duplicateAbortedTransition = await abortedStore.beginTransition(abortedTransitionInput);
    expect(duplicateAbortedTransition).toBe(firstAbortedTransition);
    expect((JSON.parse(await readFile(join(aborted.stateRoot, "leases.json"), "utf8")) as { transitions: unknown[] }).transitions)
      .toHaveLength(1);
    const abortedRestart = recoveryStore(aborted, () => now);
    await abortedRestart.initialize();
    await expect(abortedRestart.recover({
      ...scope(aborted),
      action: "validate",
      proof: abortedProof.proof,
      descriptor: descriptor(accountId)
    })).resolves.toMatchObject({ authGeneration: "auth-1", refreshSuperseded: false });
    expect(JSON.parse(await readFile(join(aborted.stateRoot, "leases.json"), "utf8")))
      .toMatchObject({ transitions: [] });
    await expect(abortedRestart.recover({
      ...scope(aborted),
      action: "validate",
      proof: abortedProof.proof,
      descriptor: descriptor(accountId, "auth-external", 8)
    })).rejects.toThrow(/generation changed/iu);

    for (const committed of [false, true]) {
      const terminal = await recoveryFixture();
      const terminalStore = recoveryStore(terminal, () => now);
      await terminalStore.initialize();
      const terminalProof = await terminalStore.issue(issueInput(terminal, accountId, now + 15_000));
      await terminalStore.beginTransition({
        recoveryId: terminalProof.snapshot.recoveryId,
        providerId: terminal.providerId,
        accountId,
        authGeneration: "auth-1",
        sourceCatalogGeneration: 7
      });
      const statusPath = join(terminal.runRoot, managedSubagentSessionKey(terminal.sessionId), terminal.runId, "status.json");
      const status = JSON.parse(await readFile(statusPath, "utf8")) as Record<string, unknown>;
      await writeFile(statusPath, `${JSON.stringify({ ...status, state: "completed" })}\n`, { encoding: "utf8", mode: 0o600 });
      const terminalRestart = recoveryStore(terminal, () => now);
      await terminalRestart.initialize();
      await expect(terminalRestart.recover({
        ...scope(terminal),
        action: "release",
        proof: terminalProof.proof,
        descriptor: committed ? afterRefresh : descriptor(accountId)
      })).resolves.toMatchObject({
        released: true,
        authGeneration: committed ? "auth-2" : "auth-1"
      });
      expect(JSON.parse(await readFile(join(terminal.stateRoot, "leases.json"), "utf8")))
        .toMatchObject({ transitions: [], records: [{ state: "released" }] });
    }
  });
});

interface RecoveryFixture {
  readonly agentHome: string;
  readonly runRoot: string;
  readonly stateRoot: string;
  readonly sessionId: string;
  readonly targetId: string;
  readonly serviceGeneration: number;
  readonly runnerProductGeneration: number;
  readonly providerId: string;
  readonly catalogGeneration: number;
  readonly runId: string;
  readonly runnerFence: string;
  readonly runnerPid: number;
  readonly runnerScriptSha256: string;
  readonly processIdentity: string;
  readonly runnerScript: string;
  readonly configPath: string;
  readonly trustedNodeExecutable: string;
}

interface SignedReservationFixture {
  readonly reservationId: string;
  readonly publicKey: string;
  readonly publicKeyDigest: string;
  readonly privateKey: KeyObject;
  lastNonce: string;
}

async function recoveryFixture(): Promise<RecoveryFixture> {
  const root = await mkdtemp(join(tmpdir(), "joko-native-recovery-"));
  temporaryDirectories.push(root);
  const agentHome = join(root, "agent-home");
  await mkdir(agentHome, { recursive: true, mode: 0o700 });
  return await addRun({
    agentHome,
    runRoot: managedSubagentRunRoot(agentHome),
    stateRoot: join(agentHome, "subagent-auth-recovery"),
    sessionId: `session-${randomUUID()}`,
    targetId: "target-native",
    serviceGeneration: 1,
    runnerProductGeneration: 1,
    providerId: "native-provider",
    catalogGeneration: 7,
    runId: randomUUID(),
    runnerFence: randomUUID(),
    runnerPid: 42_001,
    runnerScriptSha256: "",
    processIdentity: "a".repeat(64),
    runnerScript: "",
    configPath: "",
    trustedNodeExecutable: await realpath(process.execPath)
  });
}

async function addRun(base: RecoveryFixture, overrides: Partial<RecoveryFixture> = {}): Promise<RecoveryFixture> {
  const fixture: RecoveryFixture = {
    ...base,
    runId: overrides.runId ?? (base.runnerScriptSha256 === "" ? base.runId : randomUUID()),
    runnerFence: overrides.runnerFence ?? (base.runnerScriptSha256 === "" ? base.runnerFence : randomUUID()),
    runnerPid: overrides.runnerPid ?? base.runnerPid,
    processIdentity: overrides.processIdentity ?? base.processIdentity,
    runnerScriptSha256: ""
  };
  const sessionDirectory = join(fixture.runRoot, managedSubagentSessionKey(fixture.sessionId));
  const runDirectory = join(sessionDirectory, fixture.runId);
  await mkdir(runDirectory, { recursive: true, mode: 0o700 });
  const runnerScript = join(runDirectory, "joko-managed-subagent-runner.cjs");
  const runnerSource = `"use strict";\n`;
  const runnerScriptSha256 = createHash("sha256").update(runnerSource).digest("hex");
  const launchToken = randomUUID();
  const taskId = `task-${fixture.runId}`;
  const common = {
    format: 1,
    runId: fixture.runId,
    launchToken,
    productSessionId: fixture.sessionId,
    taskId,
    runnerScript,
    runnerScriptSha256
  };
  await Promise.all([
    writeFile(runnerScript, runnerSource, { encoding: "utf8", mode: 0o600 }),
    writeFile(join(runDirectory, "config.json"), `${JSON.stringify({
      ...common,
      runDir: runDirectory,
      productGeneration: fixture.runnerProductGeneration,
      nativeAuthRequired: true,
      route: { provider: fixture.providerId }
    })}\n`, { encoding: "utf8", mode: 0o600 }),
    writeFile(join(runDirectory, "status.json"), `${JSON.stringify({
      ...common,
      state: "running",
      runnerPid: fixture.runnerPid,
      runnerInstanceId: fixture.runnerFence
    })}\n`, { encoding: "utf8", mode: 0o600 }),
    writeFile(join(runDirectory, "owner.json"), `${JSON.stringify({
      ...common,
      state: "running",
      runnerPid: fixture.runnerPid,
      runnerInstanceId: fixture.runnerFence
    })}\n`, { encoding: "utf8", mode: 0o600 }),
    writeFile(join(runDirectory, "runner.claim.json"), `${JSON.stringify({
      ...common,
      runnerPid: fixture.runnerPid,
      runnerInstanceId: fixture.runnerFence
    })}\n`, { encoding: "utf8", mode: 0o600 })
  ]);
  const complete = {
    ...fixture,
    runnerScriptSha256,
    runnerScript,
    configPath: join(runDirectory, "config.json")
  };
  testProcesses.set(complete.runnerPid, {
    runnerScript: complete.runnerScript,
    configPath: complete.configPath,
    processIdentity: complete.processIdentity
  });
  return complete;
}

function recoveryStore(
  fixture: RecoveryFixture,
  now: () => number,
  identity: string | ReadonlyMap<number, string> = fixture.processIdentity
): NativeAuthRecoveryStore {
  return new NativeAuthRecoveryStore({
    runRoot: fixture.runRoot,
    stateRoot: fixture.stateRoot,
    now,
    trustedRunnerScriptSha256: fixture.runnerScriptSha256,
    trustedNodeExecutable: fixture.trustedNodeExecutable,
    inspectRunnerProcess: async (pid) => {
      const processFixture = testProcesses.get(pid);
      const processIdentity = typeof identity === "string" ? identity : identity.get(pid);
      return processFixture === undefined || processIdentity === undefined ? undefined : {
        executablePath: fixture.trustedNodeExecutable,
        argv: [fixture.trustedNodeExecutable, processFixture.runnerScript, processFixture.configPath],
        processIdentity
      };
    }
  });
}

function scope(fixture: RecoveryFixture) {
  return {
    sessionId: fixture.sessionId,
    targetId: fixture.targetId,
    serviceGeneration: fixture.serviceGeneration,
    runnerProductGeneration: fixture.runnerProductGeneration,
    providerId: fixture.providerId,
    catalogGeneration: fixture.catalogGeneration,
    runId: fixture.runId,
    runnerFence: fixture.runnerFence
  } as const;
}

function issueInput(fixture: RecoveryFixture, accountId: string, expiresAt: number): NativeAuthRecoveryIssueInput {
  return {
    ...scope(fixture),
    bearerDigest: "e".repeat(64),
    accountId,
    authGeneration: "auth-1",
    sourceCatalogGeneration: fixture.catalogGeneration,
    expiresAt,
    runnerEvidence: { kind: "local", runnerPid: fixture.runnerPid }
  };
}

function descriptor(accountId: string, authGeneration = "auth-1", catalogGeneration = 7): NativeAuthRecoveryDescriptor {
  return { accountId, authGeneration, catalogGeneration, authenticated: true };
}

async function reserveSignedRunner(
  store: NativeAuthRecoveryStore,
  fixture: RecoveryFixture,
  expiresAt: number
): Promise<SignedReservationFixture> {
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const publicKeyDigest = createHash("sha256").update(publicKey).digest("hex");
  const reserved = await store.reserve({ ...scope(fixture), publicKey, expiresAt });
  const directory = join(fixture.runRoot, managedSubagentSessionKey(fixture.sessionId), fixture.runId);
  for (const name of ["config.json", "status.json", "owner.json", "runner.claim.json"]) {
    const path = join(directory, name);
    const manifest = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    await writeFile(path, `${JSON.stringify({
      ...manifest,
      nativeAuthReservationId: reserved.reservationId,
      runnerPublicKeyDigest: publicKeyDigest,
      ...(name === "config.json" ? {
        nativeAuthServiceGeneration: fixture.serviceGeneration,
        runnerPublicKey: publicKey
      } : {})
    })}\n`, { encoding: "utf8", mode: 0o600 });
  }
  return {
    reservationId: reserved.reservationId,
    publicKey,
    publicKeyDigest,
    privateKey: keys.privateKey,
    lastNonce: ""
  };
}

function signedRunnerEvidence(
  store: NativeAuthRecoveryStore,
  fixture: RecoveryFixture,
  reservation: SignedReservationFixture,
  action: "acquire" | "validate" | "release",
  recoveryProof?: string,
  credential?: unknown
) {
  const credentialDigest = createHash("sha256").update(
    credential === undefined ? "" : JSON.stringify(credential)
  ).digest("hex");
  return store.verifyRunnerProof({
    ...scope(fixture),
    action,
    proof: signedProof(fixture, reservation, action, recoveryProof, credential),
    ...(recoveryProof === undefined ? {} : { recoveryProof }),
    credentialDigest,
    location: "local"
  });
}

function signedRemoteRunnerEvidence(
  store: NativeAuthRecoveryStore,
  fixture: RecoveryFixture,
  reservation: SignedReservationFixture,
  action: "acquire" | "validate" | "release",
  recoveryProof?: string
) {
  const proof = signedProof(fixture, reservation, action, recoveryProof);
  return store.verifyRunnerProof({
    ...scope(fixture),
    action,
    proof,
    ...(recoveryProof === undefined ? {} : { recoveryProof }),
    credentialDigest: createHash("sha256").update("").digest("hex"),
    location: "remote",
    depthEvidence: {
      kind: "remote",
      runnerPid: fixture.runnerPid,
      processIdentity: "1".repeat(64),
      bindingDigest: recoveryBindingDigest(scope(fixture)),
      runRootDigest: "2".repeat(64),
      runnerScriptSha256: fixture.runnerScriptSha256,
      configDigest: "3".repeat(64),
      ownerDigest: "4".repeat(64),
      claimDigest: "5".repeat(64),
      nonceDigest: createHash("sha256").update(randomUUID()).digest("hex")
    }
  });
}

function signedProof(
  fixture: RecoveryFixture,
  reservation: SignedReservationFixture,
  action: "acquire" | "validate" | "release",
  recoveryProof?: string,
  credential?: unknown
) {
  const nonce = randomBytes(32).toString("base64url");
  reservation.lastNonce = nonce;
  const credentialDigest = createHash("sha256").update(
    credential === undefined ? "" : JSON.stringify(credential)
  ).digest("hex");
  const message = JSON.stringify([
    "joko.pi-native-auth.runner-proof.v1",
    action,
    reservation.reservationId,
    fixture.sessionId,
    fixture.targetId,
    fixture.serviceGeneration,
    fixture.runnerProductGeneration,
    fixture.providerId,
    fixture.catalogGeneration,
    fixture.runId,
    fixture.runnerFence,
    fixture.runnerPid,
    recoveryProof ?? "",
    credentialDigest,
    nonce
  ]);
  return {
    format: 1 as const,
    reservationId: reservation.reservationId,
    runnerPid: fixture.runnerPid,
    nonce,
    signature: sign(null, Buffer.from(message, "utf8"), reservation.privateKey).toString("base64url")
  };
}
