import type { TestOutcome } from './contract.ts';

export type Category = 'stable-pass' | 'stable-fail' | 'flaky';

export interface Classification {
  name: string;
  runs: number;
  passCount: number;
  failCount: number;
  category: Category;
  confidence: number;
  firstFailureRun: number | null;
  suggestedRetries: number;
  reason: string;
}

export interface ClassifyOptions {
  passTarget: number;
  maxSuggestedRetries: number;
}

export const DEFAULT_CLASSIFY_OPTIONS: ClassifyOptions = {
  passTarget: 0.99,
  maxSuggestedRetries: 10,
};

export function classify(
  name: string,
  outcomes: TestOutcome[],
  options: ClassifyOptions = DEFAULT_CLASSIFY_OPTIONS,
): Classification {
  const runs = outcomes.length;
  const failCount = outcomes.filter((o) => o === 'fail').length;
  const passCount = runs - failCount;
  const firstIdx = outcomes.indexOf('fail');
  const firstFailureRun = firstIdx === -1 ? null : firstIdx + 1;

  if (failCount === 0) {
    const confidence = round4(1 - Math.pow(0.5, runs));
    return {
      name, runs, passCount, failCount,
      category: 'stable-pass',
      confidence,
      firstFailureRun,
      suggestedRetries: 0,
      reason: runs + '/' + runs + ' runs passed; a 50%-flaky test would show this pattern with probability ' +
        '2^-' + runs + ', so stability confidence = 1 - 2^-' + runs + ' = ' + confidence,
    };
  }
  if (passCount === 0) {
    const confidence = round4(1 - Math.pow(0.5, runs));
    return {
      name, runs, passCount, failCount,
      category: 'stable-fail',
      confidence,
      firstFailureRun,
      suggestedRetries: 0,
      reason: runs + '/' + runs + ' runs failed; symmetric stability confidence = 1 - 2^-' + runs + ' = ' + confidence +
        '; retrying a consistently failing test is pointless, suggestedRetries = 0',
    };
  }

  const minority = Math.min(passCount, failCount);
  const confidence = round4((2 * minority) / runs);
  const failRate = failCount / runs;
  const retriesNeeded = Math.ceil(Math.log(1 - options.passTarget) / Math.log(failRate)) - 1;
  const suggestedRetries = Math.max(0, Math.min(options.maxSuggestedRetries, retriesNeeded));
  return {
    name, runs, passCount, failCount,
    category: 'flaky',
    confidence,
    firstFailureRun,
    suggestedRetries,
    reason: 'mixed outcomes: ' + passCount + ' pass / ' + failCount + ' fail in ' + runs + ' runs; ' +
      'flaky confidence = 2*min(pass,fail)/runs = 2*' + minority + '/' + runs + ' = ' + confidence + '; ' +
      'first failure at run #' + firstFailureRun + '; ' +
      'observed fail rate ' + round4(failRate) + ', need ' + suggestedRetries +
      ' retries for pass probability >= ' + options.passTarget,
  };
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
