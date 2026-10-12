import { Worker } from "node:worker_threads";
import { AgentImportError } from "./types.js";

/** Static read-only SQL; native records travel as data and include committed WAL rows. */
const CRON_WORKER = `
const { DatabaseSync } = require('node:sqlite');
const { parentPort, workerData } = require('node:worker_threads');
const { database, storeKey, agentId, defaultAgent } = workerData;
let db;
try {
  db = new DatabaseSync(database, { readOnly: true, timeout: 5000 });
  const rows = db.prepare(\`SELECT job_json, state_json FROM cron_jobs
    WHERE store_key = ? AND (COALESCE(agent_id, owner_agent_id) = ?
      OR (? = 1 AND COALESCE(agent_id, owner_agent_id) IS NULL)) ORDER BY sort_order\`).iterate(storeKey, agentId, defaultAgent ? 1 : 0);
  const jobs = []; let bytes = 0;
  for (const row of rows) {
    bytes += Buffer.byteLength(row.job_json) + Buffer.byteLength(row.state_json) + 256;
    if (bytes > 16 * 1024 * 1024) throw Object.assign(new Error(), { code: 'SOURCE_DATABASE_TOO_LARGE' });
    jobs.push({ ...JSON.parse(row.job_json), state: JSON.parse(row.state_json) });
  }
  parentPort.postMessage({ jobs });
} catch (error) {
  parentPort.postMessage({ code: error.code === 'SOURCE_DATABASE_TOO_LARGE' ? error.code
    : error.code === 'ERR_UNKNOWN_BUILTIN_MODULE' ? 'SOURCE_DATABASE_DRIVER_UNAVAILABLE'
    : error instanceof SyntaxError ? 'SOURCE_DATABASE_INVALID' : 'SOURCE_DATABASE_UNAVAILABLE' });
} finally { if (db) db.close(); }
`;

export async function readOpenClawCronDatabase(input: {
  database: string; storeKey: string; agentId: string; defaultAgent: boolean;
}, assertOwner: () => void): Promise<Record<string, unknown>[]> {
  assertOwner(); const worker = new Worker(CRON_WORKER, { eval: true, workerData: input });
  let fence: ReturnType<typeof setInterval> | undefined; let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<Record<string, unknown>[]>((resolve, reject) => {
      const fail = (code = "SOURCE_DATABASE_UNAVAILABLE") => reject(new AgentImportError(code));
      worker.once("error", () => fail()); worker.once("exit", () => fail());
      worker.once("message", (message: { jobs?: Record<string, unknown>[]; code?: string }) => {
        try { assertOwner();
          if (Array.isArray(message.jobs)) resolve(message.jobs);
          else fail(["SOURCE_DATABASE_DRIVER_UNAVAILABLE", "SOURCE_DATABASE_INVALID", "SOURCE_DATABASE_TOO_LARGE"].includes(message.code ?? "") ? message.code : undefined);
        } catch (error) { reject(error); }
      });
      timer = setTimeout(() => fail(), 15_000);
      fence = setInterval(() => { try { assertOwner(); } catch (error) { reject(error); } }, 100); fence.unref();
    });
  } finally { clearTimeout(timer); clearInterval(fence); await worker.terminate(); }
}
