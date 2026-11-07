import assert from "node:assert/strict";
import { test } from "node:test";
import { Script, createContext } from "node:vm";
import { webcrypto } from "node:crypto";
import { EXTENSION_SECRET_CHECK_FAILED, EXTENSION_SETTINGS_SDK_SOURCE, extensionSettingsSdkSource, parseExtensionSettingsBridgeRequest } from "../dist/index.js";

test("author settings only accepts declared commands and bounded private input", () => {
  const request = command => ({ type: "joko:extension-settings-request", version: 1, id: "settings-one", command });
  assert.ok(parseExtensionSettingsBridgeRequest(request({ kind: "secret.check", key: "token", value: "candidate" })));
  assert.ok(parseExtensionSettingsBridgeRequest(request({ kind: "agent-models.get" })));
  assert.ok(parseExtensionSettingsBridgeRequest(request({ kind: "image-models.get" })));
  assert.ok(parseExtensionSettingsBridgeRequest(request({ kind: "directory.pick", title: "Select report files" })));
  for (const command of [
    { kind: "rpc", method: "deleteSession", arguments: {} },
    { kind: "agent-models.get", backendId: "remote" },
    { kind: "image-models.get", type: "video" },
    { kind: "secret.set", fieldId: "network-secret:token", value: "x", resourceId: "other" },
    { kind: "oauth.connect", key: "account", scopes: new Array(33).fill("scope") },
    { kind: "secret.check", key: "token", value: "x".repeat(65_537) },
    { kind: "routing.set", revision: "1e9", dataJson: "{}" },
    { kind: "connections.change", key: "site", action: "deleteAll", connectionId: "one" },
    { kind: "directory.pick", path: "/etc" }, { kind: "directory.pick", title: "x".repeat(161) }
  ]) assert.equal(parseExtensionSettingsBridgeRequest(request(command)), undefined);
  assert.equal(parseExtensionSettingsBridgeRequest({ ...request({ kind: "context.get" }), sourceSession: "foreign" }), undefined);
});

function page(source = EXTENSION_SETTINGS_SDK_SOURCE) {
  const listeners = new Map(), requests = [];
  const parent = { postMessage: value => requests.push(value) };
  const context = { parent, navigator: {}, location: { origin: "null" }, crypto: webcrypto, URL, Response, DOMException,
    fetch: async () => { throw new Error("ambient network denied"); }, setTimeout, clearTimeout,
    addEventListener: (name, callback) => { const values = listeners.get(name) ?? new Set(); values.add(callback); listeners.set(name, values); },
    removeEventListener: (name, callback) => listeners.get(name)?.delete(callback) };
  context.window = context;
  new Script(source).runInContext(createContext(context));
  const dispatch = (name, event) => { for (const callback of listeners.get(name) ?? []) callback(event); };
  const respond = (id, result, source = parent) => dispatch("message", { source, data: { type: "joko:extension-settings-response", version: 1, id, ok: true, result } });
  const reject = (id, message) => dispatch("message", { source: parent, data: { type: "joko:extension-settings-response", version: 1, id, ok: false, message } });
  return { context, requests, dispatch, respond, reject };
}

test("the authored Agent model directory admits only its parameterless same-origin read", async () => {
  const current = page();
  assert.equal((await current.context.fetch("/agent-models", { method: "POST" })).status, 405);
  assert.equal((await current.context.fetch("/agent-models?backend=remote")).status, 400);
  await assert.rejects(current.context.fetch("https://foreign.example/agent-models"), /ambient/u);
  assert.equal(current.requests.length, 0);

  const pending = current.context.fetch("/agent-models");
  const request = parseExtensionSettingsBridgeRequest(current.requests[0]);
  assert.equal(request.command.kind, "agent-models.get");
  const models = [{ id: "text", name: "Text", agent: "pi", providerId: "test", providerName: "Test", efforts: [], defaultEffort: null, visible: false }];
  current.respond(request.id, { ok: true, models });
  const response = await pending;
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { ok: true, models });

  const unavailable = current.context.fetch("/agent-models");
  current.reject(current.requests[1].id, "internal fixture details");
  const failed = await unavailable;
  assert.equal(failed.status, 503);
  assert.deepEqual(await failed.json(), { ok: false, errorCode: "NOT_AVAILABLE", message: "Model catalog unavailable." });
});

test("directory selection only sends a native choice request and requires a read deposit", async () => {
  const current = page();
  await assert.rejects(current.context.fetch("/pick", { method: "POST", body: JSON.stringify({ mode: "directory", deposit: false }) }), /read deposit/u);
  await assert.rejects(current.context.fetch("/pick", { method: "POST", body: JSON.stringify({ mode: "directory", deposit: true, path: "/private" }) }), /read deposit/u);
  const pending = current.context.fetch("/pick", { method: "POST", body: JSON.stringify({ mode: "directory", deposit: true, title: "Reports" }) });
  assert.deepEqual(JSON.parse(JSON.stringify(current.requests[0].command)), { kind: "directory.pick", title: "Reports" });
  current.respond(current.requests[0].id, { dir_deposit: { token: "receipt", file_count: 1, total_bytes: 4, rel_paths: ["report.txt"] } });
  const response = await pending; assert.equal((await response.json()).dir_deposit.token, "receipt");
});

