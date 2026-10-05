// In-process test runner: the sandboxed CI environment cannot spawn child
// processes, so "node --test test/" (which spawns one process per file) is
// replaced by importing every test file here; node:test executes them
// in-process, prints TAP output and sets the exit code on failure.
await import("../test/diff.test.ts");
await import("../test/engine.test.ts");
await import("../test/api.test.ts");
