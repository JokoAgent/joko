// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalState } from "./local-state.js";
import type { ConnectionProfile } from "./model.js";
import { webcrypto } from 'node:crypto';
import { rememberEndpointTransport, trustedEndpointTransport } from '@joko/connection-transport/trust';

afterEach(() => { vi.unstubAllGlobals(); Reflect.deleteProperty(window, 'jokoDesktop'); });

it('retains an unknown private relay operation across page restarts without persisting lease secrets', async () => {
  const records = new Map<string, unknown>();
  const database = { transaction: () => {
    const transaction = { oncomplete: null as (() => void) | null, objectStore: () => ({
      get: (id: string) => {
        const request = { result: records.get(id), onsuccess: null as (() => void) | null };
        queueMicrotask(() => request.onsuccess?.()); return request;
      },
      put: (value: unknown, id: string) => records.set(id, value)
    }) };
    setTimeout(() => transaction.oncomplete?.(), 0); return transaction;
  } } as unknown as IDBDatabase;
  const profile: ConnectionProfile = { id: 'relay-authority', origin: 'https://relay-authority.example', serverId: 'node', deviceId: 'desktop', name: 'Relay' };
  const input = { requestId: '00000000-0000-4000-8000-000000000001', nodeEndpointId: 'a'.repeat(64), recipientEndpointId: 'b'.repeat(64) };
  const replacement = { ...input, requestId: '00000000-0000-4000-8000-000000000002' };
  const first = Reflect.construct(LocalState as unknown as Function, [database]) as LocalState;
  await expect(first.claimIrohRelayRequest(profile, input)).resolves.toEqual(input);
  const second = Reflect.construct(LocalState as unknown as Function, [database]) as LocalState;
  await expect(second.claimIrohRelayRequest(profile, replacement)).resolves.toEqual(input);
  await second.confirmIrohRelayRequest(profile, input, Date.now() - 1);
  await expect(second.claimIrohRelayRequest(profile, replacement)).resolves.toEqual(replacement);
  expect([...records.values()]).toEqual([replacement]);
});

it.each(['tailcat', 'http-connect'] as const)('stores %s locators privately and reads them independently before a business credential', async kind => {
  const profile: ConnectionProfile = { id: `sdk-profile-${kind}`, serverId: 'sdk-node', deviceId: 'desktop', name: 'SDK node', origin: `https://desktop-${kind}-storage.example`, endpointPublicKey: `ed25519:${'9'.repeat(64)}`, transportKind: kind };
  const locator = kind === 'tailcat' ? { kind: 'tailcat', address: 'tcPrivate-address-psk', endpointId: `nodekey:${'8'.repeat(64)}`, port: 4318 } as const
    : { kind: 'http-connect', proxyOrigin: 'https://private-proxy.example:8443', authority: `desktop-${kind}-storage.example:443` } as const;
  rememberEndpointTransport(profile.origin, profile.endpointPublicKey!, locator);
  const secrets = new Map<string, string>(), records = new Map<string, unknown>(), read = vi.fn(async (id: string) => secrets.get(id));
  vi.stubGlobal('crypto', webcrypto);
  Object.defineProperty(window, 'jokoDesktop', { configurable: true, value: { credentials: {
    set: async (id: string, value: string) => { secrets.set(id, value); }, get: read,
    delete: async (id: string) => { secrets.delete(id); }
  } } });
  const database = { transaction: () => {
    const transaction = { oncomplete: null as (() => void) | null, objectStore: () => ({
      put: (value: unknown, id: string) => records.set(id, value), delete: (id: string) => records.delete(id)
    }) };
    setTimeout(() => transaction.oncomplete?.(), 0); return transaction;
  } } as unknown as IDBDatabase;
  const page = Reflect.construct(LocalState as unknown as Function, [database]) as LocalState;
  await page.saveProfile(profile, 'business-auth-key');
  expect(JSON.stringify([...records])).not.toContain(locator.kind === 'tailcat' ? locator.address : locator.proxyOrigin);
  expect(JSON.stringify([...records])).not.toContain('business-auth-key');
  await page.loadEndpointTransport(profile);
  expect(read).toHaveBeenCalledOnce();
  expect(read.mock.calls[0]![0]).toMatch(/^transport_[a-f0-9]{64}$/u);
  expect(read).not.toHaveBeenCalledWith(profile.id);
  expect(trustedEndpointTransport(profile.origin, profile.endpointPublicKey!, kind)).toEqual(locator);
  await expect(page.loadEndpointTransport({ ...profile, origin: 'https://different-sdk-owner.example' })).rejects.toThrow(/owner/u);
  await page.deleteAuthKey(profile.id);
  await expect(page.loadEndpointTransport(profile)).rejects.toThrow(/unavailable/u);
});

describe("credentials in a restricted LAN HTTP Web page", () => {
  it("keeps the key in this page, removes an old durable secret and loses access after a new page is created", async () => {
    const secret = "restricted-lan-test-key";
    const profile: ConnectionProfile = { id: "lan-page", serverId: "lan-node", deviceId: "phone", name: "Private node", origin: "http://192.168.14.20:4318" };
    const profiles = new Map<IDBValidKey, unknown>();
    const secrets = new Map<IDBValidKey, unknown>([[profile.id, { ciphertext: "old encrypted value" }]]);
    const keys = new Map<IDBValidKey, unknown>();
    const stores = new Map<string, Map<IDBValidKey, unknown>>([["profiles", profiles], ["secrets", secrets], ["keys", keys]]);
    const encrypt = vi.fn(), decrypt = vi.fn(), generateKey = vi.fn();
    vi.stubGlobal("isSecureContext", false);
    // Even a present subtle implementation cannot make an HTTP page trusted.
    vi.stubGlobal("crypto", { subtle: { encrypt, decrypt, generateKey } });
    const database = { transaction: () => {
      const transaction = { error: null, oncomplete: null as (() => void) | null,
        objectStore: (name: string) => {
          const records = stores.get(name);
          if (!records) throw new Error(`Unexpected credential store: ${name}`);
          return { put: (value: unknown, key: IDBValidKey) => records.set(key, value), delete: (key: IDBValidKey) => records.delete(key) };
        }
      };
      setTimeout(() => transaction.oncomplete?.(), 0);
      return transaction;
    } } as unknown as IDBDatabase;
    const page = Reflect.construct(LocalState as unknown as Function, [database]) as LocalState;
    await page.saveProfile(profile, secret);
    expect(await page.readAuthKey(profile)).toBe(secret);
    expect(profiles.get(profile.id)).toEqual(profile);
    expect(secrets.size).toBe(0);
    expect(keys.size).toBe(0);
    expect(JSON.stringify([...profiles])).not.toContain(secret);
    const reopened = Reflect.construct(LocalState as unknown as Function, [database]) as LocalState;
    expect(await reopened.readAuthKey(profile)).toBeUndefined();
    expect(encrypt).not.toHaveBeenCalled();
    expect(decrypt).not.toHaveBeenCalled();
    expect(generateKey).not.toHaveBeenCalled();
    await page.deleteAuthKey(profile.id);
    expect(await page.readAuthKey(profile)).toBeUndefined();
  });
});
