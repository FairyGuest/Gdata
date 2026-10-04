declare module "better-sqlite3" {
  namespace Database {
    interface Database {
      prepare(sql: string): Statement;
      exec(sql: string): unknown;
      pragma(sql: string): unknown;
      transaction<T>(fn: () => T): () => T;
      close(): void;
    }
    interface Statement {
      run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
      get(...params: unknown[]): unknown;
      all(...params: unknown[]): unknown[];
    }
  }
  interface DatabaseConstructor {
    new (filename: string, options?: Record<string, unknown>): Database.Database;
    (filename: string, options?: Record<string, unknown>): Database.Database;
  }
  const Database: DatabaseConstructor;
  export = Database;
}
