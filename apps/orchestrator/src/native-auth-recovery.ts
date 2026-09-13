import { createHash, createHmac, createPublicKey, randomBytes, randomUUID, timingSafeEqual, verify } from "node:crypto";
import { constants as FS_CONSTANTS } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import {
  createManagedSubagentRunnerProcessInspector,
  validateManagedSubagentRecoveryRun,
  type ManagedSubagentRunnerProcessInspection
} from "@joko/adapter-pi";

const RECOVERY_FORMAT = 1;
const MAXIMUM_CATALOG_BYTES = 2 * 1024 * 1024;
const MAXIMUM_RECORDS = 4_096;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const PROOF_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export interface NativeAuthRecoveryScope {
  readonly sessionId: string;
  readonly targetId: string;
  /** Service route generation selected when the lease was acquired. */
  readonly serviceGeneration: number;
  /** Immutable generation embedded in the detached runner's durable config. */
  readonly runnerProductGeneration: number;
  readonly providerId: string;
  readonly catalogGeneration: number;
  readonly runId: string;
  readonly runnerFence: string;
}

export interface NativeAuthRecoveryLocalRunnerEvidence {
  readonly kind: "local";
  readonly runnerPid: number;
}

/**
 * Capability-neutral result of a fresh, service-authenticated remote broker
 * attestation. The MAC and bearer that produced it are deliberately absent.
 */
export interface NativeAuthRecoveryRemoteRunnerEvidence {
  readonly kind: "remote";
  readonly runnerPid: number;
  readonly processIdentity: string;
  readonly bindingDigest: string;
  readonly runRootDigest: string;
  readonly runnerScriptSha256: string;
  readonly configDigest: string;
  readonly ownerDigest: string;
  readonly claimDigest: string;
  readonly nonceDigest: string;
}

export interface NativeAuthRunnerProof {
  readonly format: 1;
  readonly reservationId: string;
  readonly runnerPid: number;
  readonly nonce: string;
  readonly signature: string;
}

export interface NativeAuthRecoverySignedRunnerEvidence {
  readonly kind: "signed";
  readonly reservationId: string;
  readonly runnerPid: number;
  readonly publicKeyDigest: string;
  readonly nonceDigest: string;
  readonly location: "local" | "remote";
  readonly depthEvidence?: NativeAuthRecoveryRemoteRunnerEvidence;
}

export type NativeAuthRecoveryRunnerEvidence =
  | NativeAuthRecoveryLocalRunnerEvidence
  | NativeAuthRecoveryRemoteRunnerEvidence
  | NativeAuthRecoverySignedRunnerEvidence;

export interface RemoteNativeAuthRunnerAttestation {
  readonly format: 1;
  readonly action: "acquire" | "validate" | "release";
  readonly issuedAt: number;
  readonly nonce: string;
  readonly bindingDigest: string;
  readonly runnerPid: number;
  readonly processIdentity: string;
  readonly runRootDigest: string;
  readonly runnerScriptDigest: string;
  readonly configDigest: string;
  readonly statusDigest: string;
  readonly ownerDigest: string;
  readonly claimDigest: string;
  readonly mac: string;
}

export interface VerifyRemoteNativeAuthRunnerAttestationInput extends NativeAuthRecoveryScope {
  readonly action: "acquire" | "validate" | "release";
  readonly bearer: string;
  readonly attestation: RemoteNativeAuthRunnerAttestation;
  readonly trustedRunnerScriptSha256: string;
  readonly now?: number;
}

export interface NativeAuthRecoveryDescriptor {
  readonly accountId: string;
  readonly authGeneration: string;
  readonly catalogGeneration: number;
  readonly authenticated: boolean;
}

export interface NativeAuthRecoveryIssueInput extends NativeAuthRecoveryScope {
  readonly bearerDigest: string;
  readonly accountId: string;
  readonly authGeneration: string;
  readonly sourceCatalogGeneration: number;
  readonly expiresAt: number;
  readonly runnerEvidence: NativeAuthRecoveryRunnerEvidence;
}

export interface NativeAuthRecoverySnapshot extends NativeAuthRecoveryScope {
  readonly recoveryId: string;
  readonly authGeneration: string;
  readonly sourceCatalogGeneration: number;
  readonly expiresAt: number;
  readonly refreshSuperseded: boolean;
  readonly released: boolean;
}

export interface NativeAuthRecoveryPort {
  initialize(): Promise<void>;
  reserve(input: NativeAuthRecoveryScope & {
    readonly publicKey: string;
    readonly expiresAt: number;
  }): Promise<{ readonly reservationId: string; readonly expiresAt: number }>;
  verifyRunnerProof(input: NativeAuthRecoveryScope & {
    readonly action: "acquire" | "validate" | "release";
    readonly proof: NativeAuthRunnerProof;
    readonly recoveryProof?: string;
    readonly credentialDigest: string;
    readonly location: "local" | "remote";
    readonly depthEvidence?: NativeAuthRecoveryRemoteRunnerEvidence;
  }): NativeAuthRecoverySignedRunnerEvidence;
  issue(input: NativeAuthRecoveryIssueInput): Promise<{
    readonly proof: string;
    readonly snapshot: NativeAuthRecoverySnapshot;
  }>;
  recover(input: NativeAuthRecoveryScope & {
    readonly action: "validate" | "release";
    readonly proof: string;
    readonly descriptor: NativeAuthRecoveryDescriptor;
    readonly runnerEvidence?: NativeAuthRecoveryRemoteRunnerEvidence | NativeAuthRecoverySignedRunnerEvidence;
  }): Promise<NativeAuthRecoverySnapshot | undefined>;
  reissue(input: NativeAuthRecoveryScope & {
    readonly bearerDigest: string;
    readonly descriptor: NativeAuthRecoveryDescriptor;
    readonly runnerEvidence: NativeAuthRecoveryRunnerEvidence;
  }): Promise<{
    readonly proof: string;
    readonly snapshot: NativeAuthRecoverySnapshot;
  } | undefined>;
  renew(input: {
    readonly recoveryId: string;
    readonly expiresAt: number;
    readonly authGeneration: string;
    readonly sourceCatalogGeneration: number;
    readonly refreshSuperseded: boolean;
  }): Promise<void>;
  beginTransition(input: {
    readonly recoveryId: string;
    readonly providerId: string;
    readonly accountId: string;
    readonly authGeneration: string;
    readonly sourceCatalogGeneration: number;
  }): Promise<string | undefined>;
  commitTransition(input: {
    readonly transitionId: string | undefined;
    readonly descriptor: NativeAuthRecoveryDescriptor;
  }): Promise<void>;
  abortTransition(transitionId: string | undefined): Promise<void>;
  complete(recoveryId: string, expiresAt: number): Promise<void>;
  revoke(recoveryId: string): Promise<void>;
  revokeScope(input: {
    readonly sessionId: string;
    readonly targetId: string;
  }): Promise<number>;
}

interface RecoveryRecord extends NativeAuthRecoveryScope {
  digest: string;
  readonly bearerDigest: string;
  readonly accountDigest: string;
  authGeneration: string;
  sourceCatalogGeneration: number;
  readonly runnerPid: number;
  readonly processIdentity: string;
  readonly runnerScriptSha256: string;
  readonly runnerKind: "local" | "remote" | "signed_local" | "signed_remote";
  readonly remoteBindingDigest?: string;
  readonly remoteRunRootDigest?: string;
  readonly remoteConfigDigest?: string;
  readonly remoteOwnerDigest?: string;
  readonly remoteClaimDigest?: string;
  remoteNonceDigest?: string;
  readonly signedReservationId?: string;
  readonly signedPublicKey?: string;
  readonly signedPublicKeyDigest?: string;
  signedNonceDigest?: string;
  refreshSuperseded: boolean;
  state: "active" | "released" | "transition_source";
  expiresAt: number;
  tombstoneExpiresAt?: number;
}

interface RunnerReservation extends NativeAuthRecoveryScope {
  readonly id: string;
  readonly publicKey: string;
  readonly publicKeyDigest: string;
  readonly runnerScriptSha256: string;
  readonly expiresAt: number;
}

interface RecoveryTransition {
  readonly id: string;
  readonly sourceDigest: string;
  readonly providerId: string;
  readonly accountDigest: string;
  readonly authGeneration: string;
  readonly sourceCatalogGeneration: number;
  readonly createdAt: number;
}

interface RecoveryCatalog {
  readonly format: typeof RECOVERY_FORMAT;
  records: RecoveryRecord[];
  transitions: RecoveryTransition[];
  reservations: RunnerReservation[];
}

