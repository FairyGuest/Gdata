// Route definitions: the diagnostic interface of the service.

import { Router } from "./http.ts";
import type { HttpResponse } from "./http.ts";
import { parseDriftInput } from "../core/service.ts";
import type { DriftService } from "../core/service.ts";

export function buildRouter(service: DriftService): Router {
  const router = new Router();

  router.add("GET", "/health", (): HttpResponse => ({ status: 200, body: { status: "ok" } }));

  router.add("POST", "/v1/drift-checks", (req): HttpResponse => {
    const input = parseDriftInput(req.body);
    const output = service.runDriftCheck(input);
    return { status: 200, body: output };
  });

  router.add("GET", "/v1/runs", (req): HttpResponse => ({
    status: 200,
    body: { runs: service.listRuns(req.query["env"]) },
  }));

  router.add("GET", "/v1/runs/:runId", (req, params): HttpResponse => {
    const record = service.replay(params["runId"]!, req.query["env"]);
    return { status: 200, body: record };
  });

  return router;
}
