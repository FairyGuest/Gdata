import type { Engine } from "../kernel/engine.js";

/** Read-only diagnostics: loan state, settlement view, full ledger snapshot. */
export function buildDiagRoutes(engine: Engine) {
  return {
    loan: (id: number) => engine.loanQuote(id),
    state: () => engine.snapshot(),
  };
}
