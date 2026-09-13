import { createReadStream } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { cp, lstat, mkdir, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Plugin } from "vite";

export const PDFJS_ASSET_ROUTE = "/pdfjs/";
export const PDFJS_ASSET_DIRECTORIES = ["cmaps", "standard_fonts"] as const;
export const PDFJS_DISTRIBUTION_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "node_modules",
  "pdfjs-dist"
);

type PdfJsAssetDirectory = (typeof PDFJS_ASSET_DIRECTORIES)[number];

/**
 * Serves pdf.js' pinned CMaps and standard-font programs in development and
 * copies the same local files into the production Web bundle. The Desktop
 * stager copies that complete bundle, so packaged rendering never needs a CDN.
 */
export function pdfJsAssetsPlugin(): Plugin {
  let outputDirectory: string | undefined;

  return {
    name: "joko-pdfjs-assets",
    configResolved(config) {
      outputDirectory = config.build.outDir;
    },
    configureServer(server) {
      const middleware = createPdfJsAssetMiddleware(PDFJS_DISTRIBUTION_ROOT);
      server.middlewares.use(middleware);
    },
    async writeBundle() {
      if (outputDirectory === undefined) throw new Error("The pdf.js output directory was not resolved.");
      await copyPdfJsAssets(PDFJS_DISTRIBUTION_ROOT, outputDirectory);
    }
  };
}

/** Copies a clean, deterministic pdfjs subtree beneath an already scoped Vite outDir. */
export async function copyPdfJsAssets(sourceRoot: string, outputRoot: string): Promise<void> {
  const canonicalSourceRoot = resolve(sourceRoot);
  const canonicalOutputRoot = resolve(outputRoot);
  const destinationRoot = resolve(canonicalOutputRoot, "pdfjs");
  if (dirname(destinationRoot) !== canonicalOutputRoot || basename(destinationRoot) !== "pdfjs") {
    throw new Error("The pdf.js asset destination is unsafe.");
  }

  await rm(destinationRoot, { recursive: true, force: true });
  await mkdir(destinationRoot, { recursive: true });
  for (const directory of PDFJS_ASSET_DIRECTORIES) {
    const source = resolve(canonicalSourceRoot, directory);
    const sourceInfo = await lstat(source).catch((error: unknown) => {
      throw new Error(`The pdf.js ${directory} source directory is missing.`, { cause: error });
    });
    if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink() || dirname(source) !== canonicalSourceRoot) {
      throw new Error(`The pdf.js ${directory} source directory is unsafe.`);
    }
    await cp(source, join(destinationRoot, directory), {
      recursive: true,
      dereference: true,
      errorOnExist: false,
      force: true
    });
  }
}

export type PdfJsAssetMiddleware = (
  request: IncomingMessage,
  response: ServerResponse,
  next: () => void
) => void;

/** Exact-route middleware: encoded separators and non-files fail closed. */
export function createPdfJsAssetMiddleware(sourceRoot: string): PdfJsAssetMiddleware {
  const canonicalSourceRoot = resolve(sourceRoot);
  return (request, response, next) => {
    const asset = resolvePdfJsAssetRequest(request.url, canonicalSourceRoot);
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
      response.setHeader("content-type", pdfJsAssetMediaType(asset.name));
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

interface PdfJsResolvedAsset {
  readonly directory: PdfJsAssetDirectory;
  readonly name: string;
  readonly path: string;
}

function resolvePdfJsAssetRequest(
  requestUrl: string | undefined,
  sourceRoot: string
): PdfJsResolvedAsset | "forbidden" | undefined {
  if (requestUrl === undefined) return undefined;
  let pathname: string;
  try {
    pathname = new URL(requestUrl, "http://127.0.0.1").pathname;
  } catch {
    return undefined;
  }
  const match = /^\/pdfjs\/(cmaps|standard_fonts)\/([^/]+)$/u.exec(pathname);
  if (match === null) return undefined;
  const directory = match[1] as PdfJsAssetDirectory;
  const encodedName = match[2];
  if (encodedName === undefined) return "forbidden";
  let name: string;
  try {
    name = decodeURIComponent(encodedName);
  } catch {
    return "forbidden";
  }
  if (
    name === "" || name === "." || name === ".." || name.includes("\0") ||
    name.includes("/") || name.includes("\\") || basename(name) !== name
  ) return "forbidden";
  const directoryRoot = resolve(sourceRoot, directory);
  const path = resolve(directoryRoot, name);
  if (dirname(path) !== directoryRoot) return "forbidden";
  return { directory, name, path };
}

function pdfJsAssetMediaType(name: string): string {
  if (name.endsWith(".ttf")) return "font/ttf";
  if (name.startsWith("LICENSE")) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}
