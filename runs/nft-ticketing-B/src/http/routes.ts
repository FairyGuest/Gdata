import type { FastifyInstance } from 'fastify';
import { parseOwnership, parsePurchase, parseTransfer, errorResponse } from '../contract/requests.js';
import { DiagnosticReadModel } from '../diag/readModel.js';
import { TicketingKernel } from '../kernel/ticketing.js';

export function registerRoutes(app: FastifyInstance, kernel: TicketingKernel, reads: DiagnosticReadModel): void {
  const send = app;
  void send;

  app.post('/tickets/purchase', async (request, reply) => {
    try {
      return reply.code(200).send(kernel.purchase(parsePurchase(request.body)));
    } catch (error) {
      const response = errorResponse(error);
      return reply.code(response.statusCode).send(response.body);
    }
  });

  app.post('/tickets/transfer', async (request, reply) => {
    try {
      return reply.code(200).send(kernel.transfer(parseTransfer(request.body)));
    } catch (error) {
      const response = errorResponse(error);
      return reply.code(response.statusCode).send(response.body);
    }
  });

  app.post('/tickets/refund', async (request, reply) => {
    try {
      return reply.code(200).send(kernel.refund(parseOwnership(request.body)));
    } catch (error) {
      const response = errorResponse(error);
      return reply.code(response.statusCode).send(response.body);
    }
  });

  app.post('/tickets/check-in', async (request, reply) => {
    try {
      return reply.code(200).send(kernel.checkIn(parseOwnership(request.body)));
    } catch (error) {
      const response = errorResponse(error);
      return reply.code(response.statusCode).send(response.body);
    }
  });

  app.get('/diagnostics/tickets/:ticketId', async (request, reply) => {
    try {
      const ticketId = String((request.params as { ticketId: string }).ticketId);
      return reply.code(200).send(reads.ticket(ticketId));
    } catch (error) {
      const response = errorResponse(error);
      return reply.code(response.statusCode).send(response.body);
    }
  });

  app.get('/diagnostics/seats/:eventId/:seatId', async (request, reply) => {
    const params = request.params as { eventId: string; seatId: string };
    return reply.code(200).send(reads.seat(params.eventId, params.seatId));
  });

  app.get('/diagnostics/users/:userId', async (request, reply) => {
    return reply.code(200).send(reads.user(String((request.params as { userId: string }).userId)));
  });
}