export interface NativeAuthRecoveryStoreOptions {
  readonly runRoot: string;
  readonly stateRoot: string;
  readonly trustedRunnerScriptSha256: string;
  readonly trustedNodeExecutable: string;
  readonly inspectRunnerProcess?: (pid: number) => Promise<ManagedSubagentRunnerProcessInspection | undefined>;
  readonly now?: () => number;
}

/**
 * Durable, capability-neutral proof registry for already-running managed native
 * auth leases. It stores only proof digests and immutable runner lineage. It
 * cannot mint or reconstruct an MCP grant and exposes no Tool route.
 */
export class NativeAuthRecoveryStore implements NativeAuthRecoveryPort {
  readonly #runRoot: string;
  readonly #stateRoot: string;
  readonly #catalogPath: string;
  readonly #trustedRunnerScriptSha256: string;
  readonly #trustedNodeExecutable: string;
  readonly #inspectRunnerProcess: (pid: number) => Promise<ManagedSubagentRunnerProcessInspection | undefined>;
  readonly #now: () => number;
  #catalog: RecoveryCatalog = emptyCatalog();
  #initialized = false;
  #tail: Promise<void> = Promise.resolve();

  constructor(options: NativeAuthRecoveryStoreOptions) {
    if (!isNormalizedAbsolute(options.runRoot) || !isNormalizedAbsolute(options.stateRoot)
        || !isNormalizedAbsolute(options.trustedNodeExecutable)
        || !DIGEST_PATTERN.test(options.trustedRunnerScriptSha256)
        || samePath(options.runRoot, options.stateRoot)) {
      throw new Error("Native auth recovery roots are invalid.");
    }
    this.#runRoot = options.runRoot;
    this.#stateRoot = options.stateRoot;
    this.#catalogPath = join(options.stateRoot, "leases.json");
    this.#trustedRunnerScriptSha256 = options.trustedRunnerScriptSha256;
    this.#trustedNodeExecutable = options.trustedNodeExecutable;
    this.#inspectRunnerProcess = options.inspectRunnerProcess ?? createManagedSubagentRunnerProcessInspector();
    this.#now = options.now ?? Date.now;
  }

