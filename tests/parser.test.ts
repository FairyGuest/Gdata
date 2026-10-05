import test from "node:test";
import assert from "node:assert/strict";
import { patternToRegex, discoverTests } from "../src/contract/parser.ts";
import { RunnerError } from "../src/contract/errors.ts";

test("patternToRegex matches expected paths", () => {
  const re = patternToRegex("**/*.test.js");
  assert.ok(re.test("a.test.js"));
  assert.ok(re.test("sub/dir/a.test.js"));
  assert.ok(!re.test("a.test.ts"));
  assert.ok(!re.test("a.js"));
  const flat = patternToRegex("*.test.js");
  assert.ok(flat.test("a.test.js"));
  assert.ok(!flat.test("sub/a.test.js"));
});

test("discoverTests finds files and parses cases", async () => {
  const files = await discoverTests("tests/fixtures/suite", "**/*.test.js");
  const byRel = new Map(files.map((f) => [f.relPath, f]));
  assert.deepEqual([...byRel.keys()].sort(), ["boom.test.js", "hang.test.js", "ok.test.js"]);
  assert.deepEqual(byRel.get("ok.test.js")!.cases, ["ok one", "ok two"]);
  assert.deepEqual(byRel.get("boom.test.js")!.cases, ["explodes"]);
});

test("discoverTests rejects missing directory with INPUT_ERROR", async () => {
  await assert.rejects(
    () => discoverTests("tests/fixtures/does-not-exist", "**/*.test.js"),
    (err: unknown) => err instanceof RunnerError && err.code === "INPUT_ERROR",
  );
});

test("discoverTests rejects file without tests export", async () => {
  await assert.rejects(
    () => discoverTests("tests/fixtures/bad", "**/*.test.js"),
    (err: unknown) => err instanceof RunnerError && err.code === "INPUT_ERROR" && /tests/.test(err.message),
  );
});

test("discoverTests detects dependency cycles", async () => {
  await assert.rejects(
    () => discoverTests("tests/fixtures/cycle", "**/*.test.js"),
    (err: unknown) => err instanceof RunnerError && err.code === "INPUT_ERROR" && /cycle/.test(err.message),
  );
});
