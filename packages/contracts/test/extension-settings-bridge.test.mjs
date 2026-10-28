import assert from "node:assert/strict";
import { test } from "node:test";
import { Script, createContext } from "node:vm";
import { webcrypto } from "node:crypto";
import { EXTENSION_SETTINGS_SDK_SOURCE, parseExtensionSettingsBridgeRequest } from "../dist/index.js";

test("author settings only accepts declared commands and bounded private input", () => {
  const request = command => ({ type: "joko:extension-settings-request", version: 1, id: "settings-one", command });
  assert.ok(parseExtensionSettingsBridgeRequest(request({ kind: "secret.check", key: "token", value: "candidate" })));
  assert.ok(parseExtensionSettingsBridgeRequest(request({ kind: "directory.pick", title: "Select report files" })));
  for (const command of [
    { kind: "rpc", method: "deleteSession", arguments: {} },
    { kind: "secret.set", fieldId: "network-secret:token", value: "x", resourceId: "other" },
    { kind: "oauth.connect", key: "account", scopes: new Array(33).fill("scope") },
    { kind: "secret.check", key: "token", value: "x".repeat(65_537) },
    { kind: "routing.set", revision: "1e9", dataJson: "{}" },
    { kind: "connections.change", key: "site", action: "deleteAll", connectionId: "one" },
    { kind: "directory.pick", path: "/etc" }, { kind: "directory.pick", title: "x".repeat(161) }
  ]) assert.equal(parseExtensionSettingsBridgeRequest(request(command)), undefined);
  assert.equal(parseExtensionSettingsBridgeRequest({ ...request({ kind: "context.get" }), sourceSession: "foreign" }), undefined);
});

function page() {
  const listeners = new Map(), requests = [];
  const parent = { postMessage: value => requests.push(value) };
  const context = { parent, navigator: {}, location: { origin: "null" }, crypto: webcrypto, URL, Response,
    fetch: async () => { throw new Error("ambient network denied"); }, setTimeout, clearTimeout,
    addEventListener: (name, callback) => { const values = listeners.get(name) ?? new Set(); values.add(callback); listeners.set(name, values); },
    removeEventListener: (name, callback) => listeners.get(name)?.delete(callback) };
  context.window = context;
  new Script(EXTENSION_SETTINGS_SDK_SOURCE).runInContext(createContext(context));
  const dispatch = (name, event) => { for (const callback of listeners.get(name) ?? []) callback(event); };
  const respond = (id, result, source = parent) => dispatch("message", { source, data: { type: "joko:extension-settings-response", version: 1, id, ok: true, result } });
  return { context, requests, dispatch, respond };
}

test("directory selection only sends a native choice request and requires a read deposit", async () => {
  const current = page();
  await assert.rejects(current.context.fetch("/pick", { method: "POST", body: JSON.stringify({ mode: "directory", deposit: false }) }), /read deposit/u);
  await assert.rejects(current.context.fetch("/pick", { method: "POST", body: JSON.stringify({ mode: "directory", deposit: true, path: "/private" }) }), /read deposit/u);
  const pending = current.context.fetch("/pick", { method: "POST", body: JSON.stringify({ mode: "directory", deposit: true, title: "Reports" }) });
  assert.deepEqual(JSON.parse(JSON.stringify(current.requests[0].command)), { kind: "directory.pick", title: "Reports" });
  current.respond(current.requests[0].id, { dir_deposit: { token: "receipt", file_count: 1, total_bytes: 4, rel_paths: ["report.txt"] } });
  const response = await pending; assert.equal((await response.json()).dir_deposit.token, "receipt");
});

test("the real settings SDK binds responses and keeps entered secrets out of routing parameters", async () => {
  const current = page();
  const pending = current.context.joko.settings({ kind: "secret.set", fieldId: "network-secret:token", value: "private-$&-candidate" });
  assert.equal(current.requests.length, 1);
  const id = current.requests[0].id;
  let resolved = false; pending.then(() => { resolved = true; });
  current.respond(id, { configured: true }, {});
  await Promise.resolve(); assert.equal(resolved, false);
  current.respond(id, { configured: true });
  assert.deepEqual(await pending, { configured: true });
  await assert.rejects(current.context.joko.settings({ kind: "routing.set", revision: "0", dataJson: '{"token":"private-$&-candidate"}' }), /Secrets/u);
  assert.equal(current.requests.length, 1);
  assert.throws(() => current.context.BroadcastChannel, /unavailable/u);
  assert.throws(() => current.context.navigator.credentials, /unavailable/u);
});

test("fetch uses the settings bridge and checks its routing revision before a write", async () => {
  const current = page();
  const pending = current.context.fetch("/kv", { method: "PUT", body: '{"folder":"inbox"}' });
  assert.equal(current.requests[0].command.kind, "routing.get");
  current.respond(current.requests[0].id, { revision: "8", dataJson: "{}" });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(current.requests[1].command.kind, "routing.set");
  assert.equal(current.requests[1].command.revision, "8");
  current.respond(current.requests[1].id, { revision: "9", dataJson: '{"folder":"inbox"}' });
  const response = await pending;
  assert.equal((await response.json()).revision, "9");
  await assert.rejects(current.context.fetch("https://foreign.example/kv"), /ambient/u);
});
