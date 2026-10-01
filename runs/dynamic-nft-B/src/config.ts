export interface AppConfig {
  /** SQLite file path, or ":memory:" for tests/acceptance. */
  dbPath: string;
  /** Fixed seed for synthetic fixture generation. */
  fixtureSeed: number;
  /** Single feed amount above this is rejected as resource exhaustion (503). */
  maxFeedAmount: number;
}

export const defaultConfig: AppConfig = {
  dbPath: process.env.DB_PATH ?? ":memory:",
  fixtureSeed: 20261001,
  maxFeedAmount: 1_000_000,
};
