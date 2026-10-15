import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface HelpFeedbackInput {
  readonly requestId: string;
  readonly question: string;
  readonly answer: string;
  readonly title: string;
  readonly body: string;
  readonly locale: string;
}

interface RecordValue {
  readonly format: 1;
  readonly ownerId: string;
  readonly id: string;
  readonly createdAt: string;
  readonly input: HelpFeedbackInput;
}

export const HELP_LOCALES = new Set(["zh-CN", "zh-TW", "en", "ja", "ko"]);

export function validateHelpFeedback(input: HelpFeedbackInput): HelpFeedbackInput {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(input.requestId)
    || !HELP_LOCALES.has(input.locale)
    || typeof input.question !== "string" || !input.question.trim() || input.question.length > 24_000
    || typeof input.answer !== "string" || input.answer.length > 24_000
    || typeof input.title !== "string" || !input.title.trim() || input.title.length > 1_000
    || typeof input.body !== "string" || input.body.length > 64_000) throw new RangeError("Help feedback input is invalid.");
  return { requestId: input.requestId.toLowerCase(), question: input.question, answer: input.answer,
    title: input.title, body: input.body, locale: input.locale };
}

/** Private immutable drafts; no Event, Operation, Session, diagnostics or remote publication. */
export class HelpFeedbackStore {
  #tail: Promise<unknown> = Promise.resolve();
  constructor(readonly directory: string) {}

  async create(ownerId: string, raw: HelpFeedbackInput, assertCurrent: () => void): Promise<string> {
    const input = validateHelpFeedback(raw);
    const effect = this.#tail.then(async () => {
      assertCurrent();
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const path = join(this.directory, `${input.requestId}.json`);
      let stored: string | undefined;
      try { stored = await readFile(path, "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      assertCurrent();
      if (stored !== undefined) {
        let value: RecordValue;
        try { value = JSON.parse(stored) as RecordValue; }
        catch { throw new Error("Help feedback storage is unavailable."); }
        if (!value || Object.keys(value).sort().join(",") !== "createdAt,format,id,input,ownerId"
          || value.format !== 1 || value.ownerId !== ownerId || typeof value.id !== "string"
          || typeof value.createdAt !== "string" || JSON.stringify(value.input) !== JSON.stringify(input)) {
          throw new Error("Help feedback request identity cannot be reused.");
        }
        return value.id;
      }
      const value: RecordValue = { format: 1, ownerId, id: randomUUID(), createdAt: new Date().toISOString(), input };
      const temporary = `${path}.tmp-${randomUUID()}`;
      try {
        await writeFile(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 });
        assertCurrent();
        await rename(temporary, path);
        assertCurrent();
        return value.id;
      } finally { await rm(temporary, { force: true }); }
    });
    this.#tail = effect.catch(() => undefined);
    return effect;
  }
}
