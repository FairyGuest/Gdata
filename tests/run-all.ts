/**
 * In-process test entry: imports every test file so node:test executes them
 * in-band (avoids spawning child processes, which some sandboxes forbid).
 */
import "./parser.test.ts";
import "./adapter.test.ts";
import "./runner.test.ts";
import "./store.test.ts";
