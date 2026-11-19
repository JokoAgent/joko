import { setTimeout as delay } from "node:timers/promises";
import { atomicWritePrivateFile, readPrivateFile } from "@joko/device-peer/private-files";

export type DesktopWindowTheme = "dark" | "light" | "system";

export function isDesktopWindowTheme(value: unknown): value is DesktopWindowTheme {
  return value === "dark" || value === "light" || value === "system";
}

export function desktopWindowBackground(theme: DesktopWindowTheme, systemDark: boolean): string {
  return theme === "dark" || theme === "system" && systemDark ? "#0d0d0d" : "#f2f2f2";
}

/** Startup mirror of the renderer's durable UI preference. */
export async function openDesktopWindowAppearance(path: string) {
  const file = await readPrivateFile(path).catch(() => undefined);
  const saved = file === undefined ? undefined : Buffer.from(file).toString("utf8").trim();
  let preference = isDesktopWindowTheme(saved) ? saved : undefined;
  let writes = Promise.resolve();
  return {
    theme: (): DesktopWindowTheme => preference ?? "dark",
    save: (next: DesktopWindowTheme, assertCurrent: () => void): Promise<void> => {
      const write = writes.then(async () => {
        assertCurrent();
        if (preference === next) return;
        const bytes = Buffer.from(`${next}\n`, "utf8");
        for (let attempt = 0; ; attempt += 1) {
          try {
            await atomicWritePrivateFile(path, bytes);
            break;
          } catch (error) {
            const code = (error as NodeJS.ErrnoException | undefined)?.code;
            if (process.platform !== "win32" || attempt >= 4 || !["EPERM", "EACCES", "EBUSY"].includes(code ?? "")) throw error;
            await delay(20 * 2 ** attempt);
            assertCurrent();
          }
        }
        preference = next;
      });
      writes = write.catch(() => undefined);
      return write;
    }
  };
}
