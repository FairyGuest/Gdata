// In-process test entry: node:test auto-runs registered suites and exits
// non-zero on failure. (The sandbox here cannot spawn per-file subprocesses.)
import "./crypto.test.ts";
import "./vault.test.ts";
import "./api.test.ts";
