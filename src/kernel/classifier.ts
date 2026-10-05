import { ServiceError } from '../contract/errors.ts';
import type { Classification, PassFailDistribution, RunOutcome } from '../contract/types.ts';

export interface ClassifyOptions {
  targetReliability: number; // e.g. 0.99
  maxRetries: number;
}

export interface ClassificationResult {
  classification: Classification;
  confidence: number;
  distribution: PassFailDistribution | null;
  firstFailureRun: number | null;
  suggestedRetries: number;
  reasoning: string;
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

// Confidence model (documented contract, verified by unit tests with
// hand-computed reference values):
//  - stable (all pass or all fail): confidence = 1 - 2^-N.
//    More runs => more confidence that the test is truly stable.
//  - flaky: confidence = (2 * min(passes, failures) / N) * (1 - 2^-N).
//    The balance term rewards observing both outcomes often; e.g. 1 failure
//    in 3 runs (0.5833) scores higher than 1 failure in 10 runs (0.1998).
// Suggested retries (flaky only): smallest k such that
//   1 - failRate^(k+1) >= targetReliability, capped at maxRetries.
export function classify(outcomes: RunOutcome[], opts: ClassifyOptions): ClassificationResult {
  const n = outcomes.length;
  if (n === 0) {
    throw new ServiceError('INPUT_ERROR', 'cannot classify zero runs');
  }
  const failures = outcomes.filter((o) => o === 'fail').length;
  const passes = n - failures;
  const sampleFactor = 1 - Math.pow(2, -n);

  if (failures === 0) {
    return {
      classification: 'stable_pass',
      confidence: round4(sampleFactor),
      distribution: null,
      firstFailureRun: null,
      suggestedRetries: 0,
      reasoning: `all ${n} run(s) passed; stable-pass confidence = 1 - 2^-${n} = ${round4(sampleFactor)}`,
    };
  }
  if (passes === 0) {
    return {
      classification: 'stable_fail',
      confidence: round4(sampleFactor),
      distribution: null,
      firstFailureRun: null,
      suggestedRetries: 0,
      reasoning: `all ${n} run(s) failed; stable-fail confidence = 1 - 2^-${n} = ${round4(sampleFactor)}; retrying will not help a consistently failing test`,
    };
  }

  const balance = (2 * Math.min(passes, failures)) / n;
  const confidence = round4(balance * sampleFactor);
  const firstFailureRun = outcomes.indexOf('fail') + 1;
  const failRate = failures / n;
  let retries = Math.ceil(Math.log(1 - opts.targetReliability) / Math.log(failRate)) - 1;
  if (!Number.isFinite(retries) || retries < 0) retries = 0;
  const suggestedRetries = Math.min(opts.maxRetries, retries);
  return {
    classification: 'flaky',
    confidence,
    distribution: { passes, failures },
    firstFailureRun,
    suggestedRetries,
    reasoning: `mixed outcomes: ${passes} pass / ${failures} fail in ${n} runs; first failure at run #${firstFailureRun}; failRate=${round4(failRate)}; confidence = (2*min/${n}) * (1 - 2^-${n}) = ${confidence}; need ${suggestedRetries} retries for ${opts.targetReliability} reliability (cap ${opts.maxRetries})`,
  };
}
