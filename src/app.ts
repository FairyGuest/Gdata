import Fastify, { type FastifyInstance } from "fastify";
import { DomainError } from "./contract/errors.ts";
import {
  parseCheckIn,
  parsePurchase,
  parseRefund,
  parseTransfer,
} from "./contract/parser.ts";
import { Kernel } from "./kernel/kernel.ts";
import { fixedFixture } from "./state/fixtures.ts";
import { Ledger } from "./state/ledger.ts";
import { Diagnostics } from "./diag/queries.ts";

export interface AppContext {
  app: FastifyInstance;
  ledger: Ledger;
  kernel: Kernel;
  diag: Diagnostics;
}

export function buildApp(dbLocation = ":memory:"): AppContext {
  const ledger = new Ledger(dbLocation);
  ledger.loadFixture(fixedFixture());
  const kernel = new Kernel(ledger);
  const diag = new Diagnostics(ledger);
  const app = Fastify({ logger: false });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof DomainError) {
      return reply.status(err.httpStatus()).send(err.toBody());
    }
    return reply.status(500).send({
      error: {
        errorClass: "compute",
        reason: "unexpected_error",
        message: err instanceof Error ? err.message : String(err),
      },
    });
  });

  app.post("/tickets/purchase", (req, reply) => {
    const cmd = parsePurchase({ body: req.body }, ledger);
    const result = kernel.execute(cmd);
    if (!result.ok && result.errorClass === "conflict") {
      return reply.status(409).send({ result });
    }
    return reply.status(200).send({ result });
  });

  app.post("/tickets/transfer", (req, reply) => {
    const cmd = parseTransfer({ body: req.body }, ledger);
    const result = kernel.execute(cmd);
    if (!result.ok && result.errorClass === "conflict") {
      return reply.status(409).send({ result });
    }
    return reply.status(200).send({ result });
  });

  app.post("/tickets/refund", (req, reply) => {
    const cmd = parseRefund({ body: req.body }, ledger);
    const result = kernel.execute(cmd);
    if (!result.ok && result.errorClass === "conflict") {
      return reply.status(409).send({ result });
    }
    return reply.status(200).send({ result });
  });

  app.post("/tickets/checkin", (req, reply) => {
    const cmd = parseCheckIn({ body: req.body }, ledger);
    const result = kernel.execute(cmd);
    if (!result.ok && result.errorClass === "conflict") {
      return reply.status(409).send({ result });
    }
    return reply.status(200).send({ result });
  });

  // Read-only diagnostics.
  app.get("/diag/tickets/:ticketId", (req, reply) => {
    const ticketId = (req.params as { ticketId: string }).ticketId;
    const ticket = diag.ticket(ticketId);
    if (!ticket) {
      return reply.status(404).send({
        error: { errorClass: "input", reason: "unknown_ticket", message: `Ticket ${ticketId} not found.` },
      });
    }
    return reply.status(200).send({ ticket, history: diag.history(ticketId) });
  });

  app.get("/diag/sessions/:sessionId/seats/:seatCode", (req, reply) => {
    const { sessionId, seatCode } = req.params as { sessionId: string; seatCode: string };
    const ticket = diag.liveTicket(sessionId, seatCode);
    return reply.status(200).send({ sessionId, seatCode, ticket });
  });

  app.get("/diag/users/:userId", (req, reply) => {
    const userId = (req.params as { userId: string }).userId;
    try {
      return reply.status(200).send({
        userId,
        balance: diag.balance(userId),
        held: diag.heldCount(userId, "S1"),
      });
    } catch (err) {
      if (err instanceof DomainError) {
        return reply.status(err.httpStatus()).send(err.toBody());
      }
      throw err;
    }
  });

  app.get("/diag/runs/:runId", (req, reply) => {
    const runId = (req.params as { runId: string }).runId;
    return reply.status(200).send({ runId, attempts: diag.runAttempts(runId) });
  });

  return { app, ledger, kernel, diag };
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  const port = Number(process.env.PORT ?? 3000);
  const { app } = buildApp();
  app.listen({ port }).then(() => {
    process.stdout.write(`NFT ticketing listening on http://127.0.0.1:${port}\n`);
  });
}

