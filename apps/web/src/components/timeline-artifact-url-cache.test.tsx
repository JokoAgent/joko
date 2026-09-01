// @vitest-environment jsdom

import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { useTimelineArtifactUrlCache } from "./timeline-artifact-url-cache.js";

const roots: Root[] = [];

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
});

describe("timeline artifact URL cache", () => {
  it("deduplicates acquisitions and releases each owner lease on task switch and unmount", async () => {
    const acquire = vi.fn(async (blobId: string) => `blob:${blobId}`);
    const release = vi.fn();
    const rendered = await renderProbe("session-one", acquire, release);
    expect(acquire).toHaveBeenCalledOnce();

    await rendered.rerender("session-two");
    expect(release).toHaveBeenNthCalledWith(1, "artifact");
    expect(acquire).toHaveBeenCalledTimes(2);
    await act(async () => rendered.root.unmount());
    roots.splice(roots.indexOf(rendered.root), 1);
    expect(release).toHaveBeenNthCalledWith(2, "artifact");
  });

  it("releases a pending acquisition that finishes after its owner has switched", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const acquire = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const release = vi.fn();
    const rendered = await renderProbe("session-one", acquire, release);

    await rendered.rerender("session-two");
    expect(release).not.toHaveBeenCalled();
    await act(async () => first.resolve("blob:first"));
    expect(release).toHaveBeenCalledWith("artifact");
    await act(async () => second.resolve("blob:second"));
    await act(async () => rendered.root.unmount());
    roots.splice(roots.indexOf(rendered.root), 1);
    expect(release).toHaveBeenCalledTimes(2);
  });
});

function Probe({ ownerKey, acquire, release }: {
  readonly ownerKey: string;
  readonly acquire: (blobId: string) => Promise<string>;
  readonly release: (blobId: string) => void;
}): null {
  const load = useTimelineArtifactUrlCache(ownerKey, acquire, release);
  useEffect(() => {
    void load("artifact");
    void load("artifact");
  }, [load, ownerKey]);
  return null;
}

async function renderProbe(ownerKey: string, acquire: (blobId: string) => Promise<string>, release: (blobId: string) => void): Promise<{
  readonly root: Root;
  readonly rerender: (nextOwnerKey: string) => Promise<void>;
}> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<Probe ownerKey={ownerKey} acquire={acquire} release={release} />));
  return {
    root,
    rerender: async (nextOwnerKey) => act(async () => root.render(<Probe ownerKey={nextOwnerKey} acquire={acquire} release={release} />))
  };
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}
