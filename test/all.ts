// In-process test aggregate. The sandboxed environment cannot spawn child
// processes, so instead of "node --test" (one subprocess per file) we import
// every suite here; node:test executes them in-process and the exit code
// reflects failures.
import "./contract.test.ts";
import "./quota.test.ts";
import "./rotation.test.ts";
import "./concurrency.test.ts";

