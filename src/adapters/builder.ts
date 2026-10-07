// Builder adapter: the external "build tool" is replaced by a local fixture.
// Behaviors are declared per target ('success' | 'fail'); a configurable delay
// simulates real build latency so mid-build change coalescing is observable.

export interface BuildRequest {
  name: string;
  watchPaths: string[];
  workspaceRoot: string;
}

export interface BuildResult {
  ok: boolean;
  error?: string;
}

export interface Builder {
  build(req: BuildRequest): Promise<BuildResult>;
}

export type FixtureBehavior = "success" | "fail";

export class FixtureBuilder implements Builder {
  /** target name -> behavior; missing entries default to 'success' */
  readonly behaviors = new Map<string, FixtureBehavior>();
  /** how many times each target was actually built (test/diagnostic hook) */
  readonly buildCounts = new Map<string, number>();

  private readonly delayMs: number;

  constructor(delayMs: number = 50) {
    this.delayMs = delayMs;
  }

  setBehavior(target: string, behavior: FixtureBehavior): void {
    this.behaviors.set(target, behavior);
  }

  buildCount(target: string): number {
    return this.buildCounts.get(target) ?? 0;
  }

  async build(req: BuildRequest): Promise<BuildResult> {
    this.buildCounts.set(req.name, (this.buildCounts.get(req.name) ?? 0) + 1);
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    const behavior = this.behaviors.get(req.name) ?? "success";
    if (behavior === "fail") {
      return { ok: false, error: "fixture build failed for target '" + req.name + "'" };
    }
    return { ok: true };
  }
}
