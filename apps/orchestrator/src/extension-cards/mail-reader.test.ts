import { expect, it, vi } from "vitest";
import { createExtensionMailReader, type ExtensionMailReader } from "./mail-reader.js";

const plugin: ExtensionMailReader = { id: "mail", reader: { tool: "read_message", hosts: ["mail.example.test"], markRead: true } };
const message = { accountId: "one", messageId: "message", from: "Sender", to: "Owner", cc: "", bcc: "", subject: "Hello", date: "Today", bodyText: "Message", bodyHtml: "<p>Message</p>", attachments: [] };
function fixture() {
  let current = true, plugins = [plugin];
  const authorize = vi.fn(() => { if (!current) throw new Error("Retired."); }), call = vi.fn(async (_plugin: ExtensionMailReader, _url: string, _markRead?: true) => ({ ok: true, result: message as unknown }));
  const read = createExtensionMailReader({ authorize, captureScope: () => authorize, plugins: () => plugins, call });
  return { read, call, authorize, retire: () => { current = false; }, plugins: (values: ExtensionMailReader[]) => { plugins = values; } };
}
it("probes without calling tools and marks read only on an explicit opening with a declared capability", async () => {
  const f = fixture(); expect(await f.read("https://mail.example.test/messages/one", false, false)).toEqual({ supported: true }); expect(f.call).not.toHaveBeenCalled();
  expect(await f.read("https://mail.example.test/messages/one", true, false)).toEqual({ supported: true, message, extensionId: "mail" }); expect(f.call).toHaveBeenLastCalledWith(plugin, "https://mail.example.test/messages/one", undefined);
  await f.read("https://mail.example.test/messages/one", true, true); expect(f.call).toHaveBeenLastCalledWith(plugin, "https://mail.example.test/messages/one", true);
  f.plugins([{ ...plugin, reader: { ...plugin.reader, markRead: undefined } }]); await f.read("https://mail.example.test/messages/one", true, true); expect(f.call.mock.calls.at(-1)?.[2]).toBeUndefined();
});
it("rejects ambiguous providers and exact-host or URL authority mismatches", async () => {
  const f = fixture(); f.plugins([plugin, { ...plugin, id: "second" }]); expect(await f.read("https://mail.example.test/m", true, true)).toEqual({ supported: true, error: "MAIL_PROVIDER_AMBIGUOUS" }); expect(f.call).not.toHaveBeenCalled();
  for (const url of ["http://mail.example.test/m", "https://other.mail.example.test/m", "https://owner:secret@mail.example.test/m", "https://mail.example.test:444/m"]) expect(await f.read(url, true, true)).toEqual({ supported: false });
});
it("does not return late data when its owner retires and removes conversations outside the selected provider", async () => {
  const f = fixture(); f.call.mockImplementation(async () => { f.retire(); return { ok: true, result: message }; }); await expect(f.read("https://mail.example.test/m", true, true)).rejects.toThrow("Retired");
  const next = fixture(); next.call.mockResolvedValue({ ok: true, result: { ...message, conversation: { threadId: "thread", messages: [{ messageId: "message", url: "https://outside.example.test/m", from: "Sender", date: "Today", subject: "Hello", snippet: "Message" }] } } });
  const result = await next.read("https://mail.example.test/m", true, true); expect(result.message).not.toHaveProperty("conversation"); expect(result.message?.conversationUnavailable).toBe(true);
});
