import { createReadStream } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { cp, lstat, mkdir, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Plugin } from "vite";

export const MODEL_VIEWER_ASSET_ROUTE = "/model-viewer-assets/";
export const MODEL_VIEWER_ASSET_FILES = {
  draco: ["draco_decoder.js", "draco_decoder.wasm", "draco_wasm_wrapper.js"],
  basis: ["basis_transcoder.js", "basis_transcoder.wasm"]
} as const;
export const MODEL_VIEWER_ASSET_SOURCE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "node_modules",
  "three",
  "examples",
  "jsm",
  "libs"
);

type ModelViewerAssetDirectory = keyof typeof MODEL_VIEWER_ASSET_FILES;

/** Self-hosts the optional model decoders so previewing never loads runtime code from a CDN. */
export function modelViewerAssetsPlugin(): Plugin {
  let outputDirectory: string | undefined;
  return {
    name: "joko-model-viewer-assets",
    configResolved(config) {
      outputDirectory = config.build.outDir;
    },
    configureServer(server) {
      server.middlewares.use(createModelViewerAssetMiddleware(MODEL_VIEWER_ASSET_SOURCE_ROOT));
    },
    async writeBundle() {
      if (outputDirectory === undefined) throw new Error("The model viewer output directory was not resolved.");
      await copyModelViewerAssets(MODEL_VIEWER_ASSET_SOURCE_ROOT, outputDirectory);
    }
  };
}

export async function copyModelViewerAssets(sourceRoot: string, outputRoot: string): Promise<void> {
  const canonicalSourceRoot = resolve(sourceRoot);
  const canonicalOutputRoot = resolve(outputRoot);
  const destinationRoot = resolve(canonicalOutputRoot, "model-viewer-assets");
  if (dirname(destinationRoot) !== canonicalOutputRoot || basename(destinationRoot) !== "model-viewer-assets") {
    throw new Error("The model viewer asset destination is unsafe.");
  }
  await rm(destinationRoot, { recursive: true, force: true });
  for (const [directory, names] of Object.entries(MODEL_VIEWER_ASSET_FILES) as [ModelViewerAssetDirectory, readonly string[]][]) {
    const sourceDirectory = resolve(canonicalSourceRoot, directory === "draco" ? "draco/gltf" : directory);
    const destinationDirectory = resolve(destinationRoot, directory);
    await mkdir(destinationDirectory, { recursive: true });
    for (const name of names) {
      const source = resolve(sourceDirectory, name);
      const info = await lstat(source).catch((error: unknown) => {
        throw new Error(`The model viewer ${directory}/${name} asset is missing.`, { cause: error });
      });
      if (!info.isFile() || info.isSymbolicLink() || dirname(source) !== sourceDirectory) {
        throw new Error(`The model viewer ${directory}/${name} asset is unsafe.`);
      }
      await cp(source, join(destinationDirectory, name), { dereference: true, errorOnExist: false, force: true });
    }
  }
}

export type ModelViewerAssetMiddleware = (
  request: IncomingMessage,
  response: ServerResponse,
  next: () => void
) => void;

export function createModelViewerAssetMiddleware(sourceRoot: string): ModelViewerAssetMiddleware {
  const canonicalSourceRoot = resolve(sourceRoot);
  return (request, response, next) => {
    const asset = resolveModelViewerAssetRequest(request.url, canonicalSourceRoot);
    if (asset === undefined) {
      next();
      return;
    }
    if (asset === "forbidden") {
      response.statusCode = 403;
      response.end();
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.statusCode = 405;
      response.setHeader("allow", "GET, HEAD");
      response.end();
      return;
    }
    void lstat(asset.path).then((info) => {
      if (!info.isFile() || info.isSymbolicLink()) {
        response.statusCode = 404;
        response.end();
        return;
      }
      response.statusCode = 200;
      response.setHeader("content-length", info.size);
      response.setHeader("content-type", asset.name.endsWith(".wasm") ? "application/wasm" : "text/javascript; charset=utf-8");
      response.setHeader("cache-control", "public, max-age=31536000, immutable");
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      const stream = createReadStream(asset.path);
      stream.once("error", () => response.destroy());
      response.once("close", () => stream.destroy());
      stream.pipe(response);
    }, () => {
      response.statusCode = 404;
      response.end();
    });
  };
}

interface ModelViewerResolvedAsset {
  readonly name: string;
  readonly path: string;
}

function resolveModelViewerAssetRequest(
  requestUrl: string | undefined,
  sourceRoot: string
): ModelViewerResolvedAsset | "forbidden" | undefined {
  if (requestUrl === undefined) return undefined;
  let pathname: string;
  try {
    pathname = new URL(requestUrl, "http://127.0.0.1").pathname;
  } catch {
    return undefined;
  }
  const match = /^\/model-viewer-assets\/(draco|basis)\/([^/]+)$/u.exec(pathname);
  if (match === null) return undefined;
  const directory = match[1] as ModelViewerAssetDirectory;
  const encodedName = match[2];
  if (encodedName === undefined) return "forbidden";
  let name: string;
  try {
    name = decodeURIComponent(encodedName);
  } catch {
    return "forbidden";
  }
  if (!(MODEL_VIEWER_ASSET_FILES[directory] as readonly string[]).includes(name)) return "forbidden";
  const directoryRoot = resolve(sourceRoot, directory === "draco" ? "draco/gltf" : directory);
  const path = resolve(directoryRoot, name);
  if (dirname(path) !== directoryRoot) return "forbidden";
  return { name, path };
}
