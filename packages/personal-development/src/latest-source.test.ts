import { createServer, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createLatestDevelopmentSourceReader } from "./latest-source.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function httpBoundary(handle: (url: string, response: ServerResponse) => void) {
  const requests: string[] = [];
  const server = createServer((request, response) => { expect(request.headers.authorization).toBeUndefined(); expect(request.headers.cookie).toBeUndefined(); requests.push(request.url!); handle(request.url!, response); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address() as { port: number };
  const fetcher: typeof fetch = (input, init) => {
    const url = new URL(String(input)); expect(url.origin).toBe("https://api.github.com"); expect(url.pathname.startsWith("/repos/JokoAgent/joko/")).toBe(true);
    expect(init).toMatchObject({ credentials: "omit", redirect: "error" });
    return fetch(`http://127.0.0.1:${address.port}${url.pathname}${url.search}`, init);
  };
  return { fetcher, requests };
}
const send = (response: ServerResponse, value: unknown) => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify(value)); };

describe("fixed personal source metadata", () => {
  it("uses real HTTP for exact channel metadata, verifies comparison direction, and never replaces a missing beta with stable", async () => {
    const main = "1".repeat(40), latest = "2".repeat(40); let betaAvailable = true;
    const boundary = await httpBoundary((url, response) => {
      if (url.includes("/compare/")) { send(response, { base_commit: { sha: main }, ahead_by: 2, behind_by: 1 }); return; }
      if (url.includes("/commits/")) { send(response, { sha: latest }); return; }
      if (url.includes("/releases/latest")) { response.statusCode = 404; response.end(); return; }
      if (url.includes("/releases?")) { send(response, betaAvailable ? [{ draft: false, prerelease: false, tag_name: "v1.0.0" }, { draft: false, prerelease: true, tag_name: "v1.1.0-beta.1" }] : [{ draft: false, prerelease: false, tag_name: "v1.0.0" }]); return; }
      response.statusCode = 500; response.end();
    });
    const read = createLatestDevelopmentSourceReader(boundary.fetcher, () => 1000), signal = new AbortController().signal;
    expect(await read("dev", main, signal)).toEqual({ status: "ready", channel: "dev", ref: "main", commit: latest, ahead: 1, behind: 2, checkedAt: 1000 });
    expect(await read("dev", main, signal)).toMatchObject({ ahead: 1, behind: 2 }); expect(boundary.requests).toHaveLength(2);
    expect(await read("release", main, signal)).toMatchObject({ status: "missing", channel: "release" });
    expect(await read("beta", undefined, signal)).toMatchObject({ status: "ready", ref: "v1.1.0-beta.1" });
    betaAvailable = false;
    expect(await createLatestDevelopmentSourceReader(boundary.fetcher)("beta", undefined, signal)).toMatchObject({ status: "missing", channel: "beta" });
    expect(boundary.requests.filter(url => url.endsWith("/commits/v1.0.0"))).toEqual([]);
  });
  it("keeps comparison unknown when public proof is absent and aborts a pending HTTP read", async () => {
    const main = "1".repeat(40), latest = "2".repeat(40); let releaseRequest!: () => void;
    const pending = new Promise<void>(resolve => { releaseRequest = resolve; }); let blocking = false;
    const boundary = await httpBoundary((url, response) => {
      if (blocking) { releaseRequest(); return; }
      if (url.includes("/compare/")) { response.statusCode = 404; response.end(); return; }
      send(response, { sha: latest });
    });
    const read = createLatestDevelopmentSourceReader(boundary.fetcher);
    const value = await read("dev", main, new AbortController().signal);
    expect(value).toMatchObject({ status: "ready", commit: latest }); expect(value.ahead).toBeUndefined(); expect(value.behind).toBeUndefined();
    blocking = true; const controller = new AbortController();
    const outcome = createLatestDevelopmentSourceReader(boundary.fetcher)("dev", main, controller.signal);
    const rejection = expect(outcome).rejects.toMatchObject({ code: "CANCELLED" }); await pending; controller.abort(); await rejection;
  });
});
