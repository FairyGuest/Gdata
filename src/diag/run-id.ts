let runCounter = 0;

/**
 * Generates a run id used for replay. This is a diagnostic correlation id only;
 * concurrency arbitration never uses run ids or wall-clock timestamps - the
 * SQLite commit_log.seq is the sole ordering authority.
 */
export function createRunIdFactory(prefix = "run"): () => string {
  return () => {
    runCounter += 1;
    const rand = Math.floor(Math.random() * 0x10000)
      .toString(16)
      .padStart(4, "0");
    return `${prefix}-${process.pid.toString(36)}-${String(runCounter).padStart(6, "0")}-${rand}`;
  };
}