test("the authored media directory reads the single approved image query", async () => {
  const current = page();
  assert.equal((await current.context.fetch("/media-models?type=image", { method: "POST" })).status, 405);
  for (const query of ["", "?type=video", "?type=image&type=image", "?type=image&provider=other", "?type=image#fragment"]) {
    assert.equal((await current.context.fetch(`/media-models${query}`)).status, 400);
  }
  assert.equal(current.requests.length, 0);
  const pending = current.context.fetch("/media-models?type=image");
  const request = parseExtensionSettingsBridgeRequest(current.requests[0]);
  assert.equal(request.command.kind, "image-models.get");
  const result = { ok: true, type: "image", models: [{ id: "image", name: "Image", providerId: "provider",
    modalities: { input: ["text"], output: ["image"] } }], defaultModelId: "image", defaultProviderId: "provider" };
  current.respond(request.id, result);
  const response = await pending;
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), result);
});

test("author connection token and deletion path use the protected v1 commands", async () => {
  const current = page();
  const token = "private-synthetic-connection-token", id = "7f33bd64-4853-47a7-816a-f566432c946d";
  const row = { connectionId: id, host: "gitlab.example.com", label: "Office", configured: true, isDefault: true };
  const state = { extensionId: "extension", revision: { value: "8" }, slots: [{ key: "gitlab", connections: [row] }] };
  const add = current.context.fetch("/connections/gitlab", { method: "POST",
    body: JSON.stringify({ host: "Gitlab.example.com", token, label: "Office" }) });
  const setting = parseExtensionSettingsBridgeRequest(current.requests[0]);
  assert.deepEqual(JSON.parse(JSON.stringify(setting?.command)), { kind: "connections.set", key: "gitlab",
    host: "Gitlab.example.com", value: token, label: "Office" });
  current.respond(setting.id, state);
  const saved = await (await add).json();
  assert.deepEqual(saved, { ...state, ok: true, connection: { id, host: row.host, label: row.label, isDefault: true } });
  assert.doesNotMatch(JSON.stringify(saved), /private-synthetic-connection-token/u);
  await assert.rejects(current.context.joko.settings({ kind: "routing.set", revision: "0", dataJson: JSON.stringify({ token }) }), /Secrets/u);

  const legacy = current.context.fetch("/connections/gitlab", { method: "POST",
    body: JSON.stringify({ host: row.host, value: "replacement" }) });
  current.respond(current.requests[1].id, state);
  assert.deepEqual(await (await legacy).json(), state);

  const remove = current.context.fetch(`/connections/gitlab/${id}`, { method: "DELETE" });
  const deletion = parseExtensionSettingsBridgeRequest(current.requests[2]);
  assert.deepEqual(JSON.parse(JSON.stringify(deletion?.command)), { kind: "connections.change", key: "gitlab", action: "remove", connectionId: id });
  current.respond(deletion.id, { ...state, slots: [{ key: "gitlab", connections: [] }] });
  const removed = await remove;
  assert.equal(removed.status, 204);
  assert.equal(await removed.text(), "");
  assert.equal(current.requests.length, 3);
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

test("a standard same-origin URL enters the bounded settings fetch bridge", async () => {
  const current = page(), endpoint = new URL("/kv", "https://settings.joko.invalid/author/settings.html");
  const pending = current.context.fetch(endpoint);
  assert.equal(current.requests[0]?.command.kind, "routing.get");
  current.respond(current.requests[0].id, { revision: "8", dataJson: '{"folder":"inbox"}' });
  assert.deepEqual(await (await pending).json(), { folder: "inbox" });
  await assert.rejects(current.context.fetch(new URL("/kv", "https://foreign.example/")), /ambient/u);
  await assert.rejects(current.context.fetch(new URL("/kv?scope=other", endpoint)), /query/u);
  assert.equal(current.requests.length, 1);
});

test("fetch does not send a password that becomes escaped in plugin parameters", async () => {
  const current = page(), value = 'fixture"header-secret';
  current.dispatch("input", { target: { type: "password", value } });
  const pending = current.context.fetch("/kv", { method: "PUT", body: JSON.stringify({ route: [{ value }] }) });
  assert.equal(current.requests[0].command.kind, "routing.get");
  current.respond(current.requests[0].id, { revision: "1", dataJson: "{}" });
  await assert.rejects(pending, /Secrets/u);
  assert.equal(current.requests.length, 1);
  await assert.rejects(current.context.joko.settings({ kind: "routing.set", revision: "1",
    dataJson: `{"route":${JSON.stringify(value)},"route":"ordinary"}` }), /Secrets/u);
  assert.equal(current.requests.length, 1);
});

test("fetch rejects an already cancelled credential write before it sends a settings command", { timeout: 2_000 }, async t => {
  const current = page();
  t.after(() => current.dispatch("pagehide", {}));
  const controller = new AbortController();
  controller.abort();
  const reason = controller.signal.reason;
  const body = JSON.stringify({ value: "fixture-secret" });
  const aborted = error => error === reason;
  await assert.rejects(current.context.fetch("/secrets/token", { method: "PUT", body, signal: controller.signal }), aborted);
  const request = new Request("https://settings.joko.invalid/secrets/token", { method: "PUT", body, signal: controller.signal });
  await assert.rejects(current.context.fetch(request), aborted);
  assert.equal(current.requests.length, 0);

  const pending = current.context.fetch(request, { signal: null, body });
  assert.equal(current.requests.length, 1);
  assert.equal(current.requests[0].command.kind, "secret.set");
  current.respond(current.requests[0].id, { configured: true });
  const saved = await pending;
  assert.equal(saved.status, 204);
  assert.equal(saved.ok, true);
  assert.equal(await saved.text(), "");
});

test("progressive password input keeps the complete candidate savable through the private bridge", { timeout: 2_000 }, async t => {
  const current = page(), value = "A".repeat(65);
  t.after(() => current.dispatch("pagehide", {}));
  for (let length = 1; length <= value.length; length += 1) {
    current.dispatch("input", { target: { type: "password", value: value.slice(0, length) } });
  }
  const pending = current.context.fetch("/secrets/token", { method: "PUT", body: JSON.stringify({ value }) });
  assert.equal(current.requests.length, 1);
  assert.equal(current.requests[0].command.kind, "secret.set");
  assert.equal(current.requests[0].command.value, value);
  current.respond(current.requests[0].id, { configured: true });
  assert.equal((await pending).status, 204);
  await assert.rejects(current.context.joko.settings({ kind: "routing.set", revision: "0", dataJson: JSON.stringify({ parameter: value }) }), /Secrets/u);
  assert.equal(current.requests.length, 1);
});

test("default connection selection and readback return a lossless JSON revision", { timeout: 2_000 }, async t => {
  const current = page();
  t.after(() => current.dispatch("pagehide", {}));
  const state = { extensionId: "fixture-extension", revision: { value: 9007199254740993n }, slots: [{ key: "gitlab", connections: [
    { connectionId: "a", isDefault: false, configured: true }, { connectionId: "b", isDefault: true, configured: true }
  ] }] };
  const saved = current.context.fetch("/connections/gitlab/default", { method: "POST", body: JSON.stringify({ connectionId: "b" }) });
  assert.deepEqual(JSON.parse(JSON.stringify(current.requests[0].command)), { kind: "connections.change", key: "gitlab", action: "default", connectionId: "b" });
  current.respond(current.requests[0].id, state);
  const expected = { ...state, revision: { value: "9007199254740993" } };
  assert.deepEqual(await (await saved).json(), expected);
  const read = current.context.fetch("/connections");
  assert.equal(current.requests[1].command.kind, "connections.get");
  current.respond(current.requests[1].id, state);
  assert.deepEqual(await (await read).json(), expected);
});

test("the installed settings SDK exposes checks only for matching current secret slots", { timeout: 2_000 }, async t => {
  const current = page(extensionSettingsSdkSource(["token", "retired"]));
  t.after(() => current.dispatch("pagehide", {}));
  const read = current.context.fetch("/secrets");
  assert.equal(current.requests[0].command.kind, "setup.get");
  const result = { extensionId: "fixture-extension", secrets: { token: { configured: false }, optional: { configured: true } } };
  current.respond(current.requests[0].id, result);
  assert.deepEqual(await (await read).json(), { ...result, secrets: {
    token: { configured: false, checkSupported: true }, optional: { configured: true }
  } });
  assert.equal(result.secrets.token.checkSupported, undefined);
});

test("a confirmed candidate check failure has an HTTP receipt and the same document can explicitly retry", { timeout: 2_000 }, async t => {
  const current = page();
  t.after(() => current.dispatch("pagehide", {}));
  const request = () => current.context.fetch("/secrets/token/check", { method: "POST", body: '{"value":"fixture-candidate"}' });
  const failed = request();
  assert.equal(current.requests[0].command.kind, "secret.check");
  current.reject(current.requests[0].id, EXTENSION_SECRET_CHECK_FAILED);
  const response = await failed;
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: EXTENSION_SECRET_CHECK_FAILED });
  assert.equal(current.requests.length, 1);
  const retry = request();
  current.respond(current.requests[1].id, { valid: true });
  assert.deepEqual(await (await retry).json(), { valid: true });
});
