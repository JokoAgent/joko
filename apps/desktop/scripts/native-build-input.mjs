import { createHash } from "node:crypto";
import { setTimeout } from "node:timers/promises";

const transientStatuses = new Set([429, 500, 502, 503, 504]);
const transientCodes = new Set([
  "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET"
]);

class TemporaryDownloadError extends Error {}

export async function downloadPinnedInput(url, expectedDigest, maximumBytes) {
  for (let attempt = 1; ; attempt += 1) {
    const signal = AbortSignal.timeout(30_000);
    let response;
    try {
      response = await fetch(url, { redirect: "error", signal });
      if (transientStatuses.has(response.status)) {
        throw new TemporaryDownloadError(`The official Electron input server returned HTTP ${response.status}.`);
      }
      if (!response.ok || response.body === null) {
        throw new Error("An official Electron native build input could not be downloaded.");
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > maximumBytes) {
          throw new Error("An official Electron native build input exceeds its size limit.");
        }
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks);
      if (createHash("sha256").update(bytes).digest("hex") !== expectedDigest) {
        throw new Error("An Electron native build input failed its pinned integrity check.");
      }
      return bytes;
    } catch (error) {
      const transient = error instanceof TemporaryDownloadError
        || error?.name === "TimeoutError"
        || (error?.name === "AbortError" && signal.aborted && signal.reason?.name === "TimeoutError")
        || transientCodes.has(error?.cause?.code);
      if (!transient) throw error;
      if (attempt === 3) {
        throw new Error(`Could not download official Electron native build input ${url.pathname} after 3 attempts.`, { cause: error });
      }
    } finally {
      // Discard an incomplete response before starting a fresh bounded download.
      await response?.body?.cancel().catch(() => {});
    }
    await setTimeout(250 * attempt);
  }
}
