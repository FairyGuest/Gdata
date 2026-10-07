import type { OrchestrationSpec, StartupResult, LayerResult } from '../contract/types.ts';

export type LogFn = (line: string) => void;

export function simulateStartup(
  spec: OrchestrationSpec,
  layers: string[][],
  log: LogFn,
): StartupResult {
  const healthByName = new Map(spec.services.map((s) => [s.name, s.healthCheck.result]));
  const layerResults: LayerResult[] = [];

  for (let layerIndex = 0; layerIndex < layers.length; layerIndex++) {
    const layer = layers[layerIndex];
    log(`layer ${layerIndex}: starting [${layer.join(', ')}]`);
    const services = layer.map((name) => {
      const fixture = healthByName.get(name);
      const status = fixture === 'failing' ? 'failed' : 'healthy';
      log(`layer ${layerIndex}: ${name} -> ${status} (fixture=${fixture})`);
      return { name, status } as { name: string; status: 'healthy' | 'failed' };
    });
    layerResults.push({ layer: layerIndex, services });

    const failed = services.filter((s) => s.status === 'failed').map((s) => s.name);
    if (failed.length > 0) {
      const reason = `health check fixture reported failing for: ${failed.join(', ')}`;
      log(`layer ${layerIndex}: batch halted, reason: ${reason}`);
      for (let rest = layerIndex + 1; rest < layers.length; rest++) {
        layerResults.push({
          layer: rest,
          services: layers[rest].map((name) => ({ name, status: 'blocked' as const })),
        });
        log(`layer ${rest}: blocked because layer ${layerIndex} failed`);
      }
      return {
        status: 'failed',
        layers: layerResults,
        failure: { layer: layerIndex, services: failed.sort(), reason },
      };
    }
    log(`layer ${layerIndex}: all healthy, advancing to next layer`);
  }
  return { status: 'completed', layers: layerResults };
}
