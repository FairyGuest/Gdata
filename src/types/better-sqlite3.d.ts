declare module "better-sqlite3" {
  interface Statement {
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  }
  interface Database {
    prepare(sql: string): Statement;
    exec(sql: string): Database;
    pragma(sql: string): unknown;
    close(): void;
  }
  interface DatabaseConstructor {
    new (filename: string, options?: Record<string, unknown>): Database;
    (filename: string, options?: Record<string, unknown>): Database;
  }
  const Database: DatabaseConstructor;
  namespace Database {
    type Database = import("better-sqlite3").Database;
    type Statement = import("better-sqlite3").Statement;
  }
  export = Database;
}

