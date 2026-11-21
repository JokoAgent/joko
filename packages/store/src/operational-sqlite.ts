import type { DatabaseSync, StatementSync } from "node:sqlite";

/** Node exposes SQLite's extended numeric result separately from its JS error code. */
export function isOperationalSqliteCorruption(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error) || error.code !== "ERR_SQLITE_ERROR"
    || !("errcode" in error) || typeof error.errcode !== "number" || !Number.isSafeInteger(error.errcode)) return false;
  const primary = error.errcode & 0xff;
  return primary === 11 || primary === 26;
}

/**
 * Keep the native receiver for SQLite's bound methods. Also guard each step
 * of lazy statement iteration, where SQLite can first report bad pages.
 */
export function guardOperationalDatabase(database: DatabaseSync, execute: <T>(operation: () => T) => T): DatabaseSync {
  const statement = (prepared: StatementSync): StatementSync => new Proxy(prepared, {
    get(owner, key) {
      if (key === "iterate") {
        return (...args: unknown[]) => {
          const rows = execute(() => Reflect.apply(owner.iterate, owner, args) as ReturnType<StatementSync["iterate"]>);
          return {
            [Symbol.iterator]() { return this; },
            next: () => execute(() => rows.next()),
            return: () => rows.return?.() ?? { done: true, value: undefined }
          };
        };
      }
      const value: unknown = Reflect.get(owner, key, owner);
      return typeof value === "function" ? (...args: unknown[]) => execute(() => Reflect.apply(value, owner, args)) : value;
    }
  });
  return new Proxy(database, {
    get(owner, key) {
      if (key === "prepare") return (sql: string) => statement(execute(() => owner.prepare(sql)));
      if (key === "exec") return (sql: string) => {
        if (sql.startsWith("ROLLBACK")) return owner.exec(sql);
        return execute(() => owner.exec(sql));
      };
      const value: unknown = Reflect.get(owner, key, owner);
      return typeof value === "function" ? value.bind(owner) : value;
    }
  });
}
