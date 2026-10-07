import type { FastifyInstance, FastifyError } from 'fastify';
import { OrchestrationError, errorBody } from '../contract/errors.ts';

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((rawErr, req, reply) => {
    const err = rawErr as FastifyError & { limit?: number };
    if (err instanceof OrchestrationError) {
      return reply.status(err.httpStatus).send(errorBody(err));
    }
    if (err.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      const wrapped = new OrchestrationError('RESOURCE_EXHAUSTED', 'request body exceeds configured limit', {
        limit: err.limit,
      });
      return reply.status(507).send(errorBody(wrapped));
    }
    if (err.code === 'FST_ERR_CTP_INVALID_JSON' || (err.statusCode === 400 && /json/i.test(err.message))) {
      const wrapped = new OrchestrationError('CONTRACT_PARSE_ERROR', 'request body is not valid JSON', {
        cause: err.message,
      });
      return reply.status(400).send(errorBody(wrapped));
    }
    req.log.error(err);
    const wrapped = new OrchestrationError('COMPUTATION_FAILED', 'unexpected internal failure', {
      cause: err.message,
    });
    return reply.status(500).send(errorBody(wrapped));
  });
}
