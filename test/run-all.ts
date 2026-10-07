// Single-process test entry: node --test spawns subprocesses, which some
// sandboxed environments forbid; importing the suites registers and runs them
// in-process with TAP output and a non-zero exit code on failure.
import "./engine.test.js";
import "./http.test.js";
