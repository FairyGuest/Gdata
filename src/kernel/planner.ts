import { computePlan } from '../domain/topo.ts';
import type { LayeredPlan, OrchestrationDef } from '../domain/types.ts';
import type { RunLogger } from './logger.ts';

export function planOrchestration(def: OrchestrationDef, logger?: RunLogger): LayeredPlan {
  const plan = computePlan(def);
  logger?.info('plan.computed', {
    reason: 'topological layers derived from dependsOn edges; siblings ordered lexicographically for stable output',
    layers: plan.layers,
    startOrder: plan.startOrder,
    stopOrder: plan.stopOrder,
  });
  return plan;
}
