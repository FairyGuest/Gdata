/**
 * Worker entry point: executes exactly one test case from one file and
 * reports the outcome back to the kernel. The kernel may terminate this
 * worker at any time (timeout), so nothing here is allowed to be
 * cancellation-sensitive.
 */
import { parentPort, workerData } from "node:worker_threads";
import { pathToFileURL } from "node:url";

interface Msg {
  kind: "done";
  error?: { name: string; message: string; stack?: string };
}

const run = async (): Promise<void> => {
  const { absPath, caseName } = workerData as { absPath: string; caseName: string };
  const mod = (await import(pathToFileURL(absPath).href)) as {
    tests: Record<string, () => unknown | Promise<unknown>>;
  };
  const fn = mod.tests[caseName];
  if (typeof fn !== "function") {
    throw new Error("case '" + caseName + "' not found in " + absPath);
  }
  await fn();
};

run().then(
  () => {
    parentPort!.postMessage({ kind: "done" } satisfies Msg);
  },
  (err: unknown) => {
    const e = err instanceof Error ? err : new Error(String(err));
    parentPort!.postMessage({
      kind: "done",
      error: { name: e.name, message: e.message, stack: e.stack },
    } satisfies Msg);
  },
);