  async initialize(): Promise<void> {
    if (this.#initialized) return;
    await assertCanonicalDirectory(dirname(this.#stateRoot));
    const existingRoot = await lstat(this.#stateRoot).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (existingRoot === undefined) await mkdir(this.#stateRoot, { recursive: false, mode: 0o700 });
    await assertCanonicalDirectory(this.#stateRoot);
    await chmod(this.#stateRoot, 0o700);
    const catalog = await this.#readCatalog();
    const retained: RecoveryRecord[] = [];
    let catalogChanged = false;
    const transitionSources = new Set(catalog.transitions.map((transition) => transition.sourceDigest));
    for (const record of catalog.records) {
      if (effectiveExpiry(record) <= this.#now()) continue;
      if (record.state === "released") {
        retained.push(record);
        continue;
      }
      if ((record.runnerKind === "remote" || record.runnerKind === "signed_remote") && record.state === "active") {
        // A remote process can only be re-attested by the trusted broker on a
        // concrete request. Startup preserves non-secret metadata but restores
        // no authority by itself.
        retained.push(record);
        continue;
      }
      if (record.runnerKind === "signed_local" && record.state === "active"
          && await this.#signedLocalLineageMatches(record, false)) {
        retained.push(record);
        continue;
      }
      if (record.state !== "transition_source" && await this.#runnerMatches(record)) {
        retained.push(record);
        continue;
      }
      if (transitionSources.has(record.digest)
          && await this.#transitionSourceLineageMatches(record)) {
        if (record.state !== "transition_source") catalogChanged = true;
        record.state = "transition_source";
        retained.push(record);
      }
    }
    const digests = new Set(retained.map((record) => record.digest));
    const transitions = catalog.transitions.filter((transition) => digests.has(transition.sourceDigest));
    const reservations = catalog.reservations.filter((reservation) => reservation.expiresAt > this.#now());
    this.#catalog = { format: RECOVERY_FORMAT, records: retained, transitions, reservations };
    this.#initialized = true;
    if (catalogChanged || retained.length !== catalog.records.length || transitions.length !== catalog.transitions.length
        || reservations.length !== catalog.reservations.length) {
      await this.#writeCatalog();
    }
  }

  async reserve(input: NativeAuthRecoveryScope & {
    readonly publicKey: string;
    readonly expiresAt: number;
  }): Promise<{ readonly reservationId: string; readonly expiresAt: number }> {
    this.#assertInitialized();
    if (!validScope(input) || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= this.#now()
        || input.expiresAt - this.#now() > 60_000) {
      throw new Error("Native auth runner reservation scope is invalid.");
    }
    const publicKey = normalizedEd25519PublicKey(input.publicKey);
    const publicKeyDigest = digestPublicKey(publicKey);
    const reservation: RunnerReservation = {
      ...input,
      id: randomUUID(),
      publicKey,
      publicKeyDigest,
      runnerScriptSha256: this.#trustedRunnerScriptSha256
    };
    const stored = await this.#withLock(async () => {
      this.#purgeExpired();
      const existing = this.#catalog.reservations.find((candidate) => candidate.runId === input.runId
        && candidate.runnerFence === input.runnerFence);
      if (existing !== undefined) {
        if (existing.publicKeyDigest !== publicKeyDigest || !reservationScopeMatches(existing, input)) {
          throw new Error("Native auth runner reservation uniqueness fence was exceeded.");
        }
        return existing;
      }
      if (this.#catalog.records.some((record) => record.runId === input.runId
          && record.runnerFence === input.runnerFence)) {
        throw new Error("Native auth runner reservation uniqueness fence was exceeded.");
      }
      if (this.#catalog.records.length + this.#catalog.reservations.length >= MAXIMUM_RECORDS
      ) {
        throw new Error("Native auth runner reservation capacity or uniqueness fence was exceeded.");
      }
      this.#catalog.reservations.push(reservation);
      await this.#writeCatalog();
      return reservation;
    });
    return { reservationId: stored.id, expiresAt: stored.expiresAt };
  }

  verifyRunnerProof(input: NativeAuthRecoveryScope & {
    readonly action: "acquire" | "validate" | "release";
    readonly proof: NativeAuthRunnerProof;
    readonly recoveryProof?: string;
    readonly credentialDigest: string;
    readonly location: "local" | "remote";
    readonly depthEvidence?: NativeAuthRecoveryRemoteRunnerEvidence;
  }): NativeAuthRecoverySignedRunnerEvidence {
    this.#assertInitialized();
    const proof = input.proof;
    if (!validScope(input) || proof.format !== 1 || !UUID_PATTERN.test(proof.reservationId)
        || !Number.isSafeInteger(proof.runnerPid) || proof.runnerPid < 1
        || !PROOF_PATTERN.test(proof.nonce) || !/^[A-Za-z0-9_-]{86}$/u.test(proof.signature)
        || !DIGEST_PATTERN.test(input.credentialDigest)
        || (input.recoveryProof !== undefined && !PROOF_PATTERN.test(input.recoveryProof))) {
      throw new Error("Native auth runner proof is invalid.");
    }
    const reservation = this.#catalog.reservations.find((candidate) => candidate.id === proof.reservationId);
    const record = this.#catalog.records.find((candidate) => candidate.signedReservationId === proof.reservationId);
    const publicKey = reservation?.publicKey ?? record?.signedPublicKey;
    const publicKeyDigest = reservation?.publicKeyDigest ?? record?.signedPublicKeyDigest;
    if (publicKey === undefined || publicKeyDigest === undefined
        || reservation !== undefined && reservation.expiresAt <= this.#now()
        || record !== undefined && effectiveExpiry(record) <= this.#now()
        || reservation !== undefined && !reservationScopeMatches(reservation, input)
        || record !== undefined && !signedRecordScopeMatches(record, input)) {
      throw new Error("Native auth runner proof is outside its reservation scope.");
    }
    const message = signedRunnerMessage(input, proof);
    const signature = Buffer.from(proof.signature, "base64url");
    if (signature.byteLength !== 64 || !verify(null, Buffer.from(message, "utf8"), createPublicKey({
      key: Buffer.from(publicKey, "base64url"),
      format: "der",
      type: "spki"
    }), signature)) {
      throw new Error("Native auth runner proof signature is invalid.");
    }
    return {
      kind: "signed",
      reservationId: proof.reservationId,
      runnerPid: proof.runnerPid,
      publicKeyDigest,
      nonceDigest: createHash("sha256").update(proof.nonce, "utf8").digest("hex"),
      location: input.location,
      ...(input.depthEvidence === undefined ? {} : { depthEvidence: input.depthEvidence })
    };
  }

  async issue(input: NativeAuthRecoveryIssueInput): Promise<{
    readonly proof: string;
    readonly snapshot: NativeAuthRecoverySnapshot;
  }> {
    this.#assertInitialized();
    assertIssueInput(input, this.#now());
    const runner = await this.#validateIssueRunner(input);
    const proof = randomBytes(32).toString("base64url");
    const digest = digestProof(proof).toString("hex");
    const record: RecoveryRecord = {
      digest,
      bearerDigest: input.bearerDigest,
      sessionId: input.sessionId,
      targetId: input.targetId,
      serviceGeneration: input.serviceGeneration,
      runnerProductGeneration: input.runnerProductGeneration,
      providerId: input.providerId,
      catalogGeneration: input.catalogGeneration,
      accountDigest: digestIdentity(input.accountId),
      authGeneration: input.authGeneration,
      sourceCatalogGeneration: input.sourceCatalogGeneration,
      runId: input.runId,
      runnerFence: input.runnerFence,
      runnerPid: runner.runnerPid,
      processIdentity: runner.processIdentity,
      runnerScriptSha256: runner.runnerScriptSha256,
      runnerKind: runner.kind === "signed" ? `signed_${runner.location}` : runner.kind,
      ...(runner.kind === "remote" || runner.kind === "signed" && runner.location === "remote" && runner.depthEvidence !== undefined ? {
        remoteBindingDigest: runner.bindingDigest,
        remoteRunRootDigest: runner.runRootDigest,
        remoteConfigDigest: runner.configDigest,
        remoteOwnerDigest: runner.ownerDigest,
        remoteClaimDigest: runner.claimDigest,
        remoteNonceDigest: runner.nonceDigest
      } : {}),
      ...(runner.kind !== "signed" ? {} : {
        signedReservationId: runner.reservationId,
        signedPublicKey: runner.publicKey,
        signedPublicKeyDigest: runner.publicKeyDigest,
        signedNonceDigest: runner.nonceDigest
      }),
      refreshSuperseded: false,
      state: "active",
      expiresAt: input.expiresAt
    };
    await this.#withLock(async () => {
      this.#purgeExpired();
      if (this.#catalog.records.length >= MAXIMUM_RECORDS
          || this.#catalog.records.some((candidate) => candidate.digest === digest
            || candidate.runId === input.runId && candidate.runnerFence === input.runnerFence && candidate.state === "active")) {
        throw new Error("Native auth recovery capacity or runner uniqueness fence was exceeded.");
      }
      if (runner.kind === "signed") {
        const reservationIndex = this.#catalog.reservations.findIndex((candidate) => candidate.id === runner.reservationId
          && candidate.publicKeyDigest === runner.publicKeyDigest && candidate.expiresAt > this.#now());
        if (reservationIndex < 0) throw new Error("Native auth runner reservation is unavailable.");
        this.#catalog.reservations.splice(reservationIndex, 1);
      }
      this.#catalog.records.push(record);
      await this.#writeCatalog();
    });
    return { proof, snapshot: snapshot(record) };
  }

  async recover(input: NativeAuthRecoveryScope & {
    readonly action: "validate" | "release";
    readonly proof: string;
    readonly descriptor: NativeAuthRecoveryDescriptor;
    readonly runnerEvidence?: NativeAuthRecoveryRemoteRunnerEvidence | NativeAuthRecoverySignedRunnerEvidence;
  }): Promise<NativeAuthRecoverySnapshot | undefined> {
    this.#assertInitialized();
    if (!PROOF_PATTERN.test(input.proof)) return undefined;
    const proofDigest = digestProof(input.proof);
    return await this.#withLock(async () => {
      this.#purgeExpired();
      const record = this.#findByDigest(proofDigest);
      if (record === undefined) return undefined;
      assertExactScope(record, input);
      if (record.state === "transition_source") {
        if (input.action !== "release") throw new Error("Native auth recovery runner is no longer active.");
        if (!await this.#runnerMatches(record, input.runnerEvidence, true)) {
          this.#removeRecord(record.digest);
          await this.#writeCatalog();
          throw new Error("Native auth recovery runner identity changed.");
        }
        const transition = this.#matchingTransition(record);
        if (transition === undefined) {
          this.#removeRecord(record.digest);
          await this.#writeCatalog();
          throw new Error("Native auth recovery transition is unavailable.");
        }
        const descriptorIsCurrent = descriptorMatches(record, input.descriptor);
        if (!descriptorIsCurrent && (input.descriptor.authenticated !== true
            || !identityMatches(record.accountDigest, input.descriptor.accountId)
            || !validGeneration(input.descriptor.authGeneration)
            || !Number.isSafeInteger(input.descriptor.catalogGeneration)
            || input.descriptor.catalogGeneration < 0)) {
          this.#removeRecord(record.digest);
          await this.#writeCatalog();
          throw new Error("Native auth recovery account or generation changed.");
        }
        this.#rotateRunnerNonces(record, input.runnerEvidence);
        if (descriptorIsCurrent) {
          // Crash before persist: no credential transition committed. The
          // terminal source can still close its exact proof idempotently.
          record.state = "active";
          this.#removeTransitionGeneration(transition);
        } else {
          // Crash after persist: temporarily make the exact source active so
          // the generation-wide CAS applies, then retain only an inert release
          // tombstone for idempotent terminal acknowledgement.
          record.state = "active";
          this.#applyTransition(transition, input.descriptor);
        }
        record.state = "released";
        record.tombstoneExpiresAt = Math.max(this.#now() + 1, record.expiresAt);
        await this.#writeCatalog();
        return snapshot(record);
      }
      if (record.state === "released") {
        if (input.action !== "release") throw new Error("Native auth recovery lease is released.");
        return snapshot(record);
      }
      if (!await this.#runnerMatches(record, input.runnerEvidence)) {
        throw new Error("Native auth recovery runner identity changed.");
      }
      const transition = this.#matchingTransition(record);
      const descriptorChanged = !descriptorMatches(record, input.descriptor);
      if (descriptorChanged && (transition === undefined || input.descriptor.authenticated !== true
          || !identityMatches(record.accountDigest, input.descriptor.accountId) || input.descriptor.authGeneration.length < 1
          || !Number.isSafeInteger(input.descriptor.catalogGeneration) || input.descriptor.catalogGeneration < 0)) {
        this.#removeRecord(record.digest);
        await this.#writeCatalog();
        throw new Error("Native auth recovery account or generation changed.");
      }
      let catalogChanged = this.#rotateRunnerNonces(record, input.runnerEvidence);
      if (descriptorMatches(record, input.descriptor)) {
        if (transition !== undefined) {
          this.#removeTransitionGeneration(transition);
          catalogChanged = true;
        }
      } else {
        this.#applyTransition(transition!, input.descriptor);
        catalogChanged = true;
      }
      if (catalogChanged) await this.#writeCatalog();
      const current = this.#catalog.records.find((candidate) => candidate.digest === record.digest);
      return current === undefined ? undefined : snapshot(current);
    });
  }

  async reissue(input: NativeAuthRecoveryScope & {
    readonly bearerDigest: string;
    readonly descriptor: NativeAuthRecoveryDescriptor;
    readonly runnerEvidence: NativeAuthRecoveryRunnerEvidence;
  }): Promise<{
    readonly proof: string;
    readonly snapshot: NativeAuthRecoverySnapshot;
  } | undefined> {
    this.#assertInitialized();
    if (!validScope(input)) throw new Error("Native auth recovery reissue scope is invalid.");
    return await this.#withLock(async () => {
      this.#purgeExpired();
      const candidates = this.#catalog.records.filter((record) => record.state === "active"
        && record.runId === input.runId && record.runnerFence === input.runnerFence);
      if (candidates.length === 0) return undefined;
      if (candidates.length !== 1) throw new Error("Native auth recovery runner identity is ambiguous.");
      const record = candidates[0]!;
      assertExactScope(record, input);
      if (!descriptorMatches(record, input.descriptor)
          || this.#catalog.transitions.some((transition) => transition.sourceDigest === record.digest)) {
        throw new Error("Native auth recovery generation cannot be reissued.");
      }
      const runnerMatches = input.runnerEvidence.kind === "local"
        ? record.runnerKind === "local" && digestMatches(record.bearerDigest, input.bearerDigest)
          && input.runnerEvidence.runnerPid === record.runnerPid
          && await this.#runnerMatches(record)
        : await this.#runnerMatches(record, input.runnerEvidence);
      if (!runnerMatches) throw new Error("Native auth recovery runner identity changed.");
      this.#rotateRunnerNonces(record, input.runnerEvidence.kind === "local" ? undefined : input.runnerEvidence);
      const proof = randomBytes(32).toString("base64url");
      const digest = digestProof(proof).toString("hex");
      if (this.#catalog.records.some((candidate) => candidate !== record && candidate.digest === digest)) {
        throw new Error("Native auth recovery proof collision was detected.");
      }
      record.digest = digest;
      await this.#writeCatalog();
      return { proof, snapshot: snapshot(record) };
    });
  }

  async renew(input: {
    readonly recoveryId: string;
    readonly expiresAt: number;
    readonly authGeneration: string;
    readonly sourceCatalogGeneration: number;
    readonly refreshSuperseded: boolean;
  }): Promise<void> {
    this.#assertInitialized();
    if (!DIGEST_PATTERN.test(input.recoveryId) || !validGeneration(input.authGeneration)
        || !Number.isSafeInteger(input.sourceCatalogGeneration) || input.sourceCatalogGeneration < 0
        || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= this.#now()) {
      throw new Error("Native auth recovery renewal is invalid.");
    }
    await this.#withLock(async () => {
      const record = this.#catalog.records.find((candidate) => candidate.digest === input.recoveryId && candidate.state === "active");
      if (record === undefined || record.authGeneration !== input.authGeneration
          || record.sourceCatalogGeneration !== input.sourceCatalogGeneration
          || record.refreshSuperseded !== input.refreshSuperseded) {
        throw new Error("Native auth recovery renewal crossed a generation fence.");
      }
      record.expiresAt = input.expiresAt;
      await this.#writeCatalog();
    });
  }

  async beginTransition(input: {
    readonly recoveryId: string;
    readonly providerId: string;
    readonly accountId: string;
    readonly authGeneration: string;
    readonly sourceCatalogGeneration: number;
  }): Promise<string | undefined> {
    this.#assertInitialized();
    if (!DIGEST_PATTERN.test(input.recoveryId)) return undefined;
    return await this.#withLock(async () => {
      const record = this.#catalog.records.find((candidate) => candidate.digest === input.recoveryId && candidate.state === "active");
      if (record === undefined || record.providerId !== input.providerId || !identityMatches(record.accountDigest, input.accountId)
          || record.authGeneration !== input.authGeneration
          || record.sourceCatalogGeneration !== input.sourceCatalogGeneration) {
        throw new Error("Native auth recovery transition crossed a generation fence.");
      }
      const existing = this.#matchingTransition(record);
      if (existing !== undefined) return existing.id;
      const transition: RecoveryTransition = {
        id: randomUUID(),
        sourceDigest: record.digest,
        providerId: record.providerId,
        accountDigest: record.accountDigest,
        authGeneration: record.authGeneration,
        sourceCatalogGeneration: record.sourceCatalogGeneration,
        createdAt: this.#now()
      };
      this.#catalog.transitions.push(transition);
      await this.#writeCatalog();
      return transition.id;
    });
  }

  async commitTransition(input: {
    readonly transitionId: string | undefined;
    readonly descriptor: NativeAuthRecoveryDescriptor;
  }): Promise<void> {
    this.#assertInitialized();
    if (input.transitionId === undefined) return;
    await this.#withLock(async () => {
      const transition = this.#catalog.transitions.find((candidate) => candidate.id === input.transitionId);
      if (transition === undefined) throw new Error("Native auth recovery transition is unavailable.");
      if (input.descriptor.authenticated !== true || !identityMatches(transition.accountDigest, input.descriptor.accountId)
          || !validGeneration(input.descriptor.authGeneration)
          || !Number.isSafeInteger(input.descriptor.catalogGeneration) || input.descriptor.catalogGeneration < 0) {
        throw new Error("Native auth recovery transition changed account.");
      }
      this.#applyTransition(transition, input.descriptor);
      await this.#writeCatalog();
    });
  }

  async abortTransition(transitionId: string | undefined): Promise<void> {
    this.#assertInitialized();
    if (transitionId === undefined) return;
    await this.#withLock(async () => {
      const previousLength = this.#catalog.transitions.length;
      this.#catalog.transitions = this.#catalog.transitions.filter((candidate) => candidate.id !== transitionId);
      if (this.#catalog.transitions.length !== previousLength) await this.#writeCatalog();
    });
  }

  async complete(recoveryId: string, expiresAt: number): Promise<void> {
    this.#assertInitialized();
    if (!DIGEST_PATTERN.test(recoveryId)) return;
    await this.#withLock(async () => {
      const record = this.#catalog.records.find((candidate) => candidate.digest === recoveryId);
      if (record === undefined) return;
      record.state = "released";
      record.tombstoneExpiresAt = Math.max(this.#now() + 1, expiresAt);
      this.#catalog.transitions = this.#catalog.transitions.filter((transition) => transition.sourceDigest !== recoveryId);
      await this.#writeCatalog();
    });
  }

  async revoke(recoveryId: string): Promise<void> {
    this.#assertInitialized();
    if (!DIGEST_PATTERN.test(recoveryId)) return;
    await this.#withLock(async () => {
      const before = this.#catalog.records.length;
      this.#removeRecord(recoveryId);
      if (this.#catalog.records.length !== before) await this.#writeCatalog();
    });
  }

  async revokeScope(input: { readonly sessionId: string; readonly targetId: string }): Promise<number> {
    this.#assertInitialized();
    if (input.sessionId.trim() === "" || input.sessionId.length > 512
        || input.targetId.trim() === "" || input.targetId.length > 512) {
      throw new Error("Native auth recovery revocation scope is invalid.");
    }
    return await this.#withLock(async () => {
      this.#purgeExpired();
      const removedDigests = new Set(this.#catalog.records
        .filter((record) => record.sessionId === input.sessionId && record.targetId === input.targetId)
        .map((record) => record.digest));
      const reservationCount = this.#catalog.reservations.filter((reservation) =>
        reservation.sessionId === input.sessionId && reservation.targetId === input.targetId).length;
      if (removedDigests.size === 0 && reservationCount === 0) return 0;
      this.#catalog.records = this.#catalog.records.filter((record) => !removedDigests.has(record.digest));
      this.#catalog.transitions = this.#catalog.transitions.filter((transition) => !removedDigests.has(transition.sourceDigest));
      this.#catalog.reservations = this.#catalog.reservations.filter((reservation) =>
        reservation.sessionId !== input.sessionId || reservation.targetId !== input.targetId);
      await this.#writeCatalog();
      return removedDigests.size + reservationCount;
    });
  }

  #applyTransition(transition: RecoveryTransition, descriptor: NativeAuthRecoveryDescriptor): void {
    for (const record of this.#catalog.records) {
      if (record.state !== "active" || record.providerId !== transition.providerId
          || record.accountDigest !== transition.accountDigest
          || record.authGeneration !== transition.authGeneration
          || record.sourceCatalogGeneration !== transition.sourceCatalogGeneration) continue;
      record.refreshSuperseded = true;
      record.authGeneration = descriptor.authGeneration;
      record.sourceCatalogGeneration = descriptor.catalogGeneration;
    }
    this.#removeTransitionGeneration(transition);
  }

  #matchingTransition(record: RecoveryRecord): RecoveryTransition | undefined {
    return this.#catalog.transitions.find((transition) => {
      if (transition.providerId !== record.providerId || transition.accountDigest !== record.accountDigest
          || transition.authGeneration !== record.authGeneration
          || transition.sourceCatalogGeneration !== record.sourceCatalogGeneration) return false;
      const source = this.#catalog.records.find((candidate) => candidate.digest === transition.sourceDigest);
      return (source?.state === "active" || source?.state === "transition_source")
        && source.providerId === transition.providerId
        && source.accountDigest === transition.accountDigest && source.authGeneration === transition.authGeneration
        && source.sourceCatalogGeneration === transition.sourceCatalogGeneration;
    });
  }

  #removeTransitionGeneration(transition: RecoveryTransition): void {
    this.#catalog.transitions = this.#catalog.transitions.filter((candidate) => candidate.providerId !== transition.providerId
      || candidate.accountDigest !== transition.accountDigest
      || candidate.authGeneration !== transition.authGeneration
      || candidate.sourceCatalogGeneration !== transition.sourceCatalogGeneration);
    this.#catalog.records = this.#catalog.records.filter((record) => record.digest !== transition.sourceDigest
      || record.state !== "transition_source");
  }

  #findByDigest(digest: Buffer): RecoveryRecord | undefined {
    const candidate = this.#catalog.records.find((record) => record.digest === digest.toString("hex"));
    if (candidate === undefined) return undefined;
    const candidateDigest = Buffer.from(candidate.digest, "hex");
    return candidateDigest.byteLength === digest.byteLength && timingSafeEqual(candidateDigest, digest) ? candidate : undefined;
  }

  #removeRecord(digest: string): void {
    this.#catalog.records = this.#catalog.records.filter((record) => record.digest !== digest);
    this.#catalog.transitions = this.#catalog.transitions.filter((transition) => transition.sourceDigest !== digest);
  }

  #purgeExpired(): void {
    const now = this.#now();
    const retained = this.#catalog.records.filter((record) => effectiveExpiry(record) > now);
    this.#catalog.reservations = this.#catalog.reservations.filter((reservation) => reservation.expiresAt > now);
    if (retained.length === this.#catalog.records.length) return;
    const digests = new Set(retained.map((record) => record.digest));
    this.#catalog.records = retained;
    this.#catalog.transitions = this.#catalog.transitions.filter((transition) => digests.has(transition.sourceDigest));
  }

  async #validateIssueRunner(input: NativeAuthRecoveryIssueInput): Promise<
    | (NativeAuthRecoveryLocalRunnerEvidence & {
      readonly processIdentity: string;
      readonly runnerScriptSha256: string;
    })
    | NativeAuthRecoveryRemoteRunnerEvidence
    | (NativeAuthRecoverySignedRunnerEvidence & {
      readonly publicKey: string;
      readonly processIdentity: string;
      readonly runnerScriptSha256: string;
      readonly bindingDigest: string;
      readonly runRootDigest: string;
      readonly configDigest: string;
      readonly ownerDigest: string;
      readonly claimDigest: string;
    })
  > {
    if (input.runnerEvidence.kind === "remote") {
      const evidence = input.runnerEvidence;
      if (!validRemoteRunnerEvidence(evidence)
          || evidence.runnerScriptSha256 !== this.#trustedRunnerScriptSha256
          || evidence.bindingDigest !== recoveryBindingDigest(input)) {
        throw new Error("Native auth recovery remote runner identity is invalid.");
      }
      return evidence;
    }
    if (input.runnerEvidence.kind === "signed") {
      const evidence = input.runnerEvidence;
      const reservation = this.#catalog.reservations.find((candidate) => candidate.id === evidence.reservationId);
      if (reservation === undefined || reservation.expiresAt <= this.#now()
          || reservation.publicKeyDigest !== evidence.publicKeyDigest
          || !reservationScopeMatches(reservation, input)) {
        throw new Error("Native auth runner reservation is unavailable.");
      }
      let processIdentity = evidence.publicKeyDigest;
      let bindingDigest = recoveryBindingDigest(input);
      let runRootDigest = evidence.publicKeyDigest;
      let configDigest = evidence.publicKeyDigest;
      let ownerDigest = evidence.publicKeyDigest;
      let claimDigest = evidence.publicKeyDigest;
      if (evidence.location === "remote") {
        const depth = evidence.depthEvidence;
        if (depth !== undefined) {
          if (!validRemoteRunnerEvidence(depth) || depth.runnerPid !== evidence.runnerPid
              || depth.runnerScriptSha256 !== this.#trustedRunnerScriptSha256
              || depth.bindingDigest !== recoveryBindingDigest(input)) {
            throw new Error("Native auth recovery remote runner depth evidence is invalid.");
          }
          processIdentity = depth.processIdentity;
          bindingDigest = depth.bindingDigest;
          runRootDigest = depth.runRootDigest;
          configDigest = depth.configDigest;
          ownerDigest = depth.ownerDigest;
          claimDigest = depth.claimDigest;
        }
      } else {
        const inspection = await this.#inspectRunnerProcess(evidence.runnerPid);
        const validated = await validateManagedSubagentRecoveryRun(this.#runRoot, {
          productSessionId: input.sessionId,
          runnerProductGeneration: input.runnerProductGeneration,
          providerId: input.providerId,
          runId: input.runId,
          runnerPid: evidence.runnerPid,
          runnerInstanceId: input.runnerFence,
          trustedRunnerScriptSha256: this.#trustedRunnerScriptSha256,
          trustedNodeExecutable: this.#trustedNodeExecutable,
          inspectRunnerProcess: async () => inspection,
          runnerPublicKeyDigest: evidence.publicKeyDigest,
          runnerReservationId: evidence.reservationId,
          ...(inspection === undefined ? { skipProcessInspection: true } : {})
        });
        processIdentity = validated.processIdentity;
      }
      return {
        ...evidence,
        publicKey: reservation.publicKey,
        processIdentity,
        runnerScriptSha256: this.#trustedRunnerScriptSha256,
        bindingDigest,
        runRootDigest,
        configDigest,
        ownerDigest,
        claimDigest
      };
    }
    const validated = await validateManagedSubagentRecoveryRun(this.#runRoot, {
      productSessionId: input.sessionId,
      runnerProductGeneration: input.runnerProductGeneration,
      providerId: input.providerId,
      runId: input.runId,
      runnerPid: input.runnerEvidence.runnerPid,
      runnerInstanceId: input.runnerFence,
      trustedRunnerScriptSha256: this.#trustedRunnerScriptSha256,
      trustedNodeExecutable: this.#trustedNodeExecutable,
      inspectRunnerProcess: this.#inspectRunnerProcess
    });
    if (validated.processIdentity === undefined || !DIGEST_PATTERN.test(validated.processIdentity)) {
      throw new Error("Native auth recovery process identity is unavailable.");
    }
    return {
      kind: "local",
      runnerPid: validated.runnerPid,
      processIdentity: validated.processIdentity,
      runnerScriptSha256: validated.runnerScriptSha256
    };
  }

  #rotateRunnerNonces(
    record: RecoveryRecord,
    evidence: NativeAuthRecoveryRemoteRunnerEvidence | NativeAuthRecoverySignedRunnerEvidence | undefined
  ): boolean {
    if (record.runnerKind === "signed_local" || record.runnerKind === "signed_remote") {
      if (evidence?.kind !== "signed" || record.signedNonceDigest === evidence.nonceDigest) {
        throw new Error("Native auth recovery signed runner proof was replayed.");
      }
      record.signedNonceDigest = evidence.nonceDigest;
      if (record.runnerKind === "signed_remote" && evidence.depthEvidence !== undefined) {
        if (record.remoteNonceDigest === evidence.depthEvidence.nonceDigest) {
          throw new Error("Native auth recovery remote attestation was replayed.");
        }
        record.remoteNonceDigest = evidence.depthEvidence.nonceDigest;
      }
      return true;
    }
    if (record.runnerKind !== "remote") {
      if (evidence !== undefined) throw new Error("Native auth recovery runner kind changed.");
      return false;
    }
    if (evidence?.kind !== "remote" || record.remoteNonceDigest === evidence.nonceDigest) {
      throw new Error("Native auth recovery remote attestation was replayed.");
    }
    record.remoteNonceDigest = evidence.nonceDigest;
    return true;
  }

  async #runnerMatches(
    record: RecoveryRecord,
    evidence?: NativeAuthRecoveryRemoteRunnerEvidence | NativeAuthRecoverySignedRunnerEvidence,
    allowTerminalTransitionSource = false
  ): Promise<boolean> {
    if (record.runnerKind === "signed_local" || record.runnerKind === "signed_remote") {
      if (evidence?.kind !== "signed" || !signedEvidenceMatches(record, evidence)) return false;
      if (record.runnerKind === "signed_remote") {
        return evidence.location === "remote" && (evidence.depthEvidence === undefined
          || remoteEvidenceMatches(record, evidence.depthEvidence));
      }
      return evidence.location === "local" && await this.#signedLocalLineageMatches(record, allowTerminalTransitionSource);
    }
    if (record.runnerKind === "remote") return evidence?.kind === "remote" && remoteEvidenceMatches(record, evidence);
    if (evidence !== undefined) return false;
    try {
      const validated = await validateManagedSubagentRecoveryRun(this.#runRoot, {
        productSessionId: record.sessionId,
        runnerProductGeneration: record.runnerProductGeneration,
        providerId: record.providerId,
        runId: record.runId,
        runnerPid: record.runnerPid,
        runnerInstanceId: record.runnerFence,
        trustedRunnerScriptSha256: this.#trustedRunnerScriptSha256,
        trustedNodeExecutable: this.#trustedNodeExecutable,
        inspectRunnerProcess: this.#inspectRunnerProcess,
        ...(allowTerminalTransitionSource ? { allowTerminalTransitionSource: true } : {})
      });
      return validated.processIdentity === record.processIdentity
        && validated.runnerScriptSha256 === record.runnerScriptSha256;
    } catch {
      return false;
    }
  }

  async #transitionSourceLineageMatches(record: RecoveryRecord): Promise<boolean> {
    if (record.runnerKind === "remote" || record.runnerKind === "signed_remote") return true;
    if (record.runnerKind === "signed_local") return this.#signedLocalLineageMatches(record, true);
    return this.#runnerMatches(record, undefined, true);
  }

  async #signedLocalLineageMatches(record: RecoveryRecord, allowTerminalTransitionSource: boolean): Promise<boolean> {
    if (record.signedPublicKeyDigest === undefined || record.signedReservationId === undefined) return false;
    try {
      const inspection = await this.#inspectRunnerProcess(record.runnerPid);
      const validated = await validateManagedSubagentRecoveryRun(this.#runRoot, {
        productSessionId: record.sessionId,
        runnerProductGeneration: record.runnerProductGeneration,
        providerId: record.providerId,
        runId: record.runId,
        runnerPid: record.runnerPid,
        runnerInstanceId: record.runnerFence,
        trustedRunnerScriptSha256: this.#trustedRunnerScriptSha256,
        trustedNodeExecutable: this.#trustedNodeExecutable,
        inspectRunnerProcess: async () => inspection,
        runnerPublicKeyDigest: record.signedPublicKeyDigest,
        runnerReservationId: record.signedReservationId,
        ...(inspection === undefined ? { skipProcessInspection: true } : {}),
        ...(allowTerminalTransitionSource ? { allowTerminalTransitionSource: true } : {})
      });
      return validated.runnerScriptSha256 === record.runnerScriptSha256
        && (inspection === undefined || validated.processIdentity === record.processIdentity);
    } catch {
      return false;
    }
  }

  async #readCatalog(): Promise<RecoveryCatalog> {
    const info = await lstat(this.#catalogPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (info === undefined) return emptyCatalog();
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > MAXIMUM_CATALOG_BYTES
        || !samePath(await realpath(this.#catalogPath), this.#catalogPath)) {
      throw new Error("Native auth recovery catalog is unsafe.");
    }
    const flags = FS_CONSTANTS.O_RDONLY | (process.platform === "win32" ? 0 : FS_CONSTANTS.O_NOFOLLOW);
    const handle = await open(this.#catalogPath, flags).catch(() => undefined);
    if (handle === undefined) throw new Error("Native auth recovery catalog is unsafe.");
    let bytes: Buffer;
    try {
      const opened = await handle.stat();
      const current = await lstat(this.#catalogPath);
      if (!sameOpenedFile(info, opened) || !sameOpenedFile(current, opened)
          || current.isSymbolicLink() || !samePath(await realpath(this.#catalogPath), this.#catalogPath)) {
        throw new Error("Native auth recovery catalog is unsafe.");
      }
      bytes = await handle.readFile();
      const after = await handle.stat();
      if (!sameOpenedFile(opened, after) || bytes.byteLength !== opened.size
          || bytes.byteLength > MAXIMUM_CATALOG_BYTES) {
        throw new Error("Native auth recovery catalog is unsafe.");
      }
    } finally {
      await handle.close();
    }
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (!isRecoveryCatalog(value)) throw new Error("Native auth recovery catalog is invalid.");
    return value;
  }

  async #writeCatalog(): Promise<void> {
    await assertCanonicalDirectory(this.#stateRoot);
    const bytes = Buffer.from(`${JSON.stringify(this.#catalog)}\n`, "utf8");
    if (bytes.byteLength > MAXIMUM_CATALOG_BYTES) throw new Error("Native auth recovery catalog capacity was exceeded.");
    const temporary = join(this.#stateRoot, `.leases-${process.pid}-${randomUUID()}.tmp`);
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    try {
      await chmod(temporary, 0o600);
      const existing = await lstat(this.#catalogPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (existing !== undefined && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1)) {
        throw new Error("Native auth recovery catalog target is unsafe.");
      }
      await rename(temporary, this.#catalogPath);
      await chmod(this.#catalogPath, 0o600);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  #withLock<T>(callback: () => Promise<T>): Promise<T> {
    const operation = this.#tail.catch(() => undefined).then(callback);
    this.#tail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  #assertInitialized(): void {
    if (!this.#initialized) throw new Error("Native auth recovery is not initialized.");
  }
}

function emptyCatalog(): RecoveryCatalog {
  return { format: RECOVERY_FORMAT, records: [], transitions: [], reservations: [] };
}

function snapshot(record: RecoveryRecord): NativeAuthRecoverySnapshot {
  return {
    recoveryId: record.digest,
    sessionId: record.sessionId,
    targetId: record.targetId,
    serviceGeneration: record.serviceGeneration,
    runnerProductGeneration: record.runnerProductGeneration,
    providerId: record.providerId,
    catalogGeneration: record.catalogGeneration,
    runId: record.runId,
    runnerFence: record.runnerFence,
    authGeneration: record.authGeneration,
    sourceCatalogGeneration: record.sourceCatalogGeneration,
    expiresAt: record.expiresAt,
    refreshSuperseded: record.refreshSuperseded,
    released: record.state === "released"
  };
}

function digestProof(proof: string): Buffer {
  return createHash("sha256").update(proof, "utf8").digest();
}

function digestIdentity(accountId: string): string {
  return createHash("sha256").update(accountId, "utf8").digest("hex");
}

function identityMatches(accountDigest: string, accountId: string): boolean {
  const expected = Buffer.from(accountDigest, "hex");
  const observed = Buffer.from(digestIdentity(accountId), "hex");
  return expected.byteLength === observed.byteLength && timingSafeEqual(expected, observed);
}

function digestMatches(expectedHex: string, observedHex: string): boolean {
  if (!DIGEST_PATTERN.test(expectedHex) || !DIGEST_PATTERN.test(observedHex)) return false;
  const expected = Buffer.from(expectedHex, "hex");
  const observed = Buffer.from(observedHex, "hex");
  return expected.byteLength === observed.byteLength && timingSafeEqual(expected, observed);
}

function descriptorMatches(record: RecoveryRecord, descriptor: NativeAuthRecoveryDescriptor): boolean {
  return descriptor.authenticated === true && identityMatches(record.accountDigest, descriptor.accountId)
    && descriptor.authGeneration === record.authGeneration
    && descriptor.catalogGeneration === record.sourceCatalogGeneration;
}

function assertExactScope(record: RecoveryRecord, input: NativeAuthRecoveryScope): void {
  if (record.sessionId !== input.sessionId || record.targetId !== input.targetId
      || record.serviceGeneration !== input.serviceGeneration
      || record.runnerProductGeneration !== input.runnerProductGeneration || record.providerId !== input.providerId
      || record.catalogGeneration !== input.catalogGeneration || record.runId !== input.runId
      || record.runnerFence !== input.runnerFence) {
    throw new Error("Native auth recovery lineage is stale or mismatched.");
  }
}

function assertIssueInput(input: NativeAuthRecoveryIssueInput, now: number): void {
  if (!validScope(input) || !DIGEST_PATTERN.test(input.bearerDigest)
      || input.accountId.length < 1 || input.accountId.length > 512 || !validGeneration(input.authGeneration)
      || !Number.isSafeInteger(input.sourceCatalogGeneration) || input.sourceCatalogGeneration < 0
      || input.sourceCatalogGeneration !== input.catalogGeneration
      || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= now || input.expiresAt - now > 60_000
      || !Number.isSafeInteger(input.runnerEvidence.runnerPid) || input.runnerEvidence.runnerPid < 1) {
    throw new Error("Native auth recovery issue fence is invalid.");
  }
}

function validScope(input: NativeAuthRecoveryScope): boolean {
  return input.sessionId.length >= 1 && input.sessionId.length <= 512
    && input.targetId.length >= 1 && input.targetId.length <= 512
    && Number.isSafeInteger(input.serviceGeneration) && input.serviceGeneration >= 0
    && Number.isSafeInteger(input.runnerProductGeneration) && input.runnerProductGeneration >= 0
    && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(input.providerId)
    && Number.isSafeInteger(input.catalogGeneration) && input.catalogGeneration >= 0
    && UUID_PATTERN.test(input.runId) && UUID_PATTERN.test(input.runnerFence);
}

function isRecoveryScopeRecord(record: Record<string, unknown>): boolean {
  return typeof record["sessionId"] === "string" && record["sessionId"].length >= 1 && record["sessionId"].length <= 512
    && typeof record["targetId"] === "string" && record["targetId"].length >= 1 && record["targetId"].length <= 512
    && Number.isSafeInteger(record["serviceGeneration"]) && Number(record["serviceGeneration"]) >= 0
    && Number.isSafeInteger(record["runnerProductGeneration"]) && Number(record["runnerProductGeneration"]) >= 0
    && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(String(record["providerId"] ?? ""))
    && Number.isSafeInteger(record["catalogGeneration"]) && Number(record["catalogGeneration"]) >= 0
    && UUID_PATTERN.test(String(record["runId"] ?? "")) && UUID_PATTERN.test(String(record["runnerFence"] ?? ""));
}

function normalizedEd25519PublicKey(value: string): string {
  if (typeof value !== "string" || value.length < 40 || value.length > 128 || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new Error("Native auth runner public key is invalid.");
  }
  try {
    const key = createPublicKey({ key: Buffer.from(value, "base64url"), format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ed25519") throw new Error("wrong key type");
    const normalized = (key.export({ format: "der", type: "spki" }) as Buffer).toString("base64url");
    if (normalized !== value) throw new Error("non-canonical key");
    return normalized;
  } catch {
    throw new Error("Native auth runner public key is invalid.");
  }
}

function isNormalizedEd25519PublicKey(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try { return normalizedEd25519PublicKey(value) === value; } catch { return false; }
}

function digestPublicKey(publicKey: string): string {
  return createHash("sha256").update(publicKey, "utf8").digest("hex");
}

function reservationScopeMatches(reservation: RunnerReservation, input: NativeAuthRecoveryScope): boolean {
  return reservation.sessionId === input.sessionId && reservation.targetId === input.targetId
    && reservation.serviceGeneration === input.serviceGeneration
    && reservation.runnerProductGeneration === input.runnerProductGeneration
    && reservation.providerId === input.providerId && reservation.catalogGeneration === input.catalogGeneration
    && reservation.runId === input.runId && reservation.runnerFence === input.runnerFence;
}

function signedRecordScopeMatches(record: RecoveryRecord, input: NativeAuthRecoveryScope): boolean {
  try { assertExactScope(record, input); return true; } catch { return false; }
}

function signedRunnerMessage(
  input: NativeAuthRecoveryScope & {
    readonly action: "acquire" | "validate" | "release";
    readonly recoveryProof?: string;
    readonly credentialDigest: string;
  },
  proof: NativeAuthRunnerProof
): string {
  return JSON.stringify([
    "joko.pi-native-auth.runner-proof.v1",
    input.action,
    proof.reservationId,
    input.sessionId,
    input.targetId,
    input.serviceGeneration,
    input.runnerProductGeneration,
    input.providerId,
    input.catalogGeneration,
    input.runId,
    input.runnerFence,
    proof.runnerPid,
    input.recoveryProof ?? "",
    input.credentialDigest,
    proof.nonce
  ]);
}

function signedEvidenceMatches(record: RecoveryRecord, evidence: NativeAuthRecoverySignedRunnerEvidence): boolean {
  return record.signedReservationId === evidence.reservationId
    && record.signedPublicKeyDigest === evidence.publicKeyDigest
    && record.runnerPid === evidence.runnerPid
    && (record.runnerKind === "signed_local" ? evidence.location === "local" : evidence.location === "remote")
    && DIGEST_PATTERN.test(evidence.nonceDigest);
}

function validGeneration(value: string): boolean {
  return value.length >= 1 && value.length <= 256 && /^[A-Za-z0-9._:-]+$/u.test(value);
}

function isRecoveryCatalog(value: unknown): value is RecoveryCatalog {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record["format"] !== RECOVERY_FORMAT || !Array.isArray(record["records"])
      || !Array.isArray(record["transitions"]) || !Array.isArray(record["reservations"])
      || record["records"].length > MAXIMUM_RECORDS || record["transitions"].length > MAXIMUM_RECORDS
      || record["reservations"].length > MAXIMUM_RECORDS) return false;
  const records = record["records"];
  const transitions = record["transitions"];
  const digests = new Set<string>();
  if (!records.every((entry) => {
    if (!isRecoveryRecord(entry) || digests.has(entry.digest)) return false;
    digests.add(entry.digest);
    return true;
  })) return false;
  const transitionIds = new Set<string>();
  if (!transitions.every((entry) => {
    if (!isRecoveryTransition(entry) || transitionIds.has(entry.id) || !digests.has(entry.sourceDigest)) return false;
    transitionIds.add(entry.id);
    return true;
  })) return false;
  const reservationIds = new Set<string>();
  return (record["reservations"] as unknown[]).every((entry) => {
    if (!isRunnerReservation(entry) || reservationIds.has(entry.id)) return false;
    reservationIds.add(entry.id);
    return true;
  });
}

function isRecoveryRecord(value: unknown): value is RecoveryRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return DIGEST_PATTERN.test(String(record["digest"] ?? ""))
    && DIGEST_PATTERN.test(String(record["bearerDigest"] ?? ""))
    && typeof record["sessionId"] === "string" && record["sessionId"].length >= 1 && record["sessionId"].length <= 512
    && typeof record["targetId"] === "string" && record["targetId"].length >= 1 && record["targetId"].length <= 512
    && Number.isSafeInteger(record["serviceGeneration"]) && Number(record["serviceGeneration"]) >= 0
    && Number.isSafeInteger(record["runnerProductGeneration"]) && Number(record["runnerProductGeneration"]) >= 0
    && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(String(record["providerId"] ?? ""))
    && Number.isSafeInteger(record["catalogGeneration"]) && Number(record["catalogGeneration"]) >= 0
    && UUID_PATTERN.test(String(record["runId"] ?? "")) && UUID_PATTERN.test(String(record["runnerFence"] ?? ""))
    && DIGEST_PATTERN.test(String(record["accountDigest"] ?? "")) && validGeneration(String(record["authGeneration"] ?? ""))
    && Number.isSafeInteger(record["sourceCatalogGeneration"]) && Number(record["sourceCatalogGeneration"]) >= 0
    && Number.isSafeInteger(record["runnerPid"]) && Number(record["runnerPid"]) > 0
    && DIGEST_PATTERN.test(String(record["processIdentity"] ?? ""))
    && DIGEST_PATTERN.test(String(record["runnerScriptSha256"] ?? ""))
    && (["local", "remote", "signed_local", "signed_remote"] as const).includes(record["runnerKind"] as never)
    && (record["runnerKind"] === "local"
      ? record["remoteBindingDigest"] === undefined && record["remoteRunRootDigest"] === undefined
        && record["remoteConfigDigest"] === undefined && record["remoteOwnerDigest"] === undefined
        && record["remoteClaimDigest"] === undefined && record["remoteNonceDigest"] === undefined
        && record["signedReservationId"] === undefined && record["signedPublicKey"] === undefined
        && record["signedPublicKeyDigest"] === undefined && record["signedNonceDigest"] === undefined
      : record["runnerKind"] === "remote" ? DIGEST_PATTERN.test(String(record["remoteBindingDigest"] ?? ""))
        && DIGEST_PATTERN.test(String(record["remoteRunRootDigest"] ?? ""))
        && DIGEST_PATTERN.test(String(record["remoteConfigDigest"] ?? ""))
        && DIGEST_PATTERN.test(String(record["remoteOwnerDigest"] ?? ""))
        && DIGEST_PATTERN.test(String(record["remoteClaimDigest"] ?? ""))
        && DIGEST_PATTERN.test(String(record["remoteNonceDigest"] ?? ""))
        && record["signedReservationId"] === undefined && record["signedPublicKey"] === undefined
        && record["signedPublicKeyDigest"] === undefined && record["signedNonceDigest"] === undefined
      : UUID_PATTERN.test(String(record["signedReservationId"] ?? ""))
        && isNormalizedEd25519PublicKey(record["signedPublicKey"])
        && DIGEST_PATTERN.test(String(record["signedPublicKeyDigest"] ?? ""))
        && digestPublicKey(String(record["signedPublicKey"])) === record["signedPublicKeyDigest"]
        && DIGEST_PATTERN.test(String(record["signedNonceDigest"] ?? ""))
        && (record["runnerKind"] === "signed_local"
          ? record["remoteBindingDigest"] === undefined && record["remoteRunRootDigest"] === undefined
            && record["remoteConfigDigest"] === undefined && record["remoteOwnerDigest"] === undefined
            && record["remoteClaimDigest"] === undefined && record["remoteNonceDigest"] === undefined
          : record["remoteBindingDigest"] === undefined || DIGEST_PATTERN.test(String(record["remoteBindingDigest"])))
        && (record["runnerKind"] !== "signed_remote" || record["remoteRunRootDigest"] === undefined
          || DIGEST_PATTERN.test(String(record["remoteRunRootDigest"])))
        && (record["runnerKind"] !== "signed_remote" || record["remoteConfigDigest"] === undefined
          || DIGEST_PATTERN.test(String(record["remoteConfigDigest"])))
        && (record["runnerKind"] !== "signed_remote" || record["remoteOwnerDigest"] === undefined
          || DIGEST_PATTERN.test(String(record["remoteOwnerDigest"])))
        && (record["runnerKind"] !== "signed_remote" || record["remoteClaimDigest"] === undefined
          || DIGEST_PATTERN.test(String(record["remoteClaimDigest"])))
        && (record["runnerKind"] !== "signed_remote" || record["remoteNonceDigest"] === undefined
          || DIGEST_PATTERN.test(String(record["remoteNonceDigest"]))))
    && typeof record["refreshSuperseded"] === "boolean"
    && (record["state"] === "active" || record["state"] === "released" || record["state"] === "transition_source")
    && Number.isSafeInteger(record["expiresAt"]) && Number(record["expiresAt"]) > 0
    && (record["tombstoneExpiresAt"] === undefined
      || Number.isSafeInteger(record["tombstoneExpiresAt"]) && Number(record["tombstoneExpiresAt"]) > 0)
    && (record["state"] !== "released" || Number.isSafeInteger(record["tombstoneExpiresAt"]));
}

function isRunnerReservation(value: unknown): value is RunnerReservation {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return UUID_PATTERN.test(String(record["id"] ?? "")) && isRecoveryScopeRecord(record)
    && isNormalizedEd25519PublicKey(record["publicKey"])
    && DIGEST_PATTERN.test(String(record["publicKeyDigest"] ?? ""))
    && digestPublicKey(String(record["publicKey"])) === record["publicKeyDigest"]
    && DIGEST_PATTERN.test(String(record["runnerScriptSha256"] ?? ""))
    && Number.isSafeInteger(record["expiresAt"]) && Number(record["expiresAt"]) > 0;
}

function isRecoveryTransition(value: unknown): value is RecoveryTransition {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return UUID_PATTERN.test(String(record["id"] ?? "")) && DIGEST_PATTERN.test(String(record["sourceDigest"] ?? ""))
    && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(String(record["providerId"] ?? ""))
    && DIGEST_PATTERN.test(String(record["accountDigest"] ?? "")) && validGeneration(String(record["authGeneration"] ?? ""))
    && Number.isSafeInteger(record["sourceCatalogGeneration"]) && Number(record["sourceCatalogGeneration"]) >= 0
    && Number.isSafeInteger(record["createdAt"]) && Number(record["createdAt"]) >= 0;
}

function validRemoteRunnerEvidence(value: NativeAuthRecoveryRemoteRunnerEvidence): boolean {
  return Number.isSafeInteger(value.runnerPid) && value.runnerPid > 0
    && DIGEST_PATTERN.test(value.processIdentity)
    && DIGEST_PATTERN.test(value.bindingDigest)
    && DIGEST_PATTERN.test(value.runRootDigest)
    && DIGEST_PATTERN.test(value.runnerScriptSha256)
    && DIGEST_PATTERN.test(value.configDigest)
    && DIGEST_PATTERN.test(value.ownerDigest)
    && DIGEST_PATTERN.test(value.claimDigest)
    && DIGEST_PATTERN.test(value.nonceDigest);
}

function remoteEvidenceMatches(
  record: RecoveryRecord,
  evidence: NativeAuthRecoveryRemoteRunnerEvidence
): boolean {
  if (!validRemoteRunnerEvidence(evidence)
      || record.runnerKind !== "remote" && record.runnerKind !== "signed_remote") return false;
  return evidence.runnerPid === record.runnerPid
    && evidence.processIdentity === record.processIdentity
    && evidence.bindingDigest === record.remoteBindingDigest
    && evidence.runRootDigest === record.remoteRunRootDigest
    && evidence.runnerScriptSha256 === record.runnerScriptSha256
    && evidence.configDigest === record.remoteConfigDigest
    && evidence.ownerDigest === record.remoteOwnerDigest
    && evidence.claimDigest === record.remoteClaimDigest;
}

export function verifyRemoteNativeAuthRunnerAttestation(
  input: VerifyRemoteNativeAuthRunnerAttestationInput
): NativeAuthRecoveryRemoteRunnerEvidence {
  const value = input.attestation;
  if (value.format !== 1 || value.action !== input.action
      // Remote host clocks are not an authority fence. Freshness comes from
      // the current service bearer, exact action/scope, and recovery proof.
      || !Number.isSafeInteger(value.issuedAt) || value.issuedAt < 0
      || !PROOF_PATTERN.test(value.nonce) || !PROOF_PATTERN.test(value.mac)
      || !DIGEST_PATTERN.test(input.trustedRunnerScriptSha256)) {
    throw new Error("Remote native auth runner attestation is invalid.");
  }
  const evidence: NativeAuthRecoveryRemoteRunnerEvidence = {
    kind: "remote",
    runnerPid: value.runnerPid,
    processIdentity: value.processIdentity,
    bindingDigest: value.bindingDigest,
    runRootDigest: value.runRootDigest,
    runnerScriptSha256: value.runnerScriptDigest,
    configDigest: value.configDigest,
    ownerDigest: value.ownerDigest,
    claimDigest: value.claimDigest,
    nonceDigest: createHash("sha256").update(value.nonce, "utf8").digest("hex")
  };
  const bindingDigest = recoveryBindingDigest(input);
  if (!validRemoteRunnerEvidence(evidence) || !DIGEST_PATTERN.test(value.statusDigest)
      || value.bindingDigest !== bindingDigest
      || value.runnerScriptDigest !== input.trustedRunnerScriptSha256) {
    throw new Error("Remote native auth runner attestation is invalid.");
  }
  const message = JSON.stringify([
    "joko.pi-native-auth.remote-runner.attestation.v1",
    input.action,
    input.sessionId,
    input.targetId,
    input.providerId,
    input.catalogGeneration,
    input.serviceGeneration,
    input.runnerProductGeneration,
    input.runId,
    input.runnerFence,
    value.bindingDigest,
    value.runnerPid,
    value.processIdentity,
    value.runRootDigest,
    value.runnerScriptDigest,
    value.configDigest,
    value.statusDigest,
    value.ownerDigest,
    value.claimDigest,
    value.issuedAt,
    value.nonce
  ]);
  const expected = createHmac("sha256", input.bearer).update(message, "utf8").digest();
  const observed = Buffer.from(value.mac, "base64url");
  if (observed.byteLength !== expected.byteLength || !timingSafeEqual(observed, expected)) {
    throw new Error("Remote native auth runner attestation is invalid.");
  }
  return evidence;
}

export function recoveryBindingDigest(scope: NativeAuthRecoveryScope): string {
  return createHash("sha256").update(JSON.stringify([
    "joko.pi-native-auth.remote-runner.binding.v1",
    scope.sessionId,
    scope.targetId,
    scope.providerId,
    scope.catalogGeneration,
    scope.runId,
    scope.runnerFence,
    scope.runnerProductGeneration
  ]), "utf8").digest("hex");
}

export function nativeAuthCredentialDigest(credential: unknown): string {
  const serialized = credential === undefined ? "" : JSON.stringify(credential);
  return createHash("sha256").update(serialized, "utf8").digest("hex");
}

async function assertCanonicalDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await realpath(path), path)) {
    throw new Error("Native auth recovery directory is unsafe.");
  }
}

function isNormalizedAbsolute(path: string): boolean {
  return isAbsolute(path) && resolve(path) === path && dirname(path) !== path;
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function sameOpenedFile(left: import("node:fs").Stats, right: import("node:fs").Stats): boolean {
  return left.isFile() && right.isFile() && left.dev === right.dev && left.ino === right.ino
    && left.nlink === 1 && right.nlink === 1 && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function effectiveExpiry(record: RecoveryRecord): number {
  return record.state === "released" ? record.tombstoneExpiresAt ?? record.expiresAt : record.expiresAt;
}
