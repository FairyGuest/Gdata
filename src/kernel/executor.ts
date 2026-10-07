import { checkHealth } from '../domain/health.ts';
import { computeLayers } from '../domain/topo.ts';
import type { ExecutionResult, LayerFailure, OrchestrationDef } from '../domain/types.ts';
import type { RunLogger } from './logger.ts';

export function executeStart(def: OrchestrationDef, logger: RunLogger): ExecutionResult {
  const layers = computeLayers(def);
  const byName = new Map(def.services.map((s) => [s.name, s]));
  const completedLayers: string[][] = [];
  const startedServices: string[] = [];

  logger.info('execution.begin', {
    reason: 'layered start: a layer must be fully healthy before the next layer starts',
    layerCount: layers.length,
    layers,
  });

  for (let i = 0; i < layers.length; i += 1) {
    const layer = layers[i];
    logger.info('layer.start', { layer: i, services: layer });
    const failures: LayerFailure[] = [];
    for (const name of layer) {
      const service = byName.get(name);
      if (!service) {
        failures.push({ service: name, reason: 'service definition missing at execution time' });
        continue;
      }
      const outcome = checkHealth(service);
      logger.log(outcome.healthy ? 'info' : 'error', 'service.health', {
        layer: i,
        service: name,
        healthy: outcome.healthy,
        reason: outcome.reason,
      });
      if (!outcome.healthy) {
        failures.push({ service: name, reason: outcome.reason });
      }
    }
    if (failures.length > 0) {
      logger.error('layer.failed', {
        layer: i,
        reason: 'batch halted: one or more services in the layer are unhealthy; subsequent layers never start',
        failures,
        startedServices,
      });
      return { status: 'FAILED', failedLayer: i, failures, completedLayers, startedServices };
    }
    completedLayers.push(layer);
    startedServices.push(...layer);
    logger.info('layer.healthy', { layer: i, services: layer, reason: 'all services in layer reported healthy' });
  }

  logger.info('execution.complete', { reason: 'all layers healthy', startedServices });
  return { status: 'SUCCEEDED', failedLayer: null, failures: [], completedLayers, startedServices };
}
