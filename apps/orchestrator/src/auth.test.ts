import { describe, expect, it } from "vitest";
import { AuthService, AuthenticationError, type ConnectionRecord, type PairingRecord } from "./auth.js";

class MemoryAuthRepository {
  readonly pairings = new Map<string, PairingRecord>();
  readonly connections = new Map<string, ConnectionRecord>();

  async createPairing(record: PairingRecord): Promise<void> {
    this.pairings.set(record.digest, record);
  }

  async consumePairing(digest: string, now: number): Promise<boolean> {
    const value = this.pairings.get(digest);
    if (value === undefined || value.usedAt !== undefined || value.expiresAt <= now) return false;
    this.pairings.set(digest, { ...value, usedAt: now });
    return true;
  }

  async createConnection(record: ConnectionRecord): Promise<void> {
    this.connections.set(record.id, record);
  }

  async findConnectionByDigest(digest: string): Promise<ConnectionRecord | undefined> {
    return [...this.connections.values()].find((item) => item.keyDigest === digest);
  }

  async revokeConnection(id: string, now: number): Promise<boolean> {
    const item = this.connections.get(id);
    if (item === undefined) return false;
    this.connections.set(id, { ...item, revokedAt: now });
    return true;
  }
}

describe("AuthService", () => {
  it("consumes pairing codes once and revokes the exact connection", async () => {
    const repository = new MemoryAuthRepository();
    const auth = new AuthService(repository, { now: () => 1_000 });
    const pairing = await auth.issuePairingCode();
    const paired = await auth.pair(pairing.code, "desktop-a", "Desktop");
    await expect(auth.pair(pairing.code, "desktop-b", "Other")).rejects.toBeInstanceOf(AuthenticationError);
    await expect(auth.authenticate(`Bearer ${paired.authKey}`)).resolves.toMatchObject({ id: "desktop-a" });
    await auth.revoke("desktop-a");
    await expect(auth.authenticate(`Bearer ${paired.authKey}`)).rejects.toMatchObject({ code: "AUTH_REVOKED" });
  });
});
